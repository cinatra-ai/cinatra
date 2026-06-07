import "server-only";

import { z } from "zod";
// Import the registry from the light subpath (same singleton the barrel
// re-exports) so this module doesn't pull the heavy objects barrel (host
// components/auth) into bare-node consumers/tests.
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";
import { workflowSpecSchema } from "../spec/schema";

// Object-layer registration. Registers `workflow` and
// `workflow_template` as known object types so generic object tooling
// (navigation, search, the data/new wizard) is aware of them. Row-level
// dual-write into the generic objects table / Graphiti projection is layered in
// later; the workflow tables remain the source of truth.

export const WORKFLOW_OBJECT_TYPE = "@cinatra-ai/workflows:workflow";
export const WORKFLOW_TEMPLATE_OBJECT_TYPE = "@cinatra-ai/workflows:workflow_template";

export function registerWorkflowObjectTypes(): void {
  objectTypeRegistry.register({
    type: WORKFLOW_OBJECT_TYPE,
    // Provisional category; refined when the workflow UI lands.
    category: "report",
    schema: z.record(z.string(), z.unknown()),
    lifecycle: { sources: ["agent", "user"], mutableBy: ["agent", "user"] },
    renderers: { listRow: null, card: null, detail: null },
  });
  objectTypeRegistry.register({
    type: WORKFLOW_TEMPLATE_OBJECT_TYPE,
    category: "report",
    // A template's definition is a WorkflowSpec.
    schema: workflowSpecSchema,
    lifecycle: { sources: ["user", "import"], mutableBy: ["user"] },
    renderers: { listRow: null, card: null, detail: null },
  });
}
