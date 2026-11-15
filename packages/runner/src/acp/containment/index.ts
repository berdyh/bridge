/**
 * Containment profiles: how an agent is run with no built-in tools and only a plugin's own MCP
 * servers. `ContainmentProfile` and `ContainmentRequest` are defined in `../contracts.ts`; this module holds:
 * `claude.ts` (the pinned claude profile), `profile.ts` (the agent-independent launch parts), `secret.ts`
 * (the session secret file).
 */
// Explicit, not `export *`: the test seams of the pin check (`ClaudeContainmentSeams`, `*WithSeams`) stay in-package.
export {
  CLAUDE_ADAPTER_PACKAGE,
  CLAUDE_MEASURED_STACKS,
  CLAUDE_PLATFORM_PACKAGE,
  CLAUDE_SDK_PACKAGE,
  CLAUDE_UNREADABLE_COMMANDS,
  checkClaudeNewSession,
  claudeCommandsOutsideSet,
  claudeContainmentSupport,
  claudeExecutableProblem,
  claudeProfileOf,
  claudeSessionOptions,
  claudeToolOutsideSet,
  resolveClaudeStack,
  type ClaudeMeasuredStack,
  type ClaudeStack,
} from "./claude.js";
export * from "./profile.js";
export * from "./secret.js";

export { confinedExecutionSupport, CONFINED_PROVIDER_ENDPOINTS } from "../confined.js";
