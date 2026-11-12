// cinatra#3745: the fixed answer to a refused run tool call.
//
// Three refusal classes end a run's tool call: the outward-action refusal and
// the action-check refusal of the host's argument preparation
// (`@/lib/extension-host-context`), and the step-tool policy refusal of the run
// store (`@cinatra-ai/agents/store`). A road that answers a refused call reads
// the code here and answers 403 with one fixed sentence and that code, never
// with exception text. Each class is matched by identity, read from the module
// that owns it. That module is loaded only for an error that carries its class
// name, so an ordinary error never loads it and keeps its road's generic answer.

/** The one sentence a refused run tool call is answered with. */
export const RUN_ACTION_REFUSED = "The run's tool call was refused.";

const REFUSAL_CLASSES = new Map<string, () => Promise<unknown>>([
  ["OutwardActionRefusal", async () => (await import("@/lib/extension-host-context")).OutwardActionRefusal],
  ["ArtifactActionCheckRefusal", async () => (await import("@/lib/extension-host-context")).ArtifactActionCheckRefusal],
  ["RunStepToolPolicyRefusal", async () => (await import("@cinatra-ai/agents/store")).RunStepToolPolicyRefusal],
]);

/** The code of a refused run tool call, or null for every other error. */
export async function runActionRefusalCode(err: unknown): Promise<string | null> {
  if (!(err instanceof Error)) return null;
  const readClass = REFUSAL_CLASSES.get(err.name);
  if (!readClass) return null;
  let refusalClass: unknown;
  try {
    refusalClass = await readClass();
  } catch {
    return null;
  }
  if (typeof refusalClass !== "function" || !(err instanceof refusalClass)) return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : null;
}
