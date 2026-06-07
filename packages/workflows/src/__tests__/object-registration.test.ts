import { describe, it, expect } from "vitest";
import {
  registerWorkflowObjectTypes,
  WORKFLOW_OBJECT_TYPE,
  WORKFLOW_TEMPLATE_OBJECT_TYPE,
} from "../integration/register-object-types";
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";

describe("object-type registration", () => {
  it("registers workflow + workflow_template object types idempotently", () => {
    registerWorkflowObjectTypes();
    registerWorkflowObjectTypes(); // idempotent replace-by-id
    const wf = objectTypeRegistry.resolve(WORKFLOW_OBJECT_TYPE);
    const tmpl = objectTypeRegistry.resolve(WORKFLOW_TEMPLATE_OBJECT_TYPE);
    expect(wf?.type).toBe(WORKFLOW_OBJECT_TYPE);
    expect(tmpl?.type).toBe(WORKFLOW_TEMPLATE_OBJECT_TYPE);
    // They are data objects, not artifacts.
    expect(wf?.isArtifact).toBeUndefined();
  });
});
