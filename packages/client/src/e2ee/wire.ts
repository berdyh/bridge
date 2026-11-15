/**
 * Enrollment wire details that `bridge-protocol` does not define, written once here
 * and mirrored byte for byte in `packages/runner/src/e2ee/enrollment.ts`
 * (`enrollAad`). Change both together.
 *
 *  - SPAKE2 identities: `idA = utf8(enrollId)` (the browser), `idB = utf8(runnerId)`.
 *  - AAD of both sealed blobs: `JSON.stringify(["bridge enroll v1", enrollId, codeId, runnerId])`.
 *    The SPAKE2 seal adds the sender direction itself.
 *  - The runner's sealed blob (`pake/reply.sealed`) is its raw 32-byte X25519 public key.
 *  - The browser's (`pake/confirm.sealed`) is UTF-8 JSON `{ publicKey: base64url, label }`.
 */
const encoder = new TextEncoder();

export const utf8 = (text: string): Uint8Array => encoder.encode(text);

export function enrollAad(enrollId: string, codeId: string, runnerId: string): Uint8Array {
  return utf8(JSON.stringify(["bridge enroll v1", enrollId, codeId, runnerId]));
}

/**
 * `pake/done` is not authenticated by the protocol, so an accepted one also carries
 * `proof` (`PakeDone.proof` in bridge-protocol): the runner seals `"enrolled"` under the SPAKE2 key with this AAD,
 * which binds the enrolled key id. A relay cannot make it, so it cannot turn a refusal
 * into a success. Mirrors `doneProofAad` in the runner's `enrollment.ts`.
 */
export function doneProofAad(enrollId: string, codeId: string, runnerId: string, browserKeyId: string): Uint8Array {
  return utf8(JSON.stringify(["bridge enroll done v1", enrollId, codeId, runnerId, browserKeyId]));
}
export const DONE_PROOF_TEXT = "enrolled";

/** Key-store names, inside the client's per-origin, per-app scope. One key per app; one public key per runner. */
export const KEY_NAME = "__bridge/key";
export const runnerKeyName = (runnerId: string): string => `__bridge/runner/${runnerId}`;

/** Why `enroll` failed. `reason` is a `PakeDoneReason` from the runner, or a local one. */
export class EnrollError extends Error {
  constructor(
    readonly reason: string,
    readonly attemptsLeft?: number,
  ) {
    super(`enrollment failed: ${reason}`);
    this.name = "EnrollError";
  }
}
