/**
 * cinatra#2536 — the install-record repair and its diagnostics
 * (hosted in `src/lib/extension-install-anchor.ts` — see the section banner
 * there for why it is not its own module).
 *
 * The repair is what turns "already up to date while the install record is
 * ABSENT" from a permanent broken state into a self-healing one, so its
 * BOUNDARIES are the contract: it seeds a row ONLY for a package whose on-disk
 * manifest proves the identity, it NEVER resurrects an archived (deliberately
 * uninstalled) row, it fails CLOSED on an unreadable canonical store, and a
 * second fire writes nothing at all.
 *
 * The diagnostics half pins the copy: a materialization failure caused by a
 * missing install record must name what is missing and how it heals, and must
 * NOT tell a developer to edit a manifest that is already correct.
 *
 * Run: pnpm exec vitest run src/lib/__tests__/extension-install-record-heal.anchor.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  explainAbsentArtifactSafeClaims,
  healArtifactInstallRecordAndClaims,
  healLeftRecordLive,
  healMissingInstallRecord,
  probeInstallRecord,
  type InstallRecordHealDeps,
} from "@/lib/extension-install-anchor";

const PKG = "@cinatra-ai/blog-post-artifact";
const DIR = "/extensions/cinatra-ai/blog-post-artifact";

const MANIFEST = JSON.stringify({
  name: PKG,
  version: "0.1.4",
  cinatra: { kind: "artifact" },
});

/** A canonical row as the fixtures write it; the store's own defaults
 *  (`kind` from the package, `is_default` NOT NULL DEFAULT true) are filled in
 *  below so a case only states what it is actually about. */
type Row = {
  id: string;
  status: string;
  organizationId: string | null;
  kind?: string | null;
  isDefault?: boolean;
  version?: string | null;
};

function deps(input: {
  rows?: Row[] | (() => Row[]);
  readRowsThrows?: string;
  manifest?: string;
  manifestThrows?: boolean;
  installThrows?: string;
}): InstallRecordHealDeps & { installed: unknown[] } {
  const installed: unknown[] = [];
  return {
    installed,
    readRows: async () => {
      if (input.readRowsThrows) throw new Error(input.readRowsThrows);
      const r = input.rows ?? [];
      return (typeof r === "function" ? r() : r).map((row) => ({
        ...row,
        kind: row.kind === undefined ? "artifact" : row.kind,
        isDefault: row.isDefault ?? true,
        version: row.version ?? null,
      }));
    },
    readManifest: async () => {
      if (input.manifestThrows) throw new Error("EACCES");
      return input.manifest ?? MANIFEST;
    },
    installRow: async (row) => {
      if (input.installThrows) throw new Error(input.installThrows);
      installed.push(row);
    },
  };
}

let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  delete process.env.CINATRA_DISABLE_INSTALL_RECORD_HEAL;
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warnSpy.mockRestore();
});

describe("probeInstallRecord", () => {
  it("no rows → absent", async () => {
    await expect(probeInstallRecord(PKG, deps({ rows: [] }))).resolves.toEqual({ state: "absent" });
  });

  it("an active PLATFORM row → live (the ambient anchor every org's chain sees)", async () => {
    await expect(
      probeInstallRecord(PKG, deps({ rows: [{ id: "iext_1", status: "active", organizationId: null }] })),
    ).resolves.toMatchObject({ state: "live", rowId: "iext_1", scope: "platform" });
  });

  it("SCOPE: a live row belonging to ANOTHER org is NOT 'live' for the anchor view", async () => {
    // The access chain admits an org's own live row, else an AMBIENT platform
    // one — never another org's. A scope-blind probe reported "live" here and
    // suppressed the platform anchor the repair exists to seed.
    await expect(
      probeInstallRecord(PKG, deps({ rows: [{ id: "iext_b", status: "active", organizationId: "org_b" }] })),
    ).resolves.toEqual({ state: "live-elsewhere", organizationIds: ["org_b"] });
  });

  it("SCOPE: the same rows are 'live' for the org that OWNS them", async () => {
    await expect(
      probeInstallRecord(
        PKG,
        deps({ rows: [{ id: "iext_b", status: "active", organizationId: "org_b" }] }),
        { orgId: "org_b" },
      ),
    ).resolves.toMatchObject({ state: "live", rowId: "iext_b", scope: "organization" });
  });

  it("SCOPE: another org's live row does not make the package live for THIS org", async () => {
    await expect(
      probeInstallRecord(
        PKG,
        deps({ rows: [{ id: "iext_b", status: "active", organizationId: "org_b" }] }),
        { orgId: "org_a" },
      ),
    ).resolves.toEqual({ state: "live-elsewhere", organizationIds: ["org_b"] });
  });

  it("SCOPE: a live PLATFORM row governs an org with no row of its own", async () => {
    await expect(
      probeInstallRecord(
        PKG,
        deps({ rows: [{ id: "iext_p", status: "active", organizationId: null }] }),
        { orgId: "org_a" },
      ),
    ).resolves.toMatchObject({ state: "live", scope: "platform" });
  });

  it("SCOPE: an org's OWN archived row outranks the ambient anchor for that org", async () => {
    await expect(
      probeInstallRecord(
        PKG,
        deps({
          rows: [
            { id: "iext_a", status: "archived", organizationId: "org_a" },
            { id: "iext_b", status: "active", organizationId: "org_b" },
          ],
        }),
        { orgId: "org_a" },
      ),
    ).resolves.toMatchObject({ state: "inactive", rowId: "iext_a" });
  });

  it("a locked row is LIVE (required-in-prod installs are locked, not broken)", async () => {
    await expect(
      probeInstallRecord(PKG, deps({ rows: [{ id: "iext_1", status: "locked", organizationId: null }] })),
    ).resolves.toMatchObject({ state: "live" });
  });

  it("only archived rows → inactive", async () => {
    await expect(
      probeInstallRecord(PKG, deps({ rows: [{ id: "iext_9", status: "archived", organizationId: null }] })),
    ).resolves.toMatchObject({ state: "inactive", status: "archived" });
  });

  it("IDENTITY: a live row governing a DIFFERENT kind is not an anchor", async () => {
    // The claim backstop drops a row whose kind is not `artifact`, so calling
    // this healthy would restore the silent failure.
    await expect(
      probeInstallRecord(
        PKG,
        deps({ rows: [{ id: "iext_1", status: "active", organizationId: null, kind: "skill" }] }),
        { expectKind: "artifact" },
      ),
    ).resolves.toMatchObject({ state: "mismatched", rowId: "iext_1" });
  });

  it("IDENTITY: a live NON-DEFAULT row (side-by-side versions) is not an anchor", async () => {
    await expect(
      probeInstallRecord(
        PKG,
        deps({ rows: [{ id: "iext_v2", status: "active", organizationId: null, isDefault: false }] }),
        { expectKind: "artifact" },
      ),
    ).resolves.toMatchObject({ state: "mismatched", rowId: "iext_v2" });
  });

  it("IDENTITY: the DEFAULT row among side-by-side siblings anchors", async () => {
    await expect(
      probeInstallRecord(
        PKG,
        deps({
          rows: [
            { id: "iext_v2", status: "active", organizationId: null, isDefault: false, version: "0.2.0" },
            { id: "iext_v1", status: "active", organizationId: null, isDefault: true, version: "0.1.4" },
          ],
        }),
        { expectKind: "artifact" },
      ),
    ).resolves.toMatchObject({ state: "live", rowId: "iext_v1", version: "0.1.4" });
  });

  it("IDENTITY: TWO live default rows in one scope are ambiguous, not healthy", async () => {
    // `pickSingleActiveRow` — the pick the claim backstop performs — fails
    // closed on ambiguity, so accepting the first would again report a package
    // healthy whose claims can never activate.
    await expect(
      probeInstallRecord(
        PKG,
        deps({
          rows: [
            { id: "iext_1", status: "active", organizationId: null, isDefault: true },
            { id: "iext_2", status: "active", organizationId: null, isDefault: true },
          ],
        }),
        { expectKind: "artifact" },
      ),
    ).resolves.toMatchObject({ state: "mismatched" });
  });

  it("a store read failure NEVER throws — it reports unreadable so callers fail closed", async () => {
    await expect(
      probeInstallRecord(PKG, deps({ readRowsThrows: "connection refused" })),
    ).resolves.toMatchObject({ state: "unreadable", reason: "connection refused" });
  });
});

describe("healMissingInstallRecord — the repair", () => {
  it("repairs an ABSENT record: one platform-scoped local-source row at the manifest version", async () => {
    // The row only becomes readable AFTER the write, exactly like the DB.
    let written = false;
    const d = deps({ rows: () => (written ? [{ id: "iext_new", status: "active", organizationId: null }] : []) });
    const inner = d.installRow!;
    d.installRow = async (row) => {
      written = true;
      return inner(row);
    };

    const result = await healMissingInstallRecord(
      { packageName: PKG, kind: "artifact", packageDir: DIR, version: "0.1.4" },
      d,
    );

    expect(result.outcome).toBe("repaired");
    expect(result.rowId).toBe("iext_new");
    expect(healLeftRecordLive(result)).toBe(true);
    expect(d.installed).toEqual([
      { id: expect.stringMatching(/^iext_/), packageName: PKG, kind: "artifact", version: "0.1.4", sourcePath: DIR },
    ]);
  });

  it("IDEMPOTENT: a second fire against the healed record writes NOTHING", async () => {
    const d = deps({ rows: [{ id: "iext_new", status: "active", organizationId: null }] });

    const first = await healMissingInstallRecord(
      { packageName: PKG, kind: "artifact", packageDir: DIR, version: "0.1.4" },
      d,
    );
    const second = await healMissingInstallRecord(
      { packageName: PKG, kind: "artifact", packageDir: DIR, version: "0.1.4" },
      d,
    );

    expect(first.outcome).toBe("already-live");
    expect(second.outcome).toBe("already-live");
    expect(d.installed).toEqual([]);
  });

  it("NEVER resurrects an archived record", async () => {
    const d = deps({ rows: [{ id: "iext_old", status: "archived", organizationId: null }] });

    const result = await healMissingInstallRecord(
      { packageName: PKG, kind: "artifact", packageDir: DIR },
      d,
    );

    expect(result.outcome).toBe("refused-archived");
    expect(result.reason).toContain("never resurrected");
    expect(d.installed).toEqual([]);
  });

  it("NEVER broadens an org-scoped install into an instance-wide one", async () => {
    const d = deps({ rows: [{ id: "iext_b", status: "active", organizationId: "org_b" }] });

    const result = await healMissingInstallRecord(
      { packageName: PKG, kind: "artifact", packageDir: DIR },
      d,
    );

    expect(result.outcome).toBe("refused-org-scoped");
    expect(result.reason).toContain("org_b");
    expect(d.installed).toEqual([]);
  });

  it("NEVER seeds an ambient anchor over an org's archive (that would resurrect it through the chain)", async () => {
    const d = deps({
      rows: [
        { id: "iext_a", status: "archived", organizationId: "org_a" },
        { id: "iext_b", status: "active", organizationId: "org_b" },
      ],
    });

    const result = await healMissingInstallRecord(
      { packageName: PKG, kind: "artifact", packageDir: DIR },
      d,
    );

    expect(result.outcome).toBe("refused-archived");
    expect(d.installed).toEqual([]);
  });

  it("a live PLATFORM row alongside an org archive is healthy — no write", async () => {
    const d = deps({
      rows: [
        { id: "iext_p", status: "active", organizationId: null },
        { id: "iext_a", status: "archived", organizationId: "org_a" },
      ],
    });

    const result = await healMissingInstallRecord(
      { packageName: PKG, kind: "artifact", packageDir: DIR },
      d,
    );

    expect(result.outcome).toBe("already-live");
    expect(result.rowId).toBe("iext_p");
    expect(d.installed).toEqual([]);
  });

  it("refuses (never claims healthy) when the identity slot holds a row that cannot anchor", async () => {
    const d = deps({
      rows: [{ id: "iext_1", status: "active", organizationId: null, kind: "skill" }],
    });

    const result = await healMissingInstallRecord(
      { packageName: PKG, kind: "artifact", packageDir: DIR },
      d,
    );

    expect(result.outcome).toBe("refused-mismatched-row");
    expect(healLeftRecordLive(result)).toBe(false);
    expect(d.installed).toEqual([]);
  });

  it("fails CLOSED on an unreadable canonical store (a transient read must not mint a duplicate row)", async () => {
    const d = deps({ readRowsThrows: "ECONNREFUSED" });

    const result = await healMissingInstallRecord(
      { packageName: PKG, kind: "artifact", packageDir: DIR },
      d,
    );

    expect(result.outcome).toBe("refused-unreadable");
    expect(d.installed).toEqual([]);
  });

  it("refuses a package whose on-disk manifest names something else (identity is proven, not asserted)", async () => {
    const d = deps({ rows: [], manifest: JSON.stringify({ name: "@evil/other", version: "9.9.9" }) });

    const result = await healMissingInstallRecord(
      { packageName: PKG, kind: "artifact", packageDir: DIR },
      d,
    );

    expect(result.outcome).toBe("refused-unverified");
    expect(d.installed).toEqual([]);
  });

  it("refuses a manifest whose declared cinatra.kind contradicts the caller", async () => {
    const d = deps({
      rows: [],
      manifest: JSON.stringify({ name: PKG, version: "0.1.4", cinatra: { kind: "skill" } }),
    });

    const result = await healMissingInstallRecord(
      { packageName: PKG, kind: "artifact", packageDir: DIR },
      d,
    );

    expect(result.outcome).toBe("refused-unverified");
    expect(d.installed).toEqual([]);
  });

  it("refuses when no on-disk dir is supplied at all", async () => {
    const d = deps({ rows: [] });
    const result = await healMissingInstallRecord({ packageName: PKG, kind: "agent" }, d);
    expect(result.outcome).toBe("refused-unverified");
    expect(d.installed).toEqual([]);
  });

  it("refuses when an unreadable manifest cannot prove the identity", async () => {
    const d = deps({ rows: [], manifestThrows: true });
    const result = await healMissingInstallRecord(
      { packageName: PKG, kind: "artifact", packageDir: DIR },
      d,
    );
    expect(result.outcome).toBe("refused-unverified");
    expect(d.installed).toEqual([]);
  });

  it("an INSERT RACE that ends with a live row is a success, not a failure", async () => {
    let raced = false;
    const d = deps({
      rows: () => (raced ? [{ id: "iext_other_boot", status: "active", organizationId: null }] : []),
      installThrows: "duplicate key value violates unique constraint",
    });
    const throwingInstall = d.installRow!;
    d.installRow = async (row) => {
      raced = true; // another boot won the identity slot
      return throwingInstall(row);
    };

    const result = await healMissingInstallRecord(
      { packageName: PKG, kind: "artifact", packageDir: DIR },
      d,
    );

    expect(result.outcome).toBe("already-live");
    expect(result.rowId).toBe("iext_other_boot");
  });

  it("reports failed when the write throws and no row appears", async () => {
    const d = deps({ rows: [], installThrows: "permission denied" });
    const result = await healMissingInstallRecord(
      { packageName: PKG, kind: "artifact", packageDir: DIR },
      d,
    );
    expect(result.outcome).toBe("failed");
    expect(result.reason).toContain("permission denied");
  });

  it("is kill-switchable", async () => {
    process.env.CINATRA_DISABLE_INSTALL_RECORD_HEAL = "true";
    const d = deps({ rows: [] });
    const result = await healMissingInstallRecord(
      { packageName: PKG, kind: "artifact", packageDir: DIR },
      d,
    );
    expect(result.outcome).toBe("refused-disabled");
    expect(d.installed).toEqual([]);
  });
});

describe("healArtifactInstallRecordAndClaims — version applicability", () => {
  it("a pre-existing install at a DIFFERENT version is not-applicable, not a false alarm", async () => {
    // The claim backstop's stale-record fence legitimately refuses to activate
    // from a dir describing another version; warning about it on every boot
    // would be noise, so it is reported as not-applicable (and stays quiet).
    const d = deps({
      rows: [{ id: "iext_1", status: "active", organizationId: null, version: "0.1.3" }],
    });

    const result = await healArtifactInstallRecordAndClaims(
      { packageName: PKG, packageDir: DIR, version: "0.1.4" },
      d,
    );

    expect(result.record.outcome).toBe("already-live");
    expect(result.claims).toBe("not-applicable");
    expect(result.detail).toContain("0.1.3");
    expect(d.installed).toEqual([]);
  });

  it("a refused record never runs the claim pass", async () => {
    const d = deps({ rows: [{ id: "iext_1", status: "archived", organizationId: null }] });

    const result = await healArtifactInstallRecordAndClaims(
      { packageName: PKG, packageDir: DIR, version: "0.1.4" },
      d,
    );

    expect(result.record.outcome).toBe("refused-archived");
    expect(result.claims).toBe("skipped");
  });
});

describe("readInstallRecordRows — live provenance precedence", () => {
  it("reads source.version FIRST (the column can lag an update)", async () => {
    // Same precedence the claim backstop's fence uses; reading the column alone
    // would make the heal treat a freshly-updated install as another version.
    vi.doMock("@cinatra-ai/extensions/canonical-store", () => ({
      readInstalledExtensionsByPackageName: async () => [
        {
          id: "iext_1",
          status: "active",
          organizationId: null,
          kind: "artifact",
          isDefault: true,
          version: "0.1.3", // the lagging COLUMN
          source: { type: "verdaccio", version: "0.1.4" }, // the LIVE provenance
        },
      ],
    }));
    const { readInstallRecordRows: read } = await import("@/lib/extension-install-anchor");

    await expect(read(PKG)).resolves.toEqual([
      { id: "iext_1", status: "active", organizationId: null, kind: "artifact", isDefault: true, version: "0.1.4" },
    ]);
    vi.doUnmock("@cinatra-ai/extensions/canonical-store");
  });
});

describe("explainAbsentArtifactSafeClaims — the corrected diagnostics copy", () => {
  const MANIFEST_BLAME = "declare a produces/binding objectTypeId";

  it("ABSENT record: names the missing install record and how it heals — never the manifest", async () => {
    const msg = await explainAbsentArtifactSafeClaims(
      { orgId: "org_1", extension: PKG, declaredObjectTypeIds: [`${PKG}:post`] },
      deps({ rows: [] }),
    );

    expect(msg).toContain("no installed_extension row exists");
    expect(msg).toContain(`${PKG}:post`);
    expect(msg).toContain('org "org_1"');
    expect(msg).toContain("The extension manifest is not at fault");
    expect(msg).not.toContain(MANIFEST_BLAME);
  });

  it("ARCHIVED record: says the install was archived and points at restore", async () => {
    const msg = await explainAbsentArtifactSafeClaims(
      { orgId: "org_1", extension: PKG, declaredObjectTypeIds: [`${PKG}:post`] },
      deps({ rows: [{ id: "iext_old", status: "archived", organizationId: null }] }),
    );

    expect(msg).toContain("'archived'");
    expect(msg).toContain("restore/reinstall");
    expect(msg).not.toContain(MANIFEST_BLAME);
  });

  it("LIVE record but no claim: the exact wording the issue asks for", async () => {
    const msg = await explainAbsentArtifactSafeClaims(
      { orgId: "org_1", extension: PKG, declaredObjectTypeIds: [`${PKG}:post`] },
      deps({ rows: [{ id: "iext_1", status: "active", organizationId: null }] }),
    );

    expect(msg).toContain(`no active artifact-safe claim for "${PKG}:post" in org "org_1"`);
    expect(msg).toContain("extension install/activation incomplete");
    expect(msg).not.toContain(MANIFEST_BLAME);
  });

  it("LIVE ONLY IN ANOTHER ORG: tells this org to install it, never 'just restart'", async () => {
    // Scope-blind, this org was told a live row exists and a restart would heal
    // it — advice that is a no-op forever (codex round 1, High).
    const msg = await explainAbsentArtifactSafeClaims(
      { orgId: "org_a", extension: PKG, declaredObjectTypeIds: [`${PKG}:post`] },
      deps({ rows: [{ id: "iext_b", status: "active", organizationId: "org_b" }] }),
    );

    expect(msg).toContain("installed only in organization(s) [org_b]");
    expect(msg).toContain("install the extension for THIS organization");
    expect(msg).toContain("a restart cannot fix it");
    expect(msg).not.toContain(MANIFEST_BLAME);
  });

  it("does NOT assert the manifest is fine when its declarations could not be read", async () => {
    // Claiming "the manifest is not at fault" without having read it would be
    // its own false lead when the pack manifest is malformed (codex round 3).
    const msg = await explainAbsentArtifactSafeClaims(
      { orgId: "org_1", extension: PKG },
      deps({ rows: [] }),
    );

    expect(msg).toContain("could not be read/validated from this instance");
    expect(msg).not.toContain("The extension manifest is not at fault.");
    expect(msg).not.toContain(MANIFEST_BLAME);
  });

  it("an unreadable store still blames the install/store, not the manifest", async () => {
    const msg = await explainAbsentArtifactSafeClaims(
      { orgId: "org_1", extension: PKG },
      deps({ readRowsThrows: "ECONNREFUSED" }),
    );

    expect(msg).toContain("install state could not be read");
    expect(msg).not.toContain(MANIFEST_BLAME);
  });
});
