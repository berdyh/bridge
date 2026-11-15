import { createHash, randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { sha256 } from "./sha256.js";
import { EFF_SHORT_WORDLIST, wordsOf } from "./words.js";

describe("sha256 (vendored)", () => {
  it("matches node:crypto on every length around the block boundaries and on long inputs", () => {
    for (const length of [...Array.from({ length: 200 }, (_, i) => i), 1000, 4096, 65_537]) {
      const data = new Uint8Array(randomBytes(length));
      expect(Buffer.from(sha256(data)).toString("hex")).toBe(createHash("sha256").update(data).digest("hex"));
    }
  });

  it("matches the FIPS test vector for abc", () => {
    expect(Buffer.from(sha256(new TextEncoder().encode("abc"))).toString("hex")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("EFF short wordlist", () => {
  it("has 1296 distinct lowercase words, in file order", () => {
    expect(EFF_SHORT_WORDLIST).toHaveLength(1296);
    expect(new Set(EFF_SHORT_WORDLIST).size).toBe(1296);
    expect(EFF_SHORT_WORDLIST.every((w) => /^[a-z]+(-[a-z]+)?$/.test(w))).toBe(true);
    expect(EFF_SHORT_WORDLIST[0]).toBe("acid");
    expect(EFF_SHORT_WORDLIST[1295]).toBe("zoom");
  });
});

describe("wordsOf", () => {
  // Expected words computed outside this code (python hashlib over the same list).
  it.each([
    ["", ["photo", "stick", "stole", "coach"]],
    ["abc", ["steam", "gear", "poem", "claw"]],
    ["AAAAAAAAAAAAAAAAAAAAAA", ["spray", "puma", "rogue", "wifi"]],
    ["x_Yz-0123456789abcdefg", ["probe", "yodel", "ruby", "vice"]],
  ])("fixed vector for %j", (keyId, expected) => {
    expect(wordsOf(keyId)).toEqual(expected);
  });

  it("hashes the key-id string, not its decoded bytes, with big-endian words mod 1296", () => {
    const keyId = "kQ4n9mWb2Zr8xLp0TgY5aA";
    const digest = createHash("sha256").update(keyId, "utf8").digest();
    const expected = [0, 1, 2, 3].map((i) => EFF_SHORT_WORDLIST[digest.readUInt32BE(i * 4) % 1296]);
    expect(wordsOf(keyId)).toEqual(expected);
  });

  it("is deterministic, always four words, and differs between ids", () => {
    expect(wordsOf("same")).toEqual(wordsOf("same"));
    expect(wordsOf("same")).toHaveLength(4);
    expect(wordsOf("one")).not.toEqual(wordsOf("two"));
  });
});
