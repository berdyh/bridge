# Crypto implementation notes

The public API is `contracts.ts` and `index.ts`. Implementation helpers
live in `internal.ts`, `spake2-internal.ts`, and `channel-internal.ts`; none is
exported by the package barrel. Production uses standard browser APIs and noble,
with no Node imports, home directories, keychain calls, or persistence side effects.

## Algorithms and encodings

| Operation | Exact composition |
| --- | --- |
| Enrollment group | RFC 9382 edwards25519, compressed RFC 8032 points, standard generator, cofactor 8, published M/N. Browser is A/M; runner is B/N. Strict canonical decoding, curve membership, small-order rejection and cofactor clearing before secret multiplication. |
| Code to scalar | `normalizeUserCode` and `isValidUserCode` from bridge-protocol; UTF-8; noble scrypt with `N=16384, r=8, p=1, dkLen=40`, fixed UTF-8 salt `bridge spake2 password v1`; interpret the 40 bytes as unsigned big-endian and reduce modulo the edwards25519 prime subgroup order. |
| Ephemeral PAKE scalar | CSPRNG rejection sampling of nonzero scalars below the subgroup order, using `crypto.getRandomValues`. Scalar multiplication uses noble's secret-safe `multiply`, never `multiplyUnsafe`. |
| PAKE transcript | `len(A), A, len(B), B, len(pA), pA, len(pB), pB, len(K), K, len(w), w`; lengths are uint64 little-endian; `w` is fixed-width 32-byte big-endian; `K` includes the cofactor. |
| Confirmation | SHA-256 of transcript splits into 16-byte `Ke` and `Ka`. HKDF-SHA256 of `Ka`, empty salt, UTF-8 info `ConfirmationKeys`, length 32, splits into 16-byte `KcA` and `KcB`. Each produces HMAC-SHA256 over the entire transcript. Verification examines all 32 expected bytes, including wrong-length inputs. |
| PAKE sealed keys | Nonextractable AES-128-GCM under RFC `Ke`, 128-bit tag, random 12-byte nonce. AAD is the same uint64-LE length-prefixed encoding of UTF-8 `bridge spake2 seal v1`, UTF-8 direction (`b2r` or `r2b`), and caller-provided AAD. This sender binding prevents ciphertext reflection. |
| Long-term/ephemeral key | WebCrypto X25519 private `CryptoKey`, nonextractable and usable only for `deriveBits`. Only the public raw 32-byte key is exported. Fall back only for `NotSupportedError`, including errors from another realm. |
| Fallback at rest | Noble X25519 secret encrypted with nonextractable WebCrypto AES-256-GCM, 128-bit tag, random 12-byte IV, UTF-8 AAD `bridge x25519 wrap v1`. Restored keys must match their recorded public bytes. |
| Node identity at rest | Explicit `generateRawKeyPair()` returns a raw `StoredKeyPair`, generating the 32-byte X25519 secret with `crypto.getRandomValues` and deriving its public key inside this package with noble. `loadKeyPair(raw)` validates the public/secret match and retains raw storage; `toStored()` returns defensive copies. The Node caller encrypts these bytes at rest (file mode 0600). Never use raw storage in browsers. |
| Browser key ID | Unpadded base64url of the first 16 bytes of SHA-256 of the raw public key. |
| Channel input | Four 32-byte X25519 secrets, ordered static/static, ephemeral/ephemeral, browser-static/runner-ephemeral, browser-ephemeral/runner-static. Both roles therefore use the same order. Reject low-order peers and zero shared secrets. |
| Channel HKDF | WebCrypto HKDF-SHA256, 32 zero salt bytes (equivalent to empty HKDF salt), info = UTF-8 `bridge channel v1` followed by all four raw 32-byte public keys sorted lexicographically by unsigned byte value. Output 64 bytes: first 32 for `b2r`, next 32 for `r2b`. Import both as nonextractable AES-256-GCM keys. |
| Session `kid` | Unpadded base64url of the first 16 bytes of SHA-256 of the channel info above. |
| Frames | AES-256-GCM, 128-bit tag, fresh 12-byte nonce from `crypto.getRandomValues`, UTF-8 JSON-RPC plaintext. AAD = UTF-8 `JSON.stringify([1, kid, seq, direction])`. Direction is fixed locally by role and is implicit on the wire. All binary wire fields are canonical unpadded base64url. |

Sealing a PAKE reply before confirmation is required by the enrollment flow.
Opening requires successful peer confirmation. A failed confirmation destroys the
PAKE result. The PAKE session is single use; calling its `destroy()` also destroys
its result. **The runner owns the wrong-code attempt counter**: five attempts,
ten-minute expiry, and single-use code consumption belong to enrollment policy,
not this primitive. **An attempt is consumed when the runner sends `pake/reply`,
per `finish()` against a `pake/start`, not when `pake/confirm` fails.** Reserve the
attempt atomically against the code's shared five-attempt budget before computing
and sending the reply, and refuse further replies once that budget is exhausted.
Re-sending `pake/start` with the same `enrollId` also counts for each new reply;
replacing a session or disconnecting must not reset or refund the budget. A reply
contains `Y`, `cB` and `sealed`, letting a client test its guess locally without
ever sending `pake/confirm`. Counting only failed confirmations permits unlimited
guesses during the code's TTL.

Frame sequences begin at 1 in each direction. Encrypt/decrypt calls are queued in
call order and snapshot their inputs. Separately from sequence validity,
random-nonce AES-GCM encryption is capped at **2^32 invocations per key per
direction**. Each attempt reserves budget before sealing, including failed
attempts, and codecs sharing a directional key share that counter. The 2^32-th
invocation is allowed; the next `encrypt()` rejects with the local `malformed`
code, destroys the codec and its channel keys, and requires a new session with
fresh ephemeral keys. Re-sending a retained frame does not invoke encryption and
does not consume budget. Neither a socket reconnect nor creating another codec
with the same key handle resets the counter.

Receivers check version, kid and exact next safe-integer sequence before
decryption; acceptance advances only after valid AEAD, UTF-8 and JSON-RPC.
**Every decrypt fault, including `bad_kid`, destroys the codec and its channel
keys and ends the local session.** The client and runner layers **MUST filter
frames whose `kid` differs from the current session before calling the codec**.
This depends on the reliable-link contract in
[`packages/client/src/contracts.ts:46-52`](../../client/src/contracts.ts#L46-L52)
and the runner's mirror contract: drop foreign/retired-kid frames upstream,
including buffered frames flushed on session binding. A stale frame must never
reach `decrypt()` and destroy the current session. Reflection fails
authentication. All errors have the same peer-visible message; diagnostic `code`
values are local and must never be relayed to the peer.

Destroying channel keys invalidates every codec using them, including in-flight
operations. Destroying a codec destroys its key handle; callers should create one
codec per side per key handle. Secret byte arrays and intermediates are wiped in
success/failure cleanup. WebCrypto keys are dropped, and JavaScript strings,
bigints, engine copies and externally retained storage keys cannot be reliably
erased by this API. Stores remain responsible for deleting retained records.

## Node identity persistence

`generateKeyPair()` remains the nonextractable browser/ephemeral path. Its
`webcrypto`/`wrapped` records need a store that preserves `CryptoKey` objects (such
as IndexedDB); they are not portable Node file records. Use the explicit raw path
for a runner identity that must survive process restarts:

```ts
import { generateRawKeyPair, loadKeyPair } from "@berdyh/bridge-crypto";

// store is injected by the runner: it encrypts/decrypts raw byte records at rest,
// uses file mode 0600, and restores publicKey/secretKey as Uint8Array values.
async function restoreIdentity() {
  const record = (await store.read()) ?? (await generateRawKeyPair());
  try {
    await store.write(record); // await encryption/persistence before wiping bytes
    return await loadKeyPair(record);
  } finally {
    record.secretKey.fill(0);
  }
}
const identity = await restoreIdentity();
// Retain identity for agree(); destroy it when the runner shuts down.
// For later saves, toStored() preserves kind "raw"; wipe that copy after writing.
```

The encryption key belongs to the runner's durable credential store. Reuse the
saved identity on every boot; generate a replacement only on re-enrollment, since
browsers pin its public key. This is an explicit raw-secret persistence boundary;
callers need no direct noble imports. Loading copies the secret and destroying
the handle wipes its internal copy. Caller-owned records remain the caller's
responsibility to wipe and delete.

## Vector provenance and test environments

[RFC 9382](https://www.rfc-editor.org/rfc/rfc9382.html) publishes edwards25519
constants but **its Appendix B exchange vectors are P-256 only**. The
edwards25519 exchange is tested with bridge-calculated fixtures (below).
`spake2.test.ts` checks the published M/N constants and the first published P-256
transcript/confirmation vector against the shared schedule.

`fixtures/edwards25519.json` contains four independently calculated edwards25519
fixtures, covering present/absent A and B identities. These are bridge fixtures,
not RFC-published vectors. They were calculated with Python 3 integer affine
Edwards arithmetic and standard-library `hashlib.scrypt`, SHA-256 and HMAC, without
noble or the TypeScript implementation. The reference uses field prime `2^255-19`,
`d=-121665/121666`, standard compressed generator
`5866666666666666666666666666666666666666666666666666666666666666`,
the published M/N, and Appendix B's first `x` and `y` reduced modulo the subgroup
order. It applies affine twisted Edwards addition and double-and-add scalar
multiplication, with `K=8*x*y*P`. The password scalar uses the suite parameters
above. Expected messages, shared point, transcript, Ke/Ka, confirmation keys and
MACs are recorded. Tests check those bytes and run the public PAKE API with the
recorded scalars supplied through a test-only CSPRNG spy.

The complete suite runs in the normal Node environment and again through
`browser.test.ts` in Vitest's jsdom environment. Since jsdom does not implement
SubtleCrypto, that test injects Node's real WebCrypto into the DOM realm. Both
environments exercise the native X25519 path and forced noble fallback. This is
jsdom/WebCrypto coverage; real browser-engine coverage is separate.
