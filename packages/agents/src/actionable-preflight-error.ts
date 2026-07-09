// Actionable run-enqueue preflight failures, surfaced through the run-start
// action results (cinatra#1056 connector preflight, cinatra#1062 LLM-provider
// preflight). Duck-typed by `code` so the run-start server actions can turn a
// missing/unconfigured connector or LLM provider into a deep-linkable fix
// instead of a generic "enqueue failed" — WITHOUT importing the host preflight
// error classes (which would pull their heavy load graph, incl. the LLM
// package, into this leaf module).

export const ACTIONABLE_RUN_PREFLIGHT_CODES = [
  "CONNECTOR_NOT_CONFIGURED",
  "LLM_PROVIDER_NOT_CONFIGURED",
] as const;

const CODES: ReadonlySet<string> = new Set(ACTIONABLE_RUN_PREFLIGHT_CODES);

export type ActionablePreflightFailure = {
  /** Human-readable, already-actionable message (from the thrown error). */
  error: string;
  /** Stable machine code (`CONNECTOR_NOT_CONFIGURED` | `LLM_PROVIDER_NOT_CONFIGURED`). */
  code: string;
  /** Deep-link to the fix (connector/LLM settings), when the error carries one. */
  settingsHref?: string;
};

/**
 * Map a thrown enqueue error to an actionable run-start failure, or `null` when
 * it is not a recognized preflight error (the caller keeps its generic
 * handling). Never throws.
 */
export function asActionablePreflightError(err: unknown): ActionablePreflightFailure | null {
  if (!err || typeof err !== "object" || !("code" in err)) return null;
  const code = (err as { code?: unknown }).code;
  if (typeof code !== "string" || !CODES.has(code)) return null;
  const e = err as { message?: unknown; settingsHref?: unknown };
  return {
    error: typeof e.message === "string" ? e.message : "Agent run blocked",
    code,
    settingsHref: typeof e.settingsHref === "string" ? e.settingsHref : undefined,
  };
}
