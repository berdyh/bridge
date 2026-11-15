/** Small structural guards shared by the validators in this package. */

export type Obj = Record<string, unknown>;

export const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);
export const isStr = (v: unknown): v is string => typeof v === "string";
export const isNonEmpty = (v: unknown): v is string => isStr(v) && v.length > 0;
export const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);
export const isNonNegInt = (v: unknown): v is number => isInt(v) && v >= 0;
export const isPosInt = (v: unknown): v is number => isInt(v) && v > 0;
export const optional = (v: unknown, f: (x: unknown) => boolean) => v === undefined || f(v);

const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** Unpadded base64url, non-empty. */
export const isBase64Url = (v: unknown): v is string => isStr(v) && BASE64URL.test(v);

/** Result of a validator that explains itself. */
export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };
