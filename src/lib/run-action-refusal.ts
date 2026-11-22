// cinatra#3745: the fixed answer to a refused run tool call.
//
// Three refusal classes end a run's tool call: the outward-action refusal and
// the action-check refusal of the host's argument preparation
// (`@/lib/extension-host-context`), and the step-tool policy refusal of the run
// store (`@cinatra-ai/agents/store`). A road that answers a refused call reads
// the code here and answers 403 with one fixed sentence and that code, never
// with exception text. Each class is matched by identity, by
// `runActionRefusalClassCode` of the host's argument preparation, which names
// all three (this module never loads the run store itself). That module is
// loaded only for an error that carries one of the class names, so an ordinary
// error never loads it and keeps its road's generic answer.
// An error with the zod marker, or with a marker that cannot be read, is no
// refusal here, whatever its class: the zod marker takes precedence for every
// marked error (cinatra#4465), so the road's caller-facing answer
// (`@/lib/passthrough-refusal`) answers it from its issues or with its fixed
// sentence.

import { carriesZodMarker } from "@/lib/passthrough-refusal";

/** The one sentence a refused run tool call is answered with. */
export const RUN_ACTION_REFUSED = "The run's tool call was refused.";

const REFUSAL_CLASS_NAMES: ReadonlySet<string> = new Set([
  "OutwardActionRefusal", "ArtifactActionCheckRefusal", "RunStepToolPolicyRefusal",
]);

/** The code of a refused run tool call, or null for every other error and for every error with the zod marker. */
export async function runActionRefusalCode(err: unknown): Promise<string | null> {
  if (carriesZodMarker(err)) return null;
  // A class question that throws there answers true (no refusal); the roads catch any later throw.
  if (!(err instanceof Error) || !REFUSAL_CLASS_NAMES.has(err.name)) return null;
  try {
    const { runActionRefusalClassCode } = await import("@/lib/extension-host-context");
    return runActionRefusalClassCode(err);
  } catch {
    return null;
  }
}
