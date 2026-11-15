import { describe, expect, it } from "vitest";
import { base64UrlDecode, base64UrlEncode } from "./encoding.js";

describe("wire encoding", () => {
  it("round-trips empty, binary and large inputs without Buffer", () => {
    for (const value of [new Uint8Array(), Uint8Array.from({ length: 256 }, (_, i) => i), new Uint8Array(100000).fill(255)]) {
      expect(base64UrlDecode(base64UrlEncode(value))).toEqual(value);
      expect(base64UrlEncode(value)).not.toMatch(/[=+/]/);
    }
  });
  it.each(["a", "AB", "AAB", "AA=", "AA+", "AA/", " AA", "AA\n"])("rejects noncanonical %j", (text) => {
    expect(() => base64UrlDecode(text)).toThrow(expect.objectContaining({ code: "malformed" }));
  });
});
