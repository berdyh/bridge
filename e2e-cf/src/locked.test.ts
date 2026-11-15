import { describe, expect, it } from "vitest";
import { testing } from "../../packages/server-cf/example/guard.js";

// Unit-level check of the fake-auth guard; the wrangler-level locked start lives in bridge.test.ts.
const env = (APP_ORIGIN: string, BRIDGE_TEST_AUTH?: string) => ({ APP_ORIGIN, BRIDGE_TEST_AUTH }) ;

describe("testing() guard", () => {
  it("is on only for the flag plus a loopback http origin", () => {
    expect(testing(env("http://127.0.0.1:8787", "1"))).toBe(true);
    expect(testing(env("http://localhost:8787", "1"))).toBe(true);
  });
  it("accepts the IPv6 loopback literal, which URL reports with brackets", () => {
    expect(new URL("http://[::1]:8787").hostname).toBe("[::1]");
    expect(testing(env("http://[::1]:8787", "1"))).toBe(true);
    expect(testing(env("http://[::1]:8787"))).toBe(false);
    expect(testing(env("https://[::1]:8787", "1"))).toBe(false);
    expect(testing(env("http://[::2]:8787", "1"))).toBe(false);
  });
  it("stays off without the flag", () => {
    expect(testing(env("http://127.0.0.1:8787", "0"))).toBe(false);
    expect(testing(env("http://127.0.0.1:8787"))).toBe(false);
  });
  it("stays off with BRIDGE_TEST_AUTH=1 on a non-loopback or https origin", () => {
    expect(testing(env("https://app.example.com", "1"))).toBe(false);
    expect(testing(env("http://app.example.com", "1"))).toBe(false);
    expect(testing(env("https://127.0.0.1", "1"))).toBe(false);
    expect(testing(env("https://localhost", "1"))).toBe(false);
    expect(testing(env("http://192.168.1.5:8787", "1"))).toBe(false);
  });
});
