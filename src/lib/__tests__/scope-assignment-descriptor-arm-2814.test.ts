/**
 * THE WRITE ROAD'S DESCRIPTOR ARM (cinatra#2814, the fix leg of the per-scope
 * assignment page).
 *
 * `readPackageKindSource` is the seam the write gate actually reads through. It
 * asks the install rows first and the on-disk descriptor second. The row reader
 * keeps three states apart (no row, one named kind, rows that name no single
 * kind) and the gate must refuse the third. A two-state answer cannot carry
 * that refusal past the second arm: a package whose rows CONTRADICT each other
 * and that also ships on disk would be admitted by the disk answer, although
 * the row reader had just refused it.
 *
 * So this suite reads the REAL readers over a store double and a scan double,
 * through the production seam rather than through an injected reader, and pins
 * which of the two arms may answer for which state.
 */
import { describe, expect, it, vi } from "vitest";

import { BUILTIN_ASSISTANT_ALIAS } from "@/lib/assistant-registry-schema";
import { storeDouble, type Row } from "./support/eligibility-store-double";

// The rows the production readers see. `readPackageKindSource` takes no db, by
// design, because the slice's seam module owns its own reads. So the store
// itself is what this suite replaces.
const store = vi.hoisted(() => ({ db: null as { select: (...a: unknown[]) => unknown } | null }));
vi.mock("@/lib/better-auth-db", () => ({
  betterAuthDb: {
    select: (...args: unknown[]) => {
      if (!store.db) throw new Error("no store double installed");
      return store.db.select(...args);
    },
  },
}));

// The on-disk scan, with a CALL COUNT: an unreadable install record must refuse
// without reaching the disk at all, and only a count can say so.
const scan = vi.hoisted(() => ({
  descriptors: [] as { pkgName: string; kind: string }[],
  calls: 0,
}));
vi.mock("../../../packages/skills/src/extension-skill-resolver", () => ({
  scanSkillExtensions: async () => {
    scan.calls += 1;
    return scan.descriptors;
  },
}));

const { readPackageKindSource } = await import(
  "../../../packages/skills/src/agent-skill-assignment-sources"
);

const PACKAGE = "@northstar/atlas";
const BUILT_IN = BUILTIN_ASSISTANT_ALIAS.packageName;

/** Install the rows and the descriptors one reading sees. */
function given(opts: { installs?: Row[]; templates?: Row[]; onDisk?: { pkgName: string; kind: string }[] }) {
  store.db = storeDouble({ installs: opts.installs, templates: opts.templates }) as unknown as {
    select: (...a: unknown[]) => unknown;
  };
  scan.descriptors = opts.onDisk ?? [];
  scan.calls = 0;
}

/** Two LIVE rows of one package that name different kinds. */
const conflicting: Row[] = [
  { id: "ie_one", packageName: PACKAGE, kind: "agent", status: "active" },
  { id: "ie_two", packageName: PACKAGE, kind: "skill", status: "active" },
];

describe("readPackageKindSource: which arm may answer for which reading", () => {
  it("refuses a package whose install rows CONFLICT, although it ships on disk", async () => {
    // The state the two-state answer lost: the rows are present and say two
    // different things, and the descriptor would happily say a third. The disk
    // is not consulted at all, because there is nothing left to ask it.
    given({ installs: conflicting, onDisk: [{ pkgName: PACKAGE, kind: "agent" }] });
    expect(await readPackageKindSource(PACKAGE)).toBeNull();
    expect(scan.calls).toBe(0);
  });

  it("refuses rows that carry no kind at all, although it ships on disk", async () => {
    // The other unreadable shape: rows exist, none of them names a kind. The
    // row reader groups it with the contradiction, and so does the seam.
    given({
      installs: [{ id: "ie_blank", packageName: PACKAGE, kind: null, status: "active" }],
      onDisk: [{ pkgName: PACKAGE, kind: "agent" }],
    });
    expect(await readPackageKindSource(PACKAGE)).toBeNull();
    expect(scan.calls).toBe(0);
  });

  it("still reads the on-disk descriptor for a package with NO install row", async () => {
    // The provider-declared agent: no canonical row anywhere, a `cinatra.kind`
    // on disk. This arm is the reason the descriptor road exists, and the fix
    // leaves it exactly where it was.
    given({ onDisk: [{ pkgName: PACKAGE, kind: "agent" }] });
    expect(await readPackageKindSource(PACKAGE)).toBe("agent");
    expect(scan.calls).toBe(1);
  });

  it("still refuses a package that is in neither the rows nor the directory", async () => {
    given({ onDisk: [{ pkgName: "@northstar/other", kind: "agent" }] });
    expect(await readPackageKindSource(PACKAGE)).toBeNull();
    expect(scan.calls).toBe(1);
  });

  it("answers from a single named row without reaching the disk", async () => {
    given({
      installs: [{ id: "ie_named", packageName: PACKAGE, kind: "agent", status: "active" }],
      onDisk: [{ pkgName: PACKAGE, kind: "skill" }],
    });
    expect(await readPackageKindSource(PACKAGE)).toBe("agent");
    expect(scan.calls).toBe(0);
  });

  it("still answers for the built-in platform assistant, which has neither", async () => {
    // Its kind comes from the boot-seeded template row, and that arm belongs to
    // the ABSENT reading, which the built-in is the one package in.
    given({ templates: [{ id: "tpl_cinatra", packageName: BUILT_IN, agentKind: "assistant" }] });
    expect(await readPackageKindSource(BUILT_IN)).toBe("agent");
    expect(scan.calls).toBe(0);
  });

  it("refuses the built-in too where ITS rows conflict", async () => {
    // A row under the reserved name is a state the platform never writes for
    // itself, so a contradictory one is an install record that cannot be read,
    // and the template arm may not answer over the top of it.
    given({
      installs: [
        { id: "ie_one", packageName: BUILT_IN, kind: "agent", status: "active" },
        { id: "ie_two", packageName: BUILT_IN, kind: "skill", status: "active" },
      ],
      templates: [{ id: "tpl_cinatra", packageName: BUILT_IN, agentKind: "assistant" }],
    });
    expect(await readPackageKindSource(BUILT_IN)).toBeNull();
    expect(scan.calls).toBe(0);
  });
});
