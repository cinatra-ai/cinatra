import { randomUUID } from "node:crypto";

import type { OrchestrateStreamInput } from "./types";

// ---------------------------------------------------------------------------
// Deterministic, test-only LLM provider for the WordPress/Drupal Playwright
// UATs. It is NOT a recorded transcript and makes NO network calls: it inspects
// the last user message + the CMS context embedded in the system prompt and
// emits scripted stream callbacks.
//
// Scope: this proves the widget → stream → SSE-frame integration round-trips
// end-to-end (button → mount → prompt → text/changes frames). It deliberately
// does NOT exercise a real CMS mutation via WayFlow — the scripted tool result
// stands in for the content-editor agent's output.
//
// Activation: env CINATRA_TEST_LLM_PROVIDER=scripted (set only by the UAT
// harness). It is fail-loud under production runtime so it can never serve a
// real user.
// ---------------------------------------------------------------------------

export const SCRIPTED_TEST_PROVIDER_ENV = "CINATRA_TEST_LLM_PROVIDER";
export const SCRIPTED_TEST_PROVIDER_VALUE = "scripted";

/** Sentinel the UAT specs assert appears in the streamed assistant reply. */
export const UAT_SENTINEL = "CINATRA_UAT_OK";

type EnvLike = Record<string, string | undefined>;

export function isScriptedTestProviderEnabled(env: EnvLike = process.env): boolean {
  return env[SCRIPTED_TEST_PROVIDER_ENV] === SCRIPTED_TEST_PROVIDER_VALUE;
}

/**
 * Fail-loud unless the scripted provider is enabled under an EXPLICIT
 * development runtime. Allow-list (not deny-list) so an unset / misspelled /
 * production runtime mode can never serve scripted output: enabled requires
 * `CINATRA_RUNTIME_MODE === "development"` AND `NODE_ENV !== "production"`.
 * Called unconditionally at the stream entry — a no-op unless the env flag is
 * set, so it costs nothing on the real path.
 */
export function assertScriptedProviderNotProduction(env: EnvLike = process.env): void {
  if (!isScriptedTestProviderEnabled(env)) return;
  if (env.CINATRA_RUNTIME_MODE !== "development" || env.NODE_ENV === "production") {
    throw new Error(
      `${SCRIPTED_TEST_PROVIDER_ENV}=${SCRIPTED_TEST_PROVIDER_VALUE} is set but the ` +
        `runtime is not an explicit development runtime ` +
        `(CINATRA_RUNTIME_MODE=${env.CINATRA_RUNTIME_MODE ?? "<unset>"}, ` +
        `NODE_ENV=${env.NODE_ENV ?? "<unset>"}). The scripted deterministic LLM ` +
        `provider is a test-only UAT affordance and must NEVER run outside development.`,
    );
  }
}

const EDIT_INTENT =
  /\b(edit|change|rewrite|update|revise|tighten|shorten|summar|title|headline|add|append|fix)\b/i;

function lastUserMessage(input: OrchestrateStreamInput): string {
  const messages = input.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m?.role === "user" && typeof m.content === "string") return m.content;
  }
  return "";
}

/**
 * Emit a deterministic stream for the UATs. Always streams a sentinel-bearing
 * text reply; when the prompt expresses an edit intent, also emits one
 * content-editor tool result (which the widget stream route maps to a `changes`
 * SSE frame), with `postId`/`nodeId` taken from the system-prompt CMS context.
 */
export async function runScriptedStream(input: OrchestrateStreamInput): Promise<void> {
  const system = input.system ?? "";
  const lastUser = lastUserMessage(input);
  const isDrupal = /Drupal context/i.test(system) || /\bnodeId:/.test(system);
  const idKey = isDrupal ? "nodeId" : "postId";
  const toolName = isDrupal
    ? "drupal_content_editor_run"
    : "wordpress_content_editor_run";
  const idMatch = system.match(new RegExp(`${idKey}:\\s*([^\\n]*)`));
  const idVal = (idMatch?.[1] ?? "").trim();

  try {
    input.onStepStart(1);
    const reply =
      `${UAT_SENTINEL}: deterministic test reply for ` +
      `${isDrupal ? "Drupal" : "WordPress"}. You said: "${lastUser.slice(0, 120)}".`;
    for (const chunk of reply.match(/[\s\S]{1,24}/g) ?? [reply]) {
      input.onTextDelta(chunk);
    }
    if (EDIT_INTENT.test(lastUser)) {
      input.onToolResult({
        id: randomUUID(),
        name: toolName,
        result: JSON.stringify({
          [idKey]: idVal,
          changes: [
            {
              field: "title",
              before: "UAT seeded title",
              after: "UAT seeded title (edited by the deterministic provider)",
            },
          ],
        }),
      });
    }
    input.onStepEnd(1);
  } catch (err) {
    input.onError(err instanceof Error ? err : new Error(String(err)));
  }
}
