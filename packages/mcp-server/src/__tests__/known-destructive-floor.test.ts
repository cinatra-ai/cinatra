import { describe, expect, it } from "vitest";
import {
  isKnownDestructiveToolName,
  KNOWN_DESTRUCTIVE_TOOL_NAMES,
} from "../known-destructive-floor";

// cinatra#2020 S5 — known-destructive floor (design §2.3 / D9). Pure predicate
// over a resolved tool name; OR'd into the invoker step-3 trigger (PR-3).

describe("isKnownDestructiveToolName — curated exact set", () => {
  it("every curated known-destructive ability id hits", () => {
    expect(KNOWN_DESTRUCTIVE_TOOL_NAMES.size).toBeGreaterThan(0);
    for (const name of KNOWN_DESTRUCTIVE_TOOL_NAMES) {
      expect(isKnownDestructiveToolName(name)).toBe(true);
    }
  });

  it("matches the exact set case-insensitively", () => {
    expect(isKnownDestructiveToolName("CORE/DELETE-POST")).toBe(true);
    expect(isKnownDestructiveToolName("  core/delete-user  ")).toBe(true);
  });
});

describe("isKnownDestructiveToolName — verb-boundary pattern", () => {
  it("hits a destructive verb at a path / underscore / hyphen / string boundary", () => {
    const positives = [
      "delete-post",
      "core/delete-post",
      "ewpa/delete_user",
      "plugin_uninstall",
      "deactivate-plugin",
      "reset-settings",
      "purge_cache",
      "drop-table",
      "erase_all",
      "destroy_session",
      "trash_post",
      "remove-user",
      "bulk_delete",
      "delete",
    ];
    for (const name of positives) {
      expect(isKnownDestructiveToolName(name), name).toBe(true);
    }
  });

  it("does NOT hit when the verb is not a whole boundary-delimited token", () => {
    const negatives = [
      "undelete_marker",
      "deleted_flag",
      "predelete",
      "resetter",
      "core/get-post",
      "read_config",
      "list-users",
      "create-post",
      "update_meta",
    ];
    for (const name of negatives) {
      expect(isKnownDestructiveToolName(name), name).toBe(false);
    }
  });

  it("treats camelCase as out of scope (only /, _, - and ends are boundaries)", () => {
    // A camelCase destructive name still parks via annotations or the exact set;
    // a miss here only forgoes an EXTRA confirmation, never loosens one.
    expect(isKnownDestructiveToolName("deletePost")).toBe(false);
  });
});

describe("isKnownDestructiveToolName — guards", () => {
  it("returns false for empty, whitespace-only, or nullish input", () => {
    expect(isKnownDestructiveToolName("")).toBe(false);
    expect(isKnownDestructiveToolName("   ")).toBe(false);
    expect(isKnownDestructiveToolName(null)).toBe(false);
    expect(isKnownDestructiveToolName(undefined)).toBe(false);
  });
});
