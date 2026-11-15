// Fake auth and the /oauth and /__test routes exist only when explicitly enabled
// and the app origin is plain-http loopback.
export function testing(env: { APP_ORIGIN: string; BRIDGE_TEST_AUTH?: string }): boolean {
  const url = new URL(env.APP_ORIGIN);
  return env.BRIDGE_TEST_AUTH === "1" && url.protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}
