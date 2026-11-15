import type { AgentId, AgentTask } from "./types.js";

export interface AgentModelConfig {
  /** Model per agent; omit to let the CLI choose. */
  models?: Partial<Record<AgentId, string>>;
  /** Codex reasoning effort, e.g. "low". */
  codexReasoningEffort?: string;
}

export function buildPrompt(task: AgentTask): string {
  const schema = task.schema
    ? ["Return only valid JSON. Do not wrap it in Markdown.", "The JSON must satisfy this schema:", JSON.stringify(task.schema)].join("\n")
    : "Return only the final answer. Do not modify files or run tools.";
  return [
    "Act as a pure language-model backend, not an interactive coding session.",
    "Do not edit files. Do not start long-running processes. Do not ask follow-up questions.",
    ...(task.systemPrompt ? ["", "System prompt:", task.systemPrompt] : []),
    "",
    "User prompt:",
    task.prompt,
    "",
    schema,
  ].join("\n");
}

/** No-tool, ephemeral, non-interactive argv. The prompt travels on stdin. */
export function buildAgentArgs(
  agent: AgentId,
  cfg: AgentModelConfig,
  ctx: { cwd: string; outputFile: string },
): string[] {
  const model = cfg.models?.[agent];
  if (agent === "claude-code") {
    return [
      "--print",
      "--output-format",
      "text",
      "--no-session-persistence",
      "--permission-mode",
      "default",
      "--disable-slash-commands",
      ...(model ? ["--model", model] : []),
      // `--tools` is variadic: the empty string meaning "no tools" must be last.
      "--tools",
      "",
    ];
  }
  return [
    "exec",
    ...(model ? ["--model", model] : []),
    ...(cfg.codexReasoningEffort
      ? ["--config", `model_reasoning_effort=${JSON.stringify(cfg.codexReasoningEffort)}`]
      : []),
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--cd",
    ctx.cwd,
    "--ephemeral",
    "--color",
    "never",
    "--output-last-message",
    ctx.outputFile,
    "-",
  ];
}
