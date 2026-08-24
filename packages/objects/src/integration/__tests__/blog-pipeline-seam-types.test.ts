// Blog-pipeline passthrough-seam object types (cinatra#2960).
//
// The two seam records the blog-pipeline orchestrator persists through
// /api/agents/passthrough must be REGISTERED types: their former
// `@dynamic/types:blog-pipeline-*` ids are permanently tombstoned as write
// targets, so `objects_save` refused every selection save. This pins the
// registration (the definer side of the passthrough resolution rule).
import { describe, it, expect, beforeEach } from "vitest";

import { objectTypeRegistry } from "../../registry";
import { isTombstonedObjectTypeId } from "../../namespace";
import {
  registerAllObjectTypes,
  BLOG_PIPELINE_SELECTED_IDEA_TYPE_ID,
  BLOG_PIPELINE_DRAFT_PROJECTION_TYPE_ID,
} from "../register-types";

describe("register-types — blog-pipeline seam types", () => {
  beforeEach(() => {
    objectTypeRegistry._clearForTests();
    registerAllObjectTypes();
  });

  it("registers both seam types", () => {
    for (const id of [
      BLOG_PIPELINE_SELECTED_IDEA_TYPE_ID,
      BLOG_PIPELINE_DRAFT_PROJECTION_TYPE_ID,
    ]) {
      const entry = objectTypeRegistry.resolve(id);
      expect(entry, `expected ${id} to be registered`).not.toBeNull();
      expect(entry!.type).toBe(id);
    }
  });

  it("neither id is under a tombstoned dynamic namespace", () => {
    expect(isTombstonedObjectTypeId(BLOG_PIPELINE_SELECTED_IDEA_TYPE_ID)).toBe(false);
    expect(isTombstonedObjectTypeId(BLOG_PIPELINE_DRAFT_PROJECTION_TYPE_ID)).toBe(false);
  });

  it("dedups a retry inside one run on cinatra_agent_run_id", () => {
    const entry = objectTypeRegistry.resolve(BLOG_PIPELINE_SELECTED_IDEA_TYPE_ID)!;
    expect(entry.identityKey?.({ cinatra_agent_run_id: "run-1" })).toBe("run-1");
    expect(entry.identityKey?.({})).toBeNull();
  });

  it("registers as host built-ins — no extension definer to uninstall", () => {
    expect(objectTypeRegistry.definerOf(BLOG_PIPELINE_SELECTED_IDEA_TYPE_ID)).toBeNull();
    expect(objectTypeRegistry.definerOf(BLOG_PIPELINE_DRAFT_PROJECTION_TYPE_ID)).toBeNull();
  });
});
