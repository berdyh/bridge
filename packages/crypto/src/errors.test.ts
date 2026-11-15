import { describe, expect, it } from "vitest";
import { BridgeCryptoError, CRYPTO_ERROR_CODES, isCryptoError } from "./index.js";

describe("BridgeCryptoError", () => {
  it("carries a code and a generic message", () => {
    for (const code of CRYPTO_ERROR_CODES) {
      const e = new BridgeCryptoError(code);
      expect(e.code).toBe(code);
      expect(e.message).toBe("crypto operation failed");
      expect(isCryptoError(e)).toBe(true);
    }
    expect(isCryptoError(new Error("x"))).toBe(false);
  });
});
