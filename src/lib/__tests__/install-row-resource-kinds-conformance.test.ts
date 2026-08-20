// ---------------------------------------------------------------------------
// Conformance pin (cinatra#2850): the two independently-stated lists of "the
// kinds whose canonical install ROW carries the audience" must stay equal.
//
//   • `INSTALL_ACCESS_TARGET_KINDS` (install-access-target.ts) — the kinds whose
//     marketplace install OFFERS a pre-install access selector, i.e. the kinds
//     whose install PERSISTS an audience policy.
//   • `INSTALL_ROW_RESOURCE_KINDS` (permissions-kind-hooks.ts) — the kinds whose
//     polymorphic `resource_id` IS the `installed_extension.id`, i.e. the kinds
//     whose install ROW is the resource that CARRIES that audience.
//
// They are the same three kinds for one reason: a kind's install offers an
// access target exactly when the row it writes is the resource the audience
// hangs off. They are nonetheless stated SEPARATELY and cannot be derived from
// one another in code — `install-access-target.ts` is deliberately PURE (no
// server-only import chain) and must not import the server-only kind-hooks
// module. This test is what keeps them from drifting.
//
// Drift matters: the installed-extension read model narrows a canonical row
// kind through `installRowResourceKind` before consulting the row's access
// policy. A kind that gained an install-time audience but was missing from
// INSTALL_ROW_RESOURCE_KINDS would have that audience silently UNENFORCED at
// the read model (and so at the CG-5 runtime-cube serve gate).
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { INSTALL_ACCESS_TARGET_KINDS } from "@cinatra-ai/extensions/install-access-target";
import {
  INSTALL_ROW_RESOURCE_KINDS,
  installRowResourceKind,
} from "@cinatra-ai/extensions/permissions-kind-hooks";

describe("install-row audience vocabularies stay in lockstep (cinatra#2850)", () => {
  it("INSTALL_ROW_RESOURCE_KINDS === INSTALL_ACCESS_TARGET_KINDS (as sets)", () => {
    expect([...INSTALL_ROW_RESOURCE_KINDS].sort()).toEqual(
      [...INSTALL_ACCESS_TARGET_KINDS].sort(),
    );
  });

  it("narrows exactly the install-row-anchored kinds and nothing else", () => {
    for (const kind of INSTALL_ACCESS_TARGET_KINDS) {
      expect(installRowResourceKind(kind)).toBe(kind);
    }
  });

  it("returns null for canonical row kinds whose access resource lives elsewhere", () => {
    // `agent` is not a permissions resource kind at all; a `skill` row's policy
    // hangs off the skills catalog's own id, never the install row's.
    expect(installRowResourceKind("agent")).toBeNull();
    expect(installRowResourceKind("skill")).toBeNull();
    // And the kinds keyed to their own identity tables.
    expect(installRowResourceKind("agent_run")).toBeNull();
    expect(installRowResourceKind("connection")).toBeNull();
    expect(installRowResourceKind("")).toBeNull();
  });
});
