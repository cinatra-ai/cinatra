// ---------------------------------------------------------------------------
// Conformance pin (cinatra#3785): the two independently-stated answers to "does
// this kind's install default reach only the owner?" must stay equal.
//
//   • `OWNER_DEFAULT_INSTALL_KINDS` (install-access-target.ts): read by the
//     kind-aware target mapping to decide which kinds need an EXPLICIT
//     `org:<id>` policy at the organization target.
//   • `KIND_DEFAULT_ACCESS_POLICY` (install-access-contract.ts): the table
//     `setExtensionInstallAccess` actually applies when no policy is supplied,
//     read here through the exported `kindInstallDefaultIsOwnerOnly`.
//
// They are stated SEPARATELY and cannot be derived from one another in code:
// `install-access-target.ts` is deliberately PURE (client components import it)
// and must not pull the server-only contract module's import chain. This test is
// what keeps them from drifting, by the same mechanism the install-row resource
// kinds use (src/lib/__tests__/install-row-resource-kinds-conformance.test.ts).
//
// Drift matters in one direction each way. A kind that gained an owner-only
// default but is missing from the pure roster would install at the organization
// target with an owner-only reach again, which is the whole defect #3785 names.
// A kind listed in the roster whose real default is WIDER would be handed an
// `org:<id>` policy that silently narrows what the contract meant to apply.
// ---------------------------------------------------------------------------
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("../permissions-store", () => ({
  writeExtensionInstallAccessAtomic: vi.fn(),
}));

import {
  OWNER_DEFAULT_INSTALL_KINDS,
  installDefaultIsOwnerOnly,
} from "../install-access-target";
import {
  KIND_INSTALL_DEFAULT_KINDS,
  kindInstallDefaultIsOwnerOnly,
} from "../install-access-contract";
import { ALL_EXTENSION_KINDS } from "../permissions-kind-hooks";

// Every kind EITHER roster names. `ALL_EXTENSION_KINDS` is a hand-kept list
// typed `ExtensionKind[]`, which admits no wrong entry but does not require
// exhaustiveness, so a kind added to the contract's own table and to
// `ExtensionKind` alone would escape a loop over it. Reading the contract's
// keys beside it closes that.
const EVERY_KIND_EITHER_ROSTER_NAMES = Array.from(
  new Set<string>([...ALL_EXTENSION_KINDS, ...KIND_INSTALL_DEFAULT_KINDS]),
).sort();

describe("owner-only install defaults stay in lockstep (cinatra#3785)", () => {
  it("agrees with the contract's own table for EVERY permissions resource kind", () => {
    expect(EVERY_KIND_EITHER_ROSTER_NAMES.length).toBeGreaterThan(0);
    for (const kind of EVERY_KIND_EITHER_ROSTER_NAMES) {
      expect(installDefaultIsOwnerOnly(kind)).toBe(kindInstallDefaultIsOwnerOnly(kind));
    }
  });

  it("the kind roster and the contract's own table name the same kinds", () => {
    // The enumeration invariant the case above leans on, stated on its own so a
    // divergence reports as itself rather than as a policy disagreement.
    expect([...KIND_INSTALL_DEFAULT_KINDS].sort()).toEqual(
      [...ALL_EXTENSION_KINDS].sort(),
    );
  });

  it("the pure roster names only kinds the contract knows", () => {
    for (const kind of OWNER_DEFAULT_INSTALL_KINDS) {
      expect(ALL_EXTENSION_KINDS).toContain(kind);
    }
  });

  it("the connector kind is owner-only by neither reading (its default is its own declaration)", () => {
    expect(installDefaultIsOwnerOnly("connector")).toBe(false);
    expect(kindInstallDefaultIsOwnerOnly("connector")).toBe(false);
  });
});
