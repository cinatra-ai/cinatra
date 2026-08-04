// The CLASSIFIED result contract of the on-demand Anthropic native-skills
// probe diagnostic (cinatra#2390 S5 — the probe demoted out of the setup gate
// into Administration). Shared by the server action and the client card;
// deliberately free of server-only imports so the client island can consume
// the type.

/** Stable classification codes — never raw provider text. */
export type AnthropicProbeDiagnosticCode =
  | "accepted"
  | "rejected-function-tools"
  | "rejected-workspace"
  | "inconclusive"
  | "no-key"
  | "connector-unavailable";

export type AnthropicProbeDiagnosticResult = {
  code: AnthropicProbeDiagnosticCode;
  /** Operator-facing, sanitized, actionable. */
  message: string;
  /** The {skillId, version} the probe referenced, when it ran. */
  probed?: { skillId: string; version: string; disposable: boolean };
  at: string;
};
