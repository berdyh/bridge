/** 20 consonants, no vowels (no words) and no look-alikes (RFC 8628 section 6.1). */
export const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
export const USER_CODE_LENGTH = 8;

/** Fills and returns `n` random bytes. Inject for tests; default is crypto. */
export type RandomBytes = (n: number) => Uint8Array;

const defaultRandomBytes: RandomBytes = (n) =>
  globalThis.crypto.getRandomValues(new Uint8Array(n));

/** Generate a normalized 8-char code, unbiased via rejection sampling. */
export function generateUserCode(randomBytes: RandomBytes = defaultRandomBytes): string {
  const size = USER_CODE_ALPHABET.length;
  const limit = 256 - (256 % size);
  let out = "";
  let guard = 0;
  while (out.length < USER_CODE_LENGTH) {
    const bytes = randomBytes(USER_CODE_LENGTH * 2);
    for (const b of bytes) {
      if (b < limit) {
        out += USER_CODE_ALPHABET[b % size];
        if (out.length === USER_CODE_LENGTH) break;
      }
    }
    if (++guard > 1000) throw new Error("random source produced no usable bytes");
  }
  return out;
}

/** Uppercase and drop everything that is not a letter or digit (dashes, spaces). */
export function normalizeUserCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function isValidUserCode(input: string): boolean {
  const code = normalizeUserCode(input);
  if (code.length !== USER_CODE_LENGTH) return false;
  for (const ch of code) if (!USER_CODE_ALPHABET.includes(ch)) return false;
  return true;
}

/** XXXX-XXXX. Throws if the input is not a valid code. */
export function formatUserCode(input: string): string {
  const code = normalizeUserCode(input);
  if (!isValidUserCode(code)) throw new Error("invalid user code");
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
