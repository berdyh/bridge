import { CRYPTO_ERROR_CODES, type CryptoError as CryptoErrorShape, type CryptoErrorCode } from "./contracts.js";

/** The one error type of this package. The message never says which check failed. */
export class BridgeCryptoError extends Error implements CryptoErrorShape {
  readonly code: CryptoErrorCode;

  constructor(code: CryptoErrorCode) {
    super("crypto operation failed");
    this.name = "BridgeCryptoError";
    this.code = code;
  }
}

export function isCryptoError(e: unknown): e is BridgeCryptoError {
  return e instanceof BridgeCryptoError || (e instanceof Error && (CRYPTO_ERROR_CODES as readonly string[]).includes((e as { code?: string }).code ?? ""));
}
