// The surface inventory is the source of truth for object exposure checks,
// so it must be internally consistent.
import { describe, it, expect } from "vitest";
import {
  CARVE_OUT_MODE,
  LEGACY_PRIMITIVES,
  RAW_OBJECT_ACCESS_ALLOWLIST,
  DYNAMIC_TYPES,
  SKILL_OAS_REFS,
  ARTIFACT_SURFACE,
  LIST_SURFACE,
  DELEGATED_CHAT_OBJECT_ALLOWLIST,
} from "../surface-inventory";

describe("surface inventory consistency", () => {
  it("carve-out is fail-closed", () => {
    expect(CARVE_OUT_MODE).toBe("fail-closed");
  });

  it("every legacy primitive has a non-empty replacement and is unregistered", () => {
    expect(LEGACY_PRIMITIVES.length).toBe(19); // 5 accounts_* + 6 contacts_* + 8 lists_*
    for (const p of LEGACY_PRIMITIVES) {
      expect(p.replacement.length).toBeGreaterThan(0);
      // All 19 legacy entries are retired. Registry and handler scans
      // assert absence in the live surface.
      expect(p.registered).toBe(false);
      expect(p.registry).toMatch(/registry\.ts$/);
    }
  });

  it("legacy primitive names are unique", () => {
    const names = LEGACY_PRIMITIVES.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("every raw-access allow-list entry has a valid category + note", () => {
    const cats = new Set(["substrate", "entity-bypass", "campaign-bypass"]);
    for (const e of RAW_OBJECT_ACCESS_ALLOWLIST) {
      expect(cats.has(e.category)).toBe(true);
      expect(e.note.length).toBeGreaterThan(0);
    }
    // Direct entity-read helpers and campaign-bypass entries are absent;
    // substrate entries remain. The bypass categories stay in the type union
    // so existing disposition records can still be typed.
    expect(RAW_OBJECT_ACCESS_ALLOWLIST.some((e) => e.category === "substrate")).toBe(true);
  });

  it("every dynamic type has a disposition", () => {
    const dispositions = new Set(["promote", "internal", "retire"]);
    expect(DYNAMIC_TYPES.length).toBeGreaterThan(0);
    for (const d of DYNAMIC_TYPES) {
      expect(dispositions.has(d.disposition)).toBe(true);
      expect(d.typeId.startsWith("@cinatra-ai/dynamic:")).toBe(true);
    }
  });

  it("SKILL/OAS refs are classified", () => {
    const issues = new Set(["legacy-primitive", "invalid-type-id-shape", "invalid-id-shape"]);
    for (const r of SKILL_OAS_REFS) {
      expect(issues.has(r.issue)).toBe(true);
      expect(r.line).toBeGreaterThan(0);
    }
  });

  it("artifact + list surfaces declare their consumer surface and scope boundary", () => {
    expect(ARTIFACT_SURFACE.typeId).toBe("@cinatra-ai/artifact:object");
    expect(ARTIFACT_SURFACE.consumerFiles.length).toBeGreaterThan(0);
    expect(ARTIFACT_SURFACE.substrateNote).toMatch(/out of scope/i);
    expect(LIST_SURFACE.typeId).toBe("@cinatra-ai/lists:list");
    expect(LIST_SURFACE.memberRefTypes.length).toBe(2);
  });

  it("delegated-chat object allowlist excludes retired entity reads", () => {
    // Legacy account/contact reads and the stale `objects_search` entry are
    // absent; chat reads through the canonical `objects_list` / `objects_get`
    // only.
    for (const p of ["contacts_list", "contacts_get", "accounts_list", "accounts_get", "objects_search"]) {
      expect(DELEGATED_CHAT_OBJECT_ALLOWLIST).not.toContain(p);
    }
    expect(DELEGATED_CHAT_OBJECT_ALLOWLIST).toContain("objects_list");
    expect(DELEGATED_CHAT_OBJECT_ALLOWLIST).toContain("objects_get");
  });
});
