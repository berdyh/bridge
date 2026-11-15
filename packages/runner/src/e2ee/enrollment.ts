import { randomBytes } from "node:crypto";

import { base64UrlDecode, base64UrlEncode, createSpake2, keyIdOf, type KeyPair, type Spake2Result, type Spake2Session } from "@berdyh/bridge-crypto";
import {
  ENROLL_CODE_TTL_MS,
  ENROLL_MAX_ATTEMPTS,
  HANDSHAKE_TIMEOUT_MS,
  generateUserCode,
  type HandshakeIO,
  type PakeConfirm,
  type PakeDone,
  type PakeMessage,
  type PakeStart,
} from "@berdyh/bridge-protocol";

import type { E2eeApp, EnrollmentWire, EnrollPrompt, EnrollResult, RunnerE2eeContext, TrustedBrowser } from "./contracts.js";
import {
  isProcessAlive,
  loadRunnerIdentity,
  mutateEnrollWindow,
  mutateTrustList,
  readEnrollWindow,
  statePath,
  waitForChange,
  type EnrollWindow,
} from "./store.js";

const encoder = new TextEncoder();
const POLL_MS = 100;
const DELIVERY_WAIT_MS = 3_000;

/** Why `enroll` ended without a trusted browser. */
export class EnrollError extends Error {
  constructor(
    readonly reason: "expired" | "locked" | "aborted" | "already_open" | "unconfirmed",
    message: string,
  ) {
    super(message);
    this.name = "EnrollError";
  }
}

/**
 * The AAD of the two sealed blobs. It binds them to this enrollment attempt, so a
 * blob lifted from another attempt, code or runner does not open. The SPAKE2 seal
 * adds the sender direction itself. (The client builds the same bytes.)
 */
export function enrollAad(enrollId: string, codeId: string, runnerId: string): Uint8Array {
  return encoder.encode(JSON.stringify(["bridge enroll v1", enrollId, codeId, runnerId]));
}

/**
 * The AAD of the proof sealed into an accepted `pake/done`. `pake/done` itself is not
 * authenticated, so a relay could forge `ok: true` over a refusal; only the runner holds
 * the SPAKE2 key that makes this proof, and it binds the enrolled key id.
 */
export function doneProofAad(enrollId: string, codeId: string, runnerId: string, browserKeyId: string): Uint8Array {
  return encoder.encode(JSON.stringify(["bridge enroll done v1", enrollId, codeId, runnerId, browserKeyId]));
}

/** The plaintext of the proof. */
export const DONE_PROOF_TEXT = "enrolled";

/** A label comes from the (untrusted) browser and goes to a terminal: no control, bidi or format characters. */
export function sanitizeLabel(label: string): string {
  const cleaned = label.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 64).trim();
  return cleaned.length > 0 ? cleaned : "Unnamed browser";
}

// --- shared bounded waits -------------------------------------------------------

function waitMessage<M extends PakeMessage>(io: HandshakeIO, match: (m: PakeMessage) => m is M, signal: AbortSignal): Promise<M | undefined> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(undefined);
    const off = io.onMessage((message) => {
      if (!match(message)) return;
      cleanup();
      resolve(message);
    });
    const onAbort = () => {
      cleanup();
      resolve(undefined);
    };
    const cleanup = () => {
      off();
      signal.removeEventListener("abort", onAbort);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// --- the daemon side ------------------------------------------------------------

type Reservation =
  | { ok: true; codeId: string; code: string; expiresAt: string; attemptsLeft: number }
  | { ok: false; reason: "no_enrollment_open" | "expired" | "locked"; expiresAt?: string };

/**
 * Charges one attempt and returns the code, atomically (under the file lock), before
 * the caller computes a reply. Every `pake/start` that gets this far costs one
 * attempt, including a repeated start with the same `enrollId`; nothing refunds it.
 */
async function reserveAttempt(app: E2eeApp, now: Date): Promise<Reservation> {
  return mutateEnrollWindow<Reservation>(app, (window) => {
    if (!window || window.consumed) return { result: { ok: false, reason: "no_enrollment_open" } };
    if (Date.parse(window.expiresAt) <= now.getTime()) return { result: { ok: false, reason: "expired", expiresAt: window.expiresAt } };
    if (window.state === "locked" || window.attemptsLeft <= 0) {
      return { window: window.state === "locked" ? undefined : { ...window, state: "locked" }, result: { ok: false, reason: "locked", expiresAt: window.expiresAt } };
    }
    const next = { ...window, attemptsLeft: window.attemptsLeft - 1 };
    return { window: next, result: { ok: true, codeId: window.codeId, code: window.code, expiresAt: window.expiresAt, attemptsLeft: next.attemptsLeft } };
  });
}

/** After a failed attempt: locks the code when its budget is used up. Returns the attempts left. */
async function settleFailure(app: E2eeApp, codeId: string): Promise<number> {
  return mutateEnrollWindow<number>(app, (window) => {
    if (!window || window.codeId !== codeId) return { result: 0 };
    const exhausted = window.attemptsLeft <= 0;
    return {
      window: exhausted && window.state !== "locked" ? { ...window, state: "locked" } : undefined,
      result: Math.max(0, window.attemptsLeft),
    };
  });
}

type PendingOutcome = { kind: "gone" | "expired" | "busy" } | { kind: "set" };

/** Records the browser's details for `bridge enroll` to confirm. */
async function setPending(app: E2eeApp, codeId: string, pending: NonNullable<EnrollWindow["pending"]>, now: Date): Promise<PendingOutcome> {
  return mutateEnrollWindow<PendingOutcome>(app, (window) => {
    if (!window || window.codeId !== codeId || window.consumed) return { result: { kind: "gone" } };
    if (Date.parse(window.expiresAt) <= now.getTime()) return { result: { kind: "expired" } };
    if (window.pending) return { result: { kind: "busy" } };
    return { window: { ...window, pending }, result: { kind: "set" } };
  });
}

type DecisionOutcome =
  | { kind: "decision"; accepted: true; enrolledAt: string; browser: NonNullable<EnrollWindow["pending"]>; prior: TrustedBrowser | undefined }
  | { kind: "decision"; accepted: false }
  /** The user said yes, but `pake/done` could no longer be sent: nothing was trusted. */
  | { kind: "undeliverable" }
  | { kind: "none"; expired: boolean }
  | { kind: "gone" };

/**
 * Adds the browser to the trust list and returns the entry it replaced (a re-enrollment),
 * in one locked step, so the entry that is put back on a rollback is the one this write
 * actually replaced.
 */
async function commitTrust(app: E2eeApp, browser: NonNullable<EnrollWindow["pending"]>, stamp: string): Promise<TrustedBrowser | undefined> {
  return mutateTrustList<TrustedBrowser | undefined>(app, (list) => {
    const prior = list.find((entry) => entry.browserKeyId === browser.keyId);
    const entry: TrustedBrowser = { browserKeyId: browser.keyId, publicKey: browser.publicKey, label: browser.label, enrolledAt: stamp, lastSeen: stamp };
    return { list: [...list.filter((other) => other.browserKeyId !== browser.keyId), entry], result: prior };
  });
}

/**
 * Takes back what `commitTrust` wrote: the previous entry returns (or the browser is
 * removed again), but only if the entry on disk is still the one this attempt wrote. If
 * it was revoked or replaced in the meantime, that later decision stands: a rollback
 * never resurrects a browser the user revoked.
 */
async function undoTrust(app: E2eeApp, browser: NonNullable<EnrollWindow["pending"]>, stamp: string, prior: TrustedBrowser | undefined): Promise<void> {
  await mutateTrustList<void>(app, (list) => {
    const current = list.find((entry) => entry.browserKeyId === browser.keyId);
    if (!current || current.enrolledAt !== stamp || current.publicKey !== browser.publicKey) return { result: undefined };
    const others = list.filter((entry) => entry.browserKeyId !== browser.keyId);
    return { list: prior ? [...others, prior] : others, result: undefined };
  });
}

/**
 * Adds the browser to the trust list, unless `pake/done` can no longer be sent. Checked
 * before the write and again after it; if the wire went away in between, the write is
 * undone (see `undoTrust`). Returns the replaced entry when the browser is trusted.
 */
async function trustIfDeliverable(
  app: E2eeApp,
  browser: NonNullable<EnrollWindow["pending"]>,
  stamp: string,
  canDeliver: () => boolean,
): Promise<{ prior: TrustedBrowser | undefined } | undefined> {
  if (!canDeliver()) return undefined;
  const prior = await commitTrust(app, browser, stamp);
  if (canDeliver()) return { prior };
  await undoTrust(app, browser, stamp, prior);
  return undefined;
}

/**
 * Looks for the decision on `attemptId`. An accepted one is committed here, by the
 * process that holds the `EnrollmentWire`: the browser is trusted and the code consumed
 * in one locked step, and only while `canDeliver()` says `pake/done` can still be sent.
 * Otherwise the request is withdrawn and nothing is trusted. With `finalize`, the pending
 * request is also withdrawn when there is no decision (timeout, closed wire), so a late
 * confirmation on the runner's terminal is discarded rather than trusted.
 */
async function takeDecision(app: E2eeApp, codeId: string, attemptId: string, now: Date, finalize: boolean, canDeliver: () => boolean): Promise<DecisionOutcome> {
  // Set once the trust entry is written; if persisting the window then fails, the entry is
  // taken back below, because nothing would record that it is there to be rolled back.
  let committed: { browser: NonNullable<EnrollWindow["pending"]>; stamp: string; prior: TrustedBrowser | undefined } | undefined;
  try {
    return await takeDecisionLocked(app, codeId, attemptId, now, finalize, canDeliver, (c) => void (committed = c));
  } catch (error) {
    if (committed) await undoTrust(app, committed.browser, committed.stamp, committed.prior).catch(() => undefined);
    throw error;
  }
}

async function takeDecisionLocked(
  app: E2eeApp,
  codeId: string,
  attemptId: string,
  now: Date,
  finalize: boolean,
  canDeliver: () => boolean,
  onCommit: (c: { browser: NonNullable<EnrollWindow["pending"]>; stamp: string; prior: TrustedBrowser | undefined }) => void,
): Promise<DecisionOutcome> {
  return mutateEnrollWindow<DecisionOutcome>(app, async (window) => {
    if (!window || window.codeId !== codeId) return { result: { kind: "gone" } };
    const expired = Date.parse(window.expiresAt) <= now.getTime();
    const withdrawn = (): EnrollWindow => (({ pending: _pending, decision: _decision, ...rest }) => rest)(window) as EnrollWindow;
    if (window.decision?.attemptId === attemptId) {
      if (!window.decision.accepted) return { window: withdrawn(), result: { kind: "decision", accepted: false } };
      const pending = window.pending;
      if (expired) return { window: withdrawn(), result: { kind: "none", expired: true } };
      const stamp = now.toISOString();
      if (window.consumed || !pending || pending.attemptId !== attemptId || finalize) return { window: withdrawn(), result: { kind: "undeliverable" } };
      const trusted = await trustIfDeliverable(app, pending, stamp, canDeliver);
      if (!trusted) return { window: withdrawn(), result: { kind: "undeliverable" } };
      onCommit({ browser: pending, stamp, prior: trusted.prior });
      // Trusted and consumed, not yet `delivered`: that is set once pake/done has been sent.
      return {
        window: { ...window, consumed: true, decision: { ...window.decision, enrolledAt: stamp } },
        result: { kind: "decision", accepted: true, enrolledAt: stamp, browser: pending, prior: trusted.prior },
      };
    }
    if (finalize || expired) {
      const { pending, ...rest } = window;
      return { window: pending?.attemptId === attemptId ? (rest as EnrollWindow) : undefined, result: { kind: "none", expired } };
    }
    // Someone withdrew the request (for example `bridge enroll` gave up waiting for us).
    if (window.pending?.attemptId !== attemptId) return { result: { kind: "gone" } };
    return { result: { kind: "none", expired: false } };
  });
}

/** `pake/done` went out: lets `bridge enroll` report success. */
async function markDelivered(app: E2eeApp, codeId: string, attemptId: string): Promise<void> {
  await mutateEnrollWindow<void>(app, (window) => {
    if (!window || window.codeId !== codeId || window.decision?.attemptId !== attemptId) return { result: undefined };
    return { window: { ...window, decision: { ...window.decision, delivered: true } }, result: undefined };
  });
}

/**
 * The browser was trusted but `pake/done` could not be sent (the wire went away after
 * the commit). The trust entry is taken back (see `undoTrust`) and the code is usable
 * again, as if the yes had never been given.
 */
async function revertCommit(
  app: E2eeApp,
  codeId: string,
  attemptId: string,
  browser: NonNullable<EnrollWindow["pending"]>,
  stamp: string,
  prior: TrustedBrowser | undefined,
): Promise<void> {
  await undoTrust(app, browser, stamp, prior);
  await mutateEnrollWindow<void>(app, (window) => {
    if (!window || window.codeId !== codeId || window.decision?.attemptId !== attemptId) return { result: undefined };
    const { pending: _pending, decision: _decision, consumed: _consumed, ...rest } = window;
    return { window: rest as EnrollWindow, result: undefined };
  });
}

/** See `acceptEnrollment` in `./index.ts`. */
export async function acceptEnrollmentImpl(wire: EnrollmentWire, start: PakeStart, ctx: RunnerE2eeContext): Promise<void> {
  const { app } = ctx;
  const now = ctx.now ?? (() => new Date());
  const enrollId = start.enrollId;
  let finished = false;
  let codeId: string | undefined;
  let expiresAt: string | undefined;
  const send = (fields: Omit<PakeDone, "t" | "v" | "enrollId">): void => {
    if (finished) return;
    finished = true;
    if (!wire.closed) wire.handshake.send({ t: "pake/done", v: 1, enrollId, ...fields });
    wire.close(fields.reason ?? "enrolled");
  };
  const deny = (reason: NonNullable<PakeDone["reason"]>, extra: Partial<PakeDone> = {}): void =>
    send({ ok: false, reason, ...(codeId ? { codeId } : {}), ...(expiresAt ? { expiresAt } : {}), ...extra });
  /** A reply was sent (the attempt is charged): every failure from here on settles the budget. */
  const fail = async (reason: NonNullable<PakeDone["reason"]>): Promise<void> => {
    const attemptsLeft = codeId ? await settleFailure(app, codeId).catch(() => 0) : 0;
    deny(reason, { attemptsLeft });
  };

  const ac = new AbortController();
  let timedOut = false;
  // Two waits: the exchange up to the browser's details is bounded by the session
  // handshake timeout; the local user's answer by the life of the code (`armUserWait`).
  let timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, HANDSHAKE_TIMEOUT_MS);
  const armUserWait = (expires: string): void => {
    clearTimeout(timer);
    const left = Math.min(ENROLL_CODE_TTL_MS, Math.max(0, Date.parse(expires) - now().getTime()));
    timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, left);
  };
  const offClose = wire.onClose(() => ac.abort());
  let spake: Spake2Session | undefined;
  let result: Spake2Result | undefined;
  let identity: KeyPair | undefined;
  let attemptId: string | undefined;
  try {
    if (!ctx.e2ee || !(await readEnrollWindow(app))) return deny("no_enrollment_open");

    let peerMessage: Uint8Array;
    try {
      peerMessage = base64UrlDecode(start.msg);
      if (peerMessage.length !== 32) throw new Error("length");
    } catch {
      return deny("protocol_error");
    }

    const reservation = await reserveAttempt(app, now());
    if (!reservation.ok) return deny(reservation.reason, reservation.expiresAt ? { expiresAt: reservation.expiresAt } : {});
    ({ codeId, expiresAt } = reservation);

    identity = await loadRunnerIdentity(app);
    spake = createSpake2({ role: "runner", password: reservation.code, idA: encoder.encode(enrollId), idB: encoder.encode(app.runnerId) });
    try {
      result = spake.finish(peerMessage);
    } catch {
      return await fail("protocol_error");
    }
    const aad = enrollAad(enrollId, codeId, app.runnerId);
    const confirmation = waitMessage(wire.handshake, (m): m is PakeConfirm => m.t === "pake/confirm" && m.enrollId === enrollId, ac.signal);
    wire.handshake.send({
      t: "pake/reply",
      v: 1,
      enrollId,
      codeId,
      msg: base64UrlEncode(spake.message),
      mac: base64UrlEncode(result.confirmation),
      sealed: await result.seal(identity.publicKey, aad),
    });

    const confirm = await confirmation;
    if (!confirm) return wire.closed ? undefined : await fail("protocol_error");
    if (confirm.codeId !== codeId) return await fail("protocol_error");
    let macOk = false;
    try {
      macOk = result.verifyPeerConfirmation(base64UrlDecode(confirm.mac));
    } catch {
      macOk = false;
    }
    if (!macOk) return await fail("bad_code");

    let browser: { publicKey: string; label: string; keyId: string };
    try {
      const opened = await result.open(confirm.sealed, aad);
      const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(opened)) as { publicKey?: unknown; label?: unknown };
      if (typeof parsed.publicKey !== "string" || typeof parsed.label !== "string") throw new Error("shape");
      const publicKey = base64UrlDecode(parsed.publicKey);
      if (publicKey.length !== 32) throw new Error("length");
      // A low-order or otherwise unusable key is refused before anyone is asked to trust it.
      (await identity.agree(publicKey)).fill(0);
      browser = { publicKey: parsed.publicKey, label: sanitizeLabel(parsed.label), keyId: await keyIdOf(publicKey) };
    } catch {
      return await fail("protocol_error");
    }

    attemptId = randomBytes(16).toString("hex");
    const pending = await setPending(app, codeId, { attemptId, enrollId, ...browser }, now());
    if (pending.kind !== "set") {
      attemptId = undefined;
      return pending.kind === "expired" ? deny("expired") : pending.kind === "busy" ? await fail("protocol_error") : deny("no_enrollment_open");
    }

    // Sealed before anyone can say yes: once the browser is trusted nothing may be left
    // that awaits before `pake/done` is sent, or a closing wire would strand the trust entry.
    const proof = await result.seal(encoder.encode(DONE_PROOF_TEXT), doneProofAad(enrollId, codeId, app.runnerId, browser.keyId));

    // From here the wait is for a person at a terminal, not for the network.
    armUserWait(expiresAt);
    const canDeliver = (): boolean => !wire.closed && !finished && !ac.signal.aborted;
    const file = statePath(app, "enroll");
    for (;;) {
      // `finalizing` is sampled before the call: an abort that lands during it needs one more
      // round, because only a finalizing call withdraws the pending request.
      const finalizing = ac.signal.aborted;
      const attemptIdOf = attemptId;
      const outcome = await takeDecision(app, codeId, attemptIdOf, now(), finalizing, canDeliver);
      if (outcome.kind === "decision") {
        attemptId = undefined;
        if (outcome.accepted) {
          // The browser is trusted already (`takeDecision` did it while the wire was open). The
          // wire may have closed since; then the trust is taken back instead of left orphaned.
          const revert = (): Promise<void> => revertCommit(app, codeId!, attemptIdOf, outcome.browser, outcome.enrolledAt, outcome.prior);
          if (wire.closed || finished) return await revert();
          try {
            send({ ok: true, codeId, expiresAt, browserKeyId: browser.keyId, proof });
          } catch (error) {
            await revert().catch(() => undefined);
            throw error;
          }
          await markDelivered(app, codeId, attemptIdOf).catch(() => undefined);
          return;
        }
        return await fail("rejected_by_user");
      }
      if (outcome.kind === "undeliverable") {
        attemptId = undefined;
        return wire.closed && !timedOut ? undefined : await fail("protocol_error");
      }
      if (outcome.kind === "gone") {
        attemptId = undefined;
        return deny("no_enrollment_open");
      }
      if (outcome.expired) {
        attemptId = undefined;
        return deny("expired");
      }
      if (ac.signal.aborted && !finalizing) continue;
      if (finalizing) {
        attemptId = undefined;
        return wire.closed && !timedOut ? undefined : await fail("protocol_error");
      }
      await waitForChange(file, POLL_MS, ac.signal);
    }
  } catch {
    // This runs on a network message: never throw out of it.
    if (!finished && !wire.closed) {
      if (codeId) await fail("protocol_error");
      else deny("protocol_error");
    }
  } finally {
    clearTimeout(timer);
    offClose();
    if (attemptId !== undefined && codeId !== undefined) await takeDecision(app, codeId, attemptId, now(), true, () => false).catch(() => undefined);
    result?.destroy();
    spake?.destroy();
    identity?.destroy();
    if (!finished) wire.close("enrollment ended");
  }
}

// --- the `bridge enroll` side ---------------------------------------------------

export interface EnrollOptions {
  /** Test seams. */
  now?: () => Date;
  random?: (n: number) => Uint8Array;
  /** How often the window file is re-read for changes made by another process. */
  pollMs?: number;
  /** Ends the wait (for example on Ctrl-C); the window is closed and `enroll` rejects. */
  signal?: AbortSignal;
}

/**
 * Rejects with `aborted` as soon as `signal` fires, or with `expired` once `deadlineMs`
 * have passed, without waiting for `promise`. A prompt that nobody answers must not
 * outlive the code. `onEnd` runs when the wait is over either way (it tells the prompt).
 */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined, deadlineMs: number, onEnd: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      settle();
      onEnd();
      reject(new EnrollError("aborted", "enrollment cancelled"));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      settle();
      onEnd();
      reject(new EnrollError("expired", "the enrollment code expired while waiting for your answer"));
    }, Math.max(0, deadlineMs));
    promise.then(
      (value) => {
        settle();
        resolve(value);
      },
      (error: unknown) => {
        settle();
        reject(error);
      },
    );
  });
}

/** See `enroll` in `./index.ts`. */
export async function enrollImpl(app: E2eeApp, prompt: EnrollPrompt, options: EnrollOptions = {}): Promise<EnrollResult> {
  const now = options.now ?? (() => new Date());
  const pollMs = options.pollMs ?? POLL_MS;
  const random = options.random ?? ((n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n)));
  const { signal } = options;
  const code = generateUserCode(random);
  const codeId = base64UrlEncode(random(16));
  const expiresAt = new Date(now().getTime() + ENROLL_CODE_TTL_MS).toISOString();
  const file = statePath(app, "enroll");

  await mutateEnrollWindow<void>(app, (existing) => {
    const live =
      existing !== undefined && !existing.consumed && existing.state === "open" &&
      Date.parse(existing.expiresAt) > now().getTime() && isProcessAlive(existing.ownerPid);
    if (live) throw new EnrollError("already_open", "an enrollment for this app is already open");
    const window: EnrollWindow = { v: 1, codeId, code, expiresAt, attemptsLeft: ENROLL_MAX_ATTEMPTS, state: "open", ownerPid: process.pid };
    return { window, result: undefined };
  });

  const handled = new Set<string>();
  try {
    prompt.showCode(code, expiresAt);
    for (;;) {
      if (signal?.aborted) throw new EnrollError("aborted", "enrollment cancelled");
      const window = await readEnrollWindow(app);
      if (!window || window.codeId !== codeId) throw new EnrollError("aborted", "the enrollment window was closed");
      if (Date.parse(window.expiresAt) <= now().getTime()) throw new EnrollError("expired", "the enrollment code expired");
      if (window.state === "locked") throw new EnrollError("locked", "too many wrong codes; start a new enrollment");

      const pending = window.pending;
      if (pending && window.decision?.attemptId === pending.attemptId && !handled.has(pending.attemptId)) {
        // Answered from another process (`bridge enroll approve`) before this loop looked: no prompt is
        // needed. An accepted answer is followed through to delivery exactly as one recorded below.
        handled.add(pending.attemptId);
        if (window.decision.accepted) {
          const enrolledAt = await awaitDelivery(app, codeId, pending.attemptId, signal);
          if (enrolledAt) return { browserKeyId: pending.keyId, label: pending.label, enrolledAt };
        }
        continue;
      }
      if (pending && !window.decision && !handled.has(pending.attemptId)) {
        handled.add(pending.attemptId);
        // A cancelled enrollment never trusts anyone, even if the prompt is answered later.
        // ... and an unanswered prompt ends with the code, whatever the prompt does.
        const asking = new AbortController();
        const accepted = await abortable(
          prompt.confirm({ label: pending.label, keyId: pending.keyId }, { signal: asking.signal }),
          signal,
          Date.parse(window.expiresAt) - now().getTime(),
          () => asking.abort(),
        );
        const recorded = await recordDecision(app, codeId, pending.attemptId, accepted, now(), signal);
        if (recorded && accepted) {
          // The daemon trusts the browser (and consumes the code) only if it can still tell
          // the browser; if it could not, the request is withdrawn and we wait for another.
          const enrolledAt = await awaitDelivery(app, codeId, pending.attemptId, signal);
          if (enrolledAt) return { browserKeyId: pending.keyId, label: pending.label, enrolledAt };
        }
        continue;
      }
      await waitForChange(file, Math.min(pollMs, Math.max(1, Date.parse(window.expiresAt) - now().getTime())), signal);
    }
  } finally {
    // A locked window stays until it expires, so a browser that tries again is told `locked`.
    await mutateEnrollWindow<void>(app, (window) =>
      window?.codeId === codeId && window.state !== "locked" ? { window: null, result: undefined } : { result: undefined },
    ).catch(() => undefined);
  }
}

/**
 * Records the user's answer if that attempt is still the pending one (the daemon may
 * have timed it out). It does not trust anyone: the daemon, which holds the wire, does
 * that when it reads an accepted answer and can still send `pake/done`. Exported so the
 * non-TTY confirm and `bridge enroll approve` can answer from another process. An identical
 * existing decision (same attempt, same answer) counts as recorded; a different one is refused.
 */
export async function recordDecision(app: E2eeApp, codeId: string, attemptId: string, accepted: boolean, now: Date, signal?: AbortSignal): Promise<boolean> {
  return mutateEnrollWindow<boolean>(app, (window) => {
    // Re-checked under the lock: an abort that landed while waiting for it still wins.
    if (signal?.aborted) return { result: false };
    // The same answer to the same attempt is already recorded (by `bridge enroll approve`, or by the
    // non-TTY confirm that read it from the window): idempotent, even after the daemon consumed the
    // code. A different answer never overwrites it.
    if (window?.codeId === codeId && window.decision?.attemptId === attemptId && window.decision.accepted === accepted) return { result: true };
    if (!window || window.codeId !== codeId || window.consumed || window.decision) return { result: false };
    const pending = window.pending;
    if (!pending || pending.attemptId !== attemptId || Date.parse(window.expiresAt) <= now.getTime()) return { result: false };
    return { window: { ...window, decision: { attemptId, accepted } }, result: true };
  });
}

/**
 * Waits for the daemon to commit an accepted answer and send `pake/done`. Returns the
 * enrollment time, or undefined when the browser was not trusted: the daemon withdrew the
 * request (its wire was gone, even after the commit), or it did not answer in
 * `DELIVERY_WAIT_MS` (then the answer is withdrawn here, under the lock, so a late daemon
 * cannot commit it).
 */
async function awaitDelivery(app: E2eeApp, codeId: string, attemptId: string, signal?: AbortSignal): Promise<string | undefined> {
  const file = statePath(app, "enroll");
  const until = Date.now() + DELIVERY_WAIT_MS;
  while (Date.now() < until && !signal?.aborted) {
    const window = await readEnrollWindow(app);
    if (!window || window.codeId !== codeId || window.decision?.attemptId !== attemptId) return undefined;
    if (window.decision.delivered && window.decision.enrolledAt) return window.decision.enrolledAt;
    await waitForChange(file, 25, signal);
  }
  return mutateEnrollWindow<string | undefined>(app, (window) => {
    if (!window || window.codeId !== codeId || window.decision?.attemptId !== attemptId) return { result: undefined };
    if (window.decision.delivered) return { result: window.decision.enrolledAt };
    // Committed (trusted, code consumed) but `pake/done` is not confirmed sent. That is not
    // a success: the daemon takes the trust back if the wire is gone, or the process died
    // and the entry stays listed (revocable). The outcome is unknown, so it is reported so.
    if (window.consumed) throw new EnrollError("unconfirmed", "the browser was accepted but the runner did not confirm it told the browser; check the trusted browsers list");
    const { pending: _pending, decision: _decision, ...rest } = window;
    return { window: rest as EnrollWindow, result: undefined };
  });
}
