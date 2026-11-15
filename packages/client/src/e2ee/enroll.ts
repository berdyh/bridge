import { base64UrlDecode, base64UrlEncode, createSpake2, generateKeyPair, loadKeyPair, type KeyPair, type Spake2Result, type StoredKeyPair } from "@berdyh/bridge-crypto";
import {
  ENROLL_CODE_TTL_MS,
  HANDSHAKE_TIMEOUT_MS,
  isEnrolledAs,
  isValidUserCode,
  normalizeUserCode,
  type PakeConfirm,
  type PakeDone,
  type PakeMessage,
  type PakeReply,
} from "@berdyh/bridge-protocol";
import type { ClientE2eeContext, EnrolledRunner } from "../contracts.js";
import { DONE_PROOF_TEXT, doneProofAad, enrollAad, EnrollError, KEY_NAME, runnerKeyName, utf8 } from "./wire.js";

/**
 * SPAKE2 enrollment with the code the runner shows. See `BridgeClient.enroll` for
 * the identity rules.
 *
 * One long-term browser key per app, kept across enrollments.
 * The relay routes a browser by one `browserKeyId`, so a second runner's enrollment
 * must keep it, or the first runner's trust entry would be orphaned. So an existing
 * key is reused (and the socket id, which already is that key's id, is then also the
 * `enrollId`); a new key is generated only for the first enrollment, and never
 * replaced by a later one. Each runner still gets its own trust entry, its own SPAKE2
 * run and its own stored runner public key (`runnerKeyName`). The key is stored only
 * after a runner confirmed it, and the transport is rebound when the id changed.
 *
 * Two waits: the runner's `pake/reply` must arrive within `HANDSHAKE_TIMEOUT_MS`, but
 * the runner's `pake/done` waits for the person at the runner's terminal to confirm,
 * so that wait is bounded by the life of the code (`ENROLL_CODE_TTL_MS`) instead.
 */
export async function enroll(code: string, ctx: ClientE2eeContext): Promise<EnrolledRunner> {
  if (!isValidUserCode(code)) throw new EnrollError("invalid_code_format");
  // One enrollment at a time per key store (and per origin, across tabs where the browser
  // has Web Locks). The long-term key is chosen inside this section, so two first
  // enrollments cannot each generate a key and overwrite the other's, which would leave
  // one runner trusting a key this browser no longer has.
  return exclusive(ctx.keyStore, () => enrollOnce(code, ctx));
}

const queues = new WeakMap<object, Promise<unknown>>();

async function exclusive<T>(store: object, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(store) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => withWebLock(fn));
  queues.set(store, run);
  try {
    return await run;
  } finally {
    if (queues.get(store) === run) queues.delete(store);
  }
}

function withWebLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis as { navigator?: { locks?: { request<R>(name: string, callback: () => Promise<R>): Promise<R> } } }).navigator?.locks;
  return locks ? locks.request("bridge-enroll", fn) : fn();
}

async function enrollOnce(code: string, ctx: ClientE2eeContext): Promise<EnrolledRunner> {
  const password = normalizeUserCode(code);
  const { runnerId } = ctx;
  const enrollId = ctx.browserKeyId;
  const io = ctx.handshakeFor(runnerId);

  let stored = await ctx.keyStore.load(KEY_NAME);
  let keyPair: KeyPair;
  try {
    if (stored === undefined) {
      // The candidate key is saved BEFORE the runner is asked to trust it, so a failed or
      // unauthenticated completion cannot leave the runner trusting a key this browser
      // dropped: a retry finds it stored and presents the same one. A write failure
      // surfaces here, before anything is sent. Compare-and-set: if a key appeared since
      // the load, it wins and ours is discarded.
      const candidate = await generateKeyPair();
      try {
        const raced = await ctx.keyStore.load(KEY_NAME);
        if (raced !== undefined) {
          candidate.destroy();
          stored = raced;
        } else {
          await ctx.keyStore.save(KEY_NAME, await candidate.toStored());
          stored = await ctx.keyStore.load(KEY_NAME);
          candidate.destroy();
          if (stored === undefined) throw new Error("not persisted");
        }
      } catch (error) {
        candidate.destroy();
        throw error;
      }
    }
    keyPair = await loadKeyPair(stored as StoredKeyPair);
  } catch {
    throw new EnrollError("unreadable_key");
  }

  const spake = createSpake2({ role: "browser", password, idA: utf8(enrollId), idB: utf8(runnerId) });
  const inbox: PakeMessage[] = [];
  let wake: (() => void) | undefined;
  const off = io.onMessage((message) => {
    if ("enrollId" in message && message.enrollId === enrollId) {
      inbox.push(message);
      wake?.();
    }
  });
  const next = <T extends PakeMessage["t"]>(timeoutMs: number, ...types: T[]): Promise<Extract<PakeMessage, { t: T }>> =>
    new Promise((resolve, reject) => {
      const check = (): boolean => {
        const index = inbox.findIndex((m) => (types as string[]).includes(m.t));
        if (index < 0) return false;
        clearTimeout(timer);
        wake = undefined;
        resolve(inbox.splice(index, 1)[0] as Extract<PakeMessage, { t: T }>);
        return true;
      };
      const timer = setTimeout(() => {
        wake = undefined;
        reject(new EnrollError("timeout"));
      }, timeoutMs);
      if (!check()) wake = check;
    });
  const failFrom = (done: PakeDone, local?: string): EnrollError => new EnrollError(done.reason ?? local ?? "protocol_error", done.attemptsLeft);

  let result: ReturnType<typeof spake.finish> | undefined;
  try {
    ctx.onBrowserKey?.(keyPair.id);
    io.send({ t: "pake/start", v: 1, enrollId, msg: base64UrlEncode(spake.message) });
    const first: PakeReply | PakeDone = await next(HANDSHAKE_TIMEOUT_MS, "pake/reply", "pake/done");
    if (first.t === "pake/done") throw failFrom(first);

    result = spake.finish(base64UrlDecode(first.msg));
    const aad = enrollAad(enrollId, first.codeId, runnerId);
    // Everything we will send is computed before the runner's MAC is checked, because a
    // failed check destroys the result. A wrong code is detectable here, but we still
    // send the confirmation: the attempt was charged at `pake/reply`, and the runner's
    // `pake/done` tells us the attempts left and closes its side at once.
    const mac = result.confirmation;
    const sealed = await result.seal(utf8(JSON.stringify({ publicKey: base64UrlEncode(keyPair.publicKey), label: ctx.label ?? "Unnamed browser" })), aad);
    let runnerKey: Uint8Array | undefined;
    if (result.verifyPeerConfirmation(base64UrlDecode(first.mac))) {
      runnerKey = await result.open(first.sealed, aad);
      if (runnerKey.length !== 32) throw new EnrollError("protocol_error");
    }
    const confirm: PakeConfirm = { t: "pake/confirm", v: 1, enrollId, codeId: first.codeId, mac: base64UrlEncode(mac), sealed };
    io.send(confirm);

    // The runner asks its user before it answers: wait as long as the code lives.
    const done = await next(ENROLL_CODE_TTL_MS, "pake/done");
    if (!runnerKey) throw failFrom(done, "bad_code");
    if (!done.ok) throw failFrom(done);
    if (!isEnrolledAs(done, keyPair.id) || done.browserKeyId === undefined) throw new EnrollError("identity_mismatch");
    // Success counts only with the runner's proof: the relay can forge a plain `ok: true`.
    if (!(await doneProofHolds(result, done, first.codeId, enrollId, runnerId, keyPair.id))) throw new EnrollError("unauthenticated_done");

    // Compare-and-set: another context may have replaced the stored key while we waited for the
    // runner's user. The runner now trusts ours, so the stored one must still be it.
    const current = await ctx.keyStore.load(KEY_NAME);
    let same = false;
    try {
      const other = current === undefined ? undefined : await loadKeyPair(current as StoredKeyPair);
      same = other?.id === keyPair.id;
      other?.destroy();
    } catch {
      same = false;
    }
    if (!same) throw new EnrollError("key_changed");
    await ctx.keyStore.save(runnerKeyName(runnerId), base64UrlEncode(runnerKey));
    if (ctx.browserKeyId !== done.browserKeyId) await ctx.rebind(done.browserKeyId);
    return { runnerId, browserKeyId: done.browserKeyId, enrolledAt: (ctx.now ?? (() => new Date()))().toISOString() };
  } catch (error) {
    if (error instanceof EnrollError) throw error;
    throw new EnrollError("protocol_error");
  } finally {
    off();
    wake = undefined;
    result?.destroy();
    spake.destroy();
    keyPair.destroy();
  }
}

async function doneProofHolds(
  result: Spake2Result,
  done: PakeDone,
  codeId: string,
  enrollId: string,
  runnerId: string,
  browserKeyId: string,
): Promise<boolean> {
  const { proof } = done;
  if (!proof) return false;
  if (done.codeId !== undefined && done.codeId !== codeId) return false;
  try {
    const opened = await result.open(proof, doneProofAad(enrollId, codeId, runnerId, browserKeyId));
    return new TextDecoder().decode(opened) === DONE_PROOF_TEXT;
  } catch {
    return false;
  }
}
