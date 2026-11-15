/**
 * Identity of the sanitized typed errors the keychain facade throws from its guarded runner. Not in the
 * package barrel and not a property of the error, so a runner cannot forge one by building a
 * `KeychainError` (or copying a name or field): only code that imports this module can mark an error.
 * `exec()` passes a marked error through a macOS operation unchanged and replaces every other one.
 */
const sanitized = new WeakSet<object>();

export function markSanitized<T extends object>(error: T): T {
  sanitized.add(error);
  return error;
}

export function isSanitized(error: unknown): boolean {
  return typeof error === "object" && error !== null && sanitized.has(error);
}
