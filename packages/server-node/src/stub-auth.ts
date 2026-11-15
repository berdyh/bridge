import type { AuthVerifier } from "@berdyh/bridge-server";

/**
 * `AuthVerifier` over static token tables, for tests only: `token -> userId`.
 *
 * Runner tokens get a stable `credentialId` (`stub-credential-<n>`, by table order),
 * and `revokeRunnerCredentials` makes the matching tokens report as revoked
 * (`Principal.revoked`, with their `credentialId`), as a real provider's revoked key does:
 * the relay gives such a token the revoked verdict when its store confirms the revoke, else 401.
 */
export function createStubAuthVerifier(tokens: { browser: Record<string, string>; runner: Record<string, string> }): AuthVerifier {
  const runnerCredential = new Map<string, string>();
  Object.keys(tokens.runner).forEach((t, i) => runnerCredential.set(t, `stub-credential-${i + 1}`));
  const revoked = new Set<string>();
  const own = (table: Record<string, string>, token: string): string | undefined =>
    Object.hasOwn(table, token) ? table[token] : undefined;

  return {
    async verifyBrowser(token) {
      const userId = own(tokens.browser, token);
      return userId === undefined ? undefined : { userId };
    },
    async verifyRunner(token) {
      const userId = own(tokens.runner, token);
      if (userId === undefined) return undefined;
      const credentialId = runnerCredential.get(token)!;
      return revoked.has(`${userId}\u0000${credentialId}`) ? { userId, credentialId, revoked: true } : { userId, credentialId };
    },
    async revokeRunnerCredentials(userId, credentialIds) {
      for (const id of credentialIds) revoked.add(`${userId}\u0000${id}`);
    },
  };
}
