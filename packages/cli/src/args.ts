import { parseArgs } from "node:util";

import { UsageError } from "./deps.js";

/** Strict flag parsing; unknown flags are a usage error (exit code 2). */
export function parse<O extends Record<string, { type: "boolean" | "string" }>>(
  args: string[],
  options: O,
): { values: { [K in keyof O]?: O[K]["type"] extends "boolean" ? boolean : string }; positionals: string[] } {
  try {
    const r = parseArgs({ args, options, allowPositionals: true, strict: true });
    return r as never;
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}
