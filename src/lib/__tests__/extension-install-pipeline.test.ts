import { describe, it, expect, afterEach } from "vitest";
import { resolveInstallAnchor, pickSingleActiveRow, type ResolveInstallAnchorDeps } from "@/lib/extension-install-anchor";
import { installExtensionFromRegistry, type InstallPipelineDeps } from "@/lib/extension-install-pipeline";
import { generateExtensionSigningKeyPair, signExtension } from "@/lib/extension-signature";
import { computeRequestedPortsHash } from "@/lib/extension-host-port-grants";

const REGISTRY = "https://registry.cinatra.ai";

describe("resolveInstallAnchor (closes the runtime-loader trust loop)", () => {
  const base: ResolveInstallAnchorDeps = {
    readActiveInstall: async () => ({
      status: "active",
      source: { type: "verdaccio", registryUrl: REGISTRY, integrity: "sha512-abc", contentHash: "deadbeef" },
    }),
    readGrant: async () => ({ status: "approved", approvedPorts: ["settings"], orgId: null }),
    // PRIMARY journal gate satisfied by default so the legacy cases keep asserting
    // the integrity/grant behavior; the journal-specific cases override it.
    readInstallOp: async () => ({ phase: "finalized" }),
  };

  it("returns a full anchor for an active real-pipeline install with an approved grant", async () => {
    const a = await resolveInstallAnchor("@cinatra-ai/foo", base);
    expect(a).toEqual({
      integrity: "sha512-abc",
      contentHash: "deadbeef",
      registryUrl: REGISTRY,
      trustDecision: true,
      approvedPorts: ["settings"],
      version: null,
      signature: null,
    });
  });

  it("returns null for a legacy/dispatcher row (placeholder integrity / no content hash)", async () => {
    expect(
      await resolveInstallAnchor("@cinatra-ai/foo", {
        ...base,
        readActiveInstall: async () => ({ status: "active", source: { type: "verdaccio", registryUrl: REGISTRY, integrity: "dispatcher-install" } }),
      }),
    ).toBeNull();
    expect(
      await resolveInstallAnchor("@cinatra-ai/foo", {
        ...base,
        readActiveInstall: async () => ({ status: "active", source: { type: "verdaccio", registryUrl: REGISTRY, integrity: "sha512-abc" } }), // no contentHash
      }),
    ).toBeNull();
  });

  it("returns null when there is no active install row", async () => {
    expect(await resolveInstallAnchor("@cinatra-ai/foo", { ...base, readActiveInstall: async () => null })).toBeNull();
    expect(
      await resolveInstallAnchor("@cinatra-ai/foo", {
        ...base,
        readActiveInstall: async () => ({ status: "archived", source: { type: "verdaccio", integrity: "sha512-x", contentHash: "y" } }),
      }),
    ).toBeNull();
  });

  it("CAPABILITY SPLIT: a PENDING port grant keeps trustDecision TRUE (import-trusted) with ZERO approved ports", async () => {
    // The persisted host trust decision (import-trust) is DECOUPLED
    // from the port grant. An unsigned bootstrap install the pipeline left
    // `pending` must still import (trustDecision stays true) — it just carries no
    // approved ports. Tying trustDecision to grant approval (the pre-fix bug)
    // would wrongly refuse the very bootstrap package the design says must import.
    const a = await resolveInstallAnchor("@cinatra-ai/foo", { ...base, readGrant: async () => ({ status: "pending", approvedPorts: [], orgId: null }) });
    expect(a?.trustDecision).toBe(true);
    expect(a?.approvedPorts).toEqual([]);
  });

  it("CAPABILITY SPLIT: a pending grant that names ports still yields ZERO approved ports (no silent self-grant)", async () => {
    // Defense-in-depth: even if a pending grant row somehow lists ports, an
    // unapproved grant must contribute NONE to approvedPorts.
    const a = await resolveInstallAnchor("@cinatra-ai/foo", { ...base, readGrant: async () => ({ status: "pending", approvedPorts: ["secrets"], orgId: null }) });
    expect(a?.trustDecision).toBe(true);
    expect(a?.approvedPorts).toEqual([]);
  });

  it("approved-with-zero-ports is still trusted (no ports requested)", async () => {
    const a = await resolveInstallAnchor("@cinatra-ai/foo", { ...base, readGrant: async () => ({ status: "approved", approvedPorts: [], orgId: null }) });
    expect(a?.trustDecision).toBe(true);
    expect(a?.approvedPorts).toEqual([]);
  });

  // PRIMARY journal gate — the install-op phase is the authority.
  it("returns null when the install-op journal phase is NOT 'finalized' (half-install)", async () => {
    for (const phase of ["materialized", "granted", "preflighted", "failed", "rolled_back"]) {
      expect(
        await resolveInstallAnchor("@cinatra-ai/foo", { ...base, readInstallOp: async () => ({ phase }) }),
      ).toBeNull();
    }
  });

  it("returns null when there is NO install-op journal row at all", async () => {
    expect(await resolveInstallAnchor("@cinatra-ai/foo", { ...base, readInstallOp: async () => null })).toBeNull();
  });

  it("returns null when the journal reader is absent (pure-fail-closed)", async () => {
    const { readInstallOp: _omit, ...noJournal } = base;
    void _omit;
    expect(await resolveInstallAnchor("@cinatra-ai/foo", noJournal)).toBeNull();
  });

  it("resolves a full anchor only when the journal phase is 'finalized'", async () => {
    const a = await resolveInstallAnchor("@cinatra-ai/foo", { ...base, readInstallOp: async () => ({ phase: "finalized" }) });
    expect(a?.integrity).toBe("sha512-abc");
    expect(a?.trustDecision).toBe(true);
  });

  it("threads the configured orgId to every scoped read (source + journal + grant resolve the SAME scope)", async () => {
    const seen: { active?: string | null; grant?: string | null; op?: string | null } = {};
    const anchor = await resolveInstallAnchor("@cinatra-ai/foo", {
      orgId: "org-42",
      readActiveInstall: async (_pkg, oid) => {
        seen.active = oid;
        return { status: "active", source: { type: "verdaccio", registryUrl: REGISTRY, integrity: "sha512-abc", contentHash: "ch" } };
      },
      readGrant: async (_pkg, oid) => {
        seen.grant = oid;
        return { status: "approved", approvedPorts: ["ui"], orgId: oid };
      },
      readInstallOp: async (_pkg, oid) => {
        seen.op = oid;
        return { phase: "finalized" };
      },
    });
    expect(seen).toEqual({ active: "org-42", grant: "org-42", op: "org-42" });
    expect(anchor?.trustDecision).toBe(true);
    expect(anchor?.approvedPorts).toEqual(["ui"]);
  });

  it("refuses to inherit a GLOBAL grant for an org-scoped install (no cross-scope port escalation)", async () => {
    // org-1 has an active source + finalized journal, but ONLY a global
    // (org_id IS NULL) approved grant exists — the org install is still
    // import-trusted (the install record IS the persisted decision),
    // but it must NOT inherit the global grant's PORTS.
    const anchor = await resolveInstallAnchor("@cinatra-ai/foo", {
      orgId: "org-1",
      readActiveInstall: async () => ({ status: "active", source: { type: "verdaccio", registryUrl: REGISTRY, integrity: "sha512-abc", contentHash: "ch" } }),
      readInstallOp: async () => ({ phase: "finalized" }),
      readGrant: async () => ({ status: "approved", approvedPorts: ["db", "secrets"], orgId: null }),
    });
    expect(anchor?.trustDecision).toBe(true); // import-trust is decoupled from the port grant
    expect(anchor?.approvedPorts).toEqual([]); // but ZERO ports cross the org boundary
  });
});

describe("pickSingleActiveRow (fail-closed canonical-row resolution)", () => {
  const r = (id: string, status: string, organizationId: string | null) => ({ id, status, organizationId });
  it("returns the single active row for the exact org scope", () => {
    expect(pickSingleActiveRow([r("a", "active", "org-1")], "org-1")?.id).toBe("a");
  });
  it("returns null when none match the org", () => {
    expect(pickSingleActiveRow([r("a", "active", "org-2")], "org-1")).toBeNull();
    expect(pickSingleActiveRow([], "org-1")).toBeNull();
  });
  it("fails CLOSED (null) on ambiguous >1 active rows in the same scope", () => {
    expect(pickSingleActiveRow([r("a", "active", "org-1"), r("b", "active", "org-1")], "org-1")).toBeNull();
  });
  it("ignores non-active rows when counting", () => {
    expect(pickSingleActiveRow([r("a", "active", "org-1"), r("b", "archived", "org-1")], "org-1")?.id).toBe("a");
  });
  it("matches the global (null-org) scope distinctly from any org", () => {
    expect(pickSingleActiveRow([r("g", "active", null), r("o", "active", "org-1")], null)?.id).toBe("g");
  });
});

describe("installExtensionFromRegistry — capability split (signed auto-grants; bootstrap stays pending)", () => {
  // Default deps: an UNSIGNED package from the trusted marketplace host. Under the
  // capability split this is `trusted-bootstrap` → imports, but its ports
  // stay PENDING and its DDL does not auto-run.
  function fakeDeps(overrides: Partial<InstallPipelineDeps> = {}) {
    const order: string[] = [];
    const calls = {
      provenance: [] as unknown[],
      requested: [] as unknown[],
      approved: [] as unknown[],
      journal: [] as Array<{ kind: string; phase?: string }>,
    };
    const deps: InstallPipelineDeps = {
      resolveIntegrity: async () => ({ integrity: "sha512-abc", registryUrl: REGISTRY }),
      materialize: async () => ({ storeDir: "/store/foo/digest", digest: "digest", integrity: "sha512-abc", contentHash: "ch" }),
      readRequestedPorts: async () => ["settings", "secrets"],
      recordProvenance: async (i) => { order.push("provenance"); calls.provenance.push(i); },
      recordRequestedGrant: async (i) => { order.push("requested"); calls.requested.push(i); },
      approveGrant: async (i) => { order.push("approved"); calls.approved.push(i); },
      beginInstallOp: async () => { order.push("begin"); calls.journal.push({ kind: "begin" }); },
      advanceInstallOpPhase: async (i) => { order.push(`phase:${i.phase}`); calls.journal.push({ kind: "advance", phase: i.phase }); },
      ...overrides,
    };
    return { deps, calls, order };
  }

  // Make a package `trusted-signed`: produce a valid Ed25519 signature over
  // {packageName, version, integrity} and register the matching public key so
  // `resolveSignatureVerdict` (read by the pipeline) returns true.
  function withSignedDeps(
    packageName: string,
    version: string,
    integrity: string,
    overrides: Partial<InstallPipelineDeps> = {},
  ) {
    const kp = generateExtensionSigningKeyPair();
    const signature = signExtension({ packageName, version, integrity }, kp.privateKeyPkcs8DerB64);
    process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS = kp.publicKeyDerB64;
    return fakeDeps({
      resolveIntegrity: async () => ({ integrity, registryUrl: REGISTRY, signature }),
      ...overrides,
    });
  }

  afterEach(() => {
    delete process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS;
    delete process.env.CINATRA_EXTENSION_REQUIRE_SIGNATURES;
  });

  it("AUTO-APPROVES a trusted-SIGNED package and carries the signature into provenance", async () => {
    const { deps, calls } = withSignedDeps("@cinatra-ai/foo", "1.0.0", "sha512-abc");
    const r = await installExtensionFromRegistry({ packageName: "@cinatra-ai/foo", version: "1.0.0", orgId: null, actorUserId: "u1" }, deps);
    expect(r.grantStatus).toBe("approved");
    expect(calls.approved).toEqual([{ packageName: "@cinatra-ai/foo", orgId: null, approvedPorts: ["settings", "secrets"], requestedPorts: ["settings", "secrets"], approvedBy: "u1" }]);
    expect(calls.requested).toEqual([{ packageName: "@cinatra-ai/foo", orgId: null, requestedPorts: ["settings", "secrets"] }]);
    expect(calls.provenance).toHaveLength(1);
    expect(calls.provenance[0]).toMatchObject({ packageName: "@cinatra-ai/foo", integrity: "sha512-abc", contentHash: "ch", signature: expect.any(String) });
  });

  it("CAPABILITY SPLIT: an UNSIGNED bootstrap-trusted package stays PENDING (no privileged self-grant) but still finalizes", async () => {
    const { deps, calls } = fakeDeps();
    const r = await installExtensionFromRegistry({ packageName: "@cinatra-ai/foo", version: "1.0.0", orgId: null }, deps);
    expect(r.grantStatus).toBe("pending");
    expect(calls.approved).toEqual([]);
    expect(calls.requested).toHaveLength(1);
    expect(calls.provenance).toHaveLength(1);
    expect(calls.journal).toEqual([
      { kind: "begin" },
      { kind: "advance", phase: "granted" },
      { kind: "advance", phase: "finalized" },
    ]);
  });

  it("CAPABILITY SPLIT: a SIGNED package runs its declared host DDL (applyMigrations)", async () => {
    const migrated: unknown[] = [];
    const { deps } = withSignedDeps("@cinatra-ai/foo", "1.0.0", "sha512-abc", {
      applyMigrations: async (i) => { migrated.push(i); },
    });
    await installExtensionFromRegistry({ packageName: "@cinatra-ai/foo", version: "1.0.0", orgId: null }, deps);
    expect(migrated).toHaveLength(1);
  });

  it("CAPABILITY SPLIT: an UNSIGNED bootstrap package runs NO host DDL (applyMigrations NOT called)", async () => {
    const migrated: unknown[] = [];
    const { deps } = fakeDeps({ applyMigrations: async (i) => { migrated.push(i); } });
    await installExtensionFromRegistry({ packageName: "@cinatra-ai/foo", version: "1.0.0", orgId: null }, deps);
    expect(migrated).toEqual([]);
  });

  it("writes recordProvenance LATE — AFTER the requested grant + the auto-approve, just before finalize (signed)", async () => {
    const { deps, order } = withSignedDeps("@cinatra-ai/foo", "1.0.0", "sha512-abc");
    await installExtensionFromRegistry({ packageName: "@cinatra-ai/foo", version: "1.0.0", orgId: null }, deps);
    const provIdx = order.indexOf("provenance");
    expect(order.indexOf("requested")).toBeLessThan(provIdx);
    expect(order.indexOf("approved")).toBeLessThan(provIdx);
    expect(provIdx).toBeLessThan(order.indexOf("phase:finalized"));
    expect(order.indexOf("phase:finalized")).toBe(order.length - 1);
    expect(order.indexOf("begin")).toBeLessThan(order.indexOf("requested"));
  });

  it("drives the journal phases begin → granted → finalized in order (bootstrap)", async () => {
    const { deps, calls } = fakeDeps();
    await installExtensionFromRegistry({ packageName: "@cinatra-ai/foo", version: "1.0.0", orgId: null }, deps);
    expect(calls.journal).toEqual([
      { kind: "begin" },
      { kind: "advance", phase: "granted" },
      { kind: "advance", phase: "finalized" },
    ]);
  });

  it("SIGNATURE PROPAGATION: a dist-tag install binds the RESOLVED version (signature + provenance + result), not the caller's tag", async () => {
    // resolveIntegrity resolves the "latest" tag to the concrete 2.0.0 and returns
    // a signature over the RESOLVED version. Register the matching key: the verdict
    // must verify the payload bound to "2.0.0" (a payload bound to "latest" would
    // NOT verify), so an `approved` grant proves the pipeline used resolvedVersion.
    const kp = generateExtensionSigningKeyPair();
    const signature = signExtension({ packageName: "@cinatra-ai/foo", version: "2.0.0", integrity: "sha512-abc" }, kp.privateKeyPkcs8DerB64);
    process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS = kp.publicKeyDerB64;
    const { deps, calls } = fakeDeps({
      resolveIntegrity: async () => ({ integrity: "sha512-abc", registryUrl: REGISTRY, signature, resolvedVersion: "2.0.0" }),
    });
    const r = await installExtensionFromRegistry({ packageName: "@cinatra-ai/foo", version: "latest", orgId: null, actorUserId: "u1" }, deps);
    expect(r.version).toBe("2.0.0"); // the RESOLVED version, not "latest"
    expect(r.grantStatus).toBe("approved"); // signed against the resolved-version payload
    expect(calls.provenance[0]).toMatchObject({ version: "2.0.0", signature: expect.any(String) });
  });

  it("carries an additive attestedSha256 through to recordProvenance when resolveIntegrity returns one", async () => {
    const { deps, calls } = fakeDeps({ resolveIntegrity: async () => ({ integrity: "sha512-abc", registryUrl: REGISTRY, sha256: "abc123" }) });
    await installExtensionFromRegistry({ packageName: "@cinatra-ai/foo", version: "1.0.0", orgId: null }, deps);
    expect(calls.provenance).toEqual([
      { packageName: "@cinatra-ai/foo", orgId: null, version: "1.0.0", registryUrl: REGISTRY, integrity: "sha512-abc", contentHash: "ch", attestedSha256: "abc123" },
    ]);
  });

  it("leaves a package from a NON-trusted-activation-host registry PENDING (untrusted — not even bootstrap)", async () => {
    const { deps, calls } = fakeDeps({ resolveIntegrity: async () => ({ integrity: "sha512-abc", registryUrl: "https://evil.example" }) });
    const r = await installExtensionFromRegistry({ packageName: "@cinatra-ai/foo", version: "1.0.0", orgId: null }, deps);
    expect(r.grantStatus).toBe("pending");
    expect(calls.approved).toEqual([]);
  });

  it("propagates the materialized provenance into the result", async () => {
    const { deps } = fakeDeps();
    const r = await installExtensionFromRegistry({ packageName: "@cinatra-ai/foo", version: "1.0.0", orgId: "org1" }, deps);
    expect(r).toMatchObject({ storeDir: "/store/foo/digest", integrity: "sha512-abc", contentHash: "ch", requestedPorts: ["settings", "secrets"] });
  });

  it("works with the journal hooks omitted (optional deps are a no-op); signed → approved", async () => {
    const { deps } = withSignedDeps("@cinatra-ai/foo", "1.0.0", "sha512-abc", { beginInstallOp: undefined, advanceInstallOpPhase: undefined });
    const r = await installExtensionFromRegistry({ packageName: "@cinatra-ai/foo", version: "1.0.0", orgId: null }, deps);
    expect(r.grantStatus).toBe("approved");
  });
});

describe("installExtensionFromRegistry — journal compensation on a FAILED hot-update", () => {
  // A DI-faked install-op journal store: one row per (package, org) with begin
  // UPSERT semantics (mirrors the real store), so the RESTORE of a prior finalized
  // op is OBSERVABLE. `readInstallOp` returns the live (package, org) row.
  function fakeJournal(seed?: { installOpId: string; phase: string; digest: string | null }) {
    const key = (pkg: string, org: string | null) => `${pkg}::${org ?? "(global)"}`;
    const rows = new Map<string, { installOpId: string; phase: string; digest: string | null }>();
    if (seed) rows.set(key("@cinatra-ai/foo", null), { ...seed });
    const begins: Array<{ installOpId: string; phase: string; digest: string | null }> = [];
    const advances: Array<{ installOpId: string; phase: string }> = [];

    const journalDeps: Partial<InstallPipelineDeps> = {
      // begin UPSERTs the single (package, org) row to the new op id + phase.
      beginInstallOp: async (i) => {
        rows.set(key(i.packageName, i.orgId), { installOpId: i.installOpId, phase: "materialized", digest: i.digest ?? null });
        begins.push({ installOpId: i.installOpId, phase: "materialized", digest: i.digest ?? null });
      },
      // advance matches by install_op_id (the real store does too).
      advanceInstallOpPhase: async (i) => {
        for (const row of rows.values()) if (row.installOpId === i.installOpId) row.phase = i.phase;
        advances.push({ installOpId: i.installOpId, phase: i.phase });
      },
      readInstallOp: async (pkg, org) => {
        const row = rows.get(key(pkg, org));
        return row ? { installOpId: row.installOpId, phase: row.phase, digest: row.digest } : null;
      },
    };
    return { journalDeps, rows, begins, advances, key };
  }

  function baseDeps(over: Partial<InstallPipelineDeps>): InstallPipelineDeps {
    return {
      resolveIntegrity: async () => ({ integrity: "sha512-new", registryUrl: REGISTRY }),
      materialize: async () => ({ storeDir: "/store/foo/new-digest", digest: "new-digest", integrity: "sha512-new", contentHash: "ch-new" }),
      readRequestedPorts: async () => ["settings"],
      recordProvenance: async () => {},
      recordRequestedGrant: async () => {},
      approveGrant: async () => {},
      ...over,
    };
  }

  afterEach(() => {
    delete process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS;
    delete process.env.CINATRA_EXTENSION_REQUIRE_SIGNATURES;
  });

  it("RESTORES the prior finalized op when recordProvenance throws on an UPDATE (old install stays anchorable)", async () => {
    const { journalDeps, rows, begins, advances, key } = fakeJournal({ installOpId: "old-op", phase: "finalized", digest: "old-digest" });
    const deps = baseDeps({
      ...journalDeps,
      recordProvenance: async () => { throw new Error("provenance write failed mid-update"); },
    });

    await expect(
      installExtensionFromRegistry({ packageName: "@cinatra-ai/foo", version: "2.0.0", orgId: null }, deps),
    ).rejects.toThrow("provenance write failed mid-update");

    // The (package, org) journal row is the OLD op id, re-finalized — so
    // resolveInstallAnchor (requires phase 'finalized') still anchors the OLD install.
    const row = rows.get(key("@cinatra-ai/foo", null));
    expect(row).toEqual({ installOpId: "old-op", phase: "finalized", digest: "old-digest" });
    // The restore re-created the prior op at its ORIGINAL id + digest, then re-finalized it.
    expect(begins).toContainEqual({ installOpId: "old-op", phase: "materialized", digest: "old-digest" });
    expect(advances).toContainEqual({ installOpId: "old-op", phase: "finalized" });
  });

  it("HIGH 2: a pre-finalize throw AFTER the grant mutation on an UPDATE restores BOTH the OLD finalized journal op AND the OLD grant row", async () => {
    // recordProvenance throws AFTER recordRequestedGrant (which, here, CHANGES the
    // requested-ports hash → resets the live grant to pending). Without the grant
    // restore, the previously-working OLD install would restart with the WRONG
    // (now-pending) grant. The pre-finalize compensation catch must restore BOTH the
    // journal op AND the captured prior grant (provenance is untouched pre-finalize).
    const { journalDeps, rows, advances, key } = fakeJournal({ installOpId: "old-op", phase: "finalized", digest: "old-digest" });
    const restoredGrants: unknown[] = [];
    const PRIOR_GRANT = {
      orgId: null,
      status: "approved",
      approvedPorts: ["settings"],
      requestedPortsHash: computeRequestedPortsHash(["settings", "secrets"]),
      approvedBy: "admin-old",
    };
    const deps = baseDeps({
      ...journalDeps,
      // The new install requests DIFFERENT ports than the prior grant's hash, so the
      // forward recordRequestedGrant would reset the live grant to pending.
      readRequestedPorts: async () => ["settings"],
      // CAPTURE: the OLD grant row (read BEFORE the grant mutation) — used by the
      // pre-finalize compensation catch to restore the OLD grant.
      readGrantForScope: async () => ({ ...PRIOR_GRANT }),
      restoreGrant: async (i) => { restoredGrants.push(i); },
      // The pre-finalize step that throws AFTER the grant mutation.
      recordProvenance: async () => { throw new Error("provenance write failed mid-update"); },
    });

    await expect(
      installExtensionFromRegistry({ packageName: "@cinatra-ai/foo", version: "2.0.0", orgId: null }, deps),
    ).rejects.toThrow("provenance write failed mid-update");

    // The OLD finalized journal op is restored (so resolveInstallAnchor re-anchors OLD).
    const row = rows.get(key("@cinatra-ai/foo", null));
    expect(row).toEqual({ installOpId: "old-op", phase: "finalized", digest: "old-digest" });
    expect(advances).toContainEqual({ installOpId: "old-op", phase: "finalized" });

    // AND the OLD grant row is restored to its exact captured state (HIGH 2) — so the
    // restarted OLD install carries the RIGHT grant, not the reset-to-pending one.
    expect(restoredGrants).toEqual([
      {
        packageName: "@cinatra-ai/foo",
        orgId: null,
        status: "approved",
        approvedPorts: ["settings"],
        requestedPortsHash: computeRequestedPortsHash(["settings", "secrets"]),
        approvedBy: "admin-old",
      },
    ]);
  });

  it("HIGH 2: a FRESH install pre-finalize throw does NOT restore a grant (no priorGrant captured)", async () => {
    // No prior finalized op → not an update → no priorGrant capture → restoreGrant
    // must NOT be called (there is no old grant to restore).
    const { journalDeps } = fakeJournal(/* no prior op */);
    const restoredGrants: unknown[] = [];
    const deps = baseDeps({
      ...journalDeps,
      readGrantForScope: async () => ({ orgId: null, status: "approved", approvedPorts: ["settings"], requestedPortsHash: "x", approvedBy: "a" }),
      restoreGrant: async (i) => { restoredGrants.push(i); },
      recordProvenance: async () => { throw new Error("provenance write failed on fresh install"); },
    });

    await expect(
      installExtensionFromRegistry({ packageName: "@cinatra-ai/foo", version: "1.0.0", orgId: null }, deps),
    ).rejects.toThrow("provenance write failed on fresh install");

    expect(restoredGrants, "no grant restore on a fresh-install failure").toEqual([]);
  });

  it("RESTORES the prior finalized op when approveGrant throws on an UPDATE", async () => {
    // Capability split: approveGrant only runs for a `trusted-signed`
    // package (`autoGrantPrivileged`). A bootstrap/unsigned install never calls
    // approveGrant, so to exercise THIS post-begin-failure restore path the
    // package must be SIGNED — otherwise the install would simply finalize
    // `pending` and approveGrant would never throw.
    const kp = generateExtensionSigningKeyPair();
    const signature = signExtension({ packageName: "@cinatra-ai/foo", version: "2.0.0", integrity: "sha512-new" }, kp.privateKeyPkcs8DerB64);
    process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS = kp.publicKeyDerB64;
    const { journalDeps, rows, advances, key } = fakeJournal({ installOpId: "old-op", phase: "finalized", digest: "old-digest" });
    const deps = baseDeps({
      ...journalDeps,
      resolveIntegrity: async () => ({ integrity: "sha512-new", registryUrl: REGISTRY, signature }),
      approveGrant: async () => { throw new Error("grant approval failed mid-update"); },
    });

    await expect(
      installExtensionFromRegistry({ packageName: "@cinatra-ai/foo", version: "2.0.0", orgId: null }, deps),
    ).rejects.toThrow("grant approval failed mid-update");

    const row = rows.get(key("@cinatra-ai/foo", null));
    expect(row).toEqual({ installOpId: "old-op", phase: "finalized", digest: "old-digest" });
    expect(advances).toContainEqual({ installOpId: "old-op", phase: "finalized" });
  });

  it("does NOT restore on a FRESH install post-begin failure — leaves the non-finalized row for the dispatcher", async () => {
    const { journalDeps, rows, begins, advances, key } = fakeJournal(/* no prior op */);
    const deps = baseDeps({
      ...journalDeps,
      recordProvenance: async () => { throw new Error("provenance write failed on fresh install"); },
    });

    await expect(
      installExtensionFromRegistry({ packageName: "@cinatra-ai/foo", version: "1.0.0", orgId: null }, deps),
    ).rejects.toThrow("provenance write failed on fresh install");

    // No prior finalized op to restore — the row is THIS attempt's non-finalized
    // op (the dispatcher rolls it back / re-runs it via the journal-aware check).
    // recordProvenance throws AFTER the `granted` advance, so the row sits at
    // `granted` — non-terminal, refused by the anchor, re-runnable by the dispatcher.
    const row = rows.get(key("@cinatra-ai/foo", null));
    expect(row?.phase).not.toBe("finalized");
    expect(row?.phase).toBe("granted");
    // The only begin is this fresh attempt's; nothing was "restored" (no re-finalize).
    expect(begins).toHaveLength(1);
    expect(advances).not.toContainEqual(expect.objectContaining({ phase: "finalized" }));
  });
});

describe("installExtensionFromRegistry — hot-UPDATE probe == activation's EFFECTIVE grant (HIGH fix)", () => {
  // The pre-finalize probe (`verifyActivatableBeforeFinalize`) must receive the
  // ports the NEW digest will ACTUALLY activate with — EXACTLY what activation
  // grants AFTER `recordRequestedGrant` + the anchor's exact-scope resolution.
  // The probe reads the EXACT-(package, org)-scoped grant ROW (no global fallback)
  // and counts its ports ONLY when it is approved AND its requested-ports hash
  // still matches the in-flight request:
  //   - trusted-SIGNED (autoGrantPrivileged): requestedPorts (it self-grants them);
  //   - bootstrap, exact-org approved grant + SAME requested hash: those ports;
  //   - bootstrap, exact-org approved grant but DIFFERENT requested ports: [] (the
  //     grant will be reset to pending by recordRequestedGrant);
  //   - org install with ONLY a global grant: [] (no cross-scope inheritance);
  //   - bootstrap, no grant / dep omitted: [].
  // The probe always returns `{ supersedes:true, ok:true }` here (an UPDATE that
  // activates fine) so the install finalizes; we capture the `approvedPorts` it
  // was handed.
  const REQUESTED = ["settings", "secrets"];
  // The hash the in-flight requested ports (REQUESTED) produce — a grant carrying
  // THIS hash is "unchanged" and keeps its approval; any other hash is "changed".
  const SAME_HASH = computeRequestedPortsHash(REQUESTED);
  const DIFFERENT_HASH = computeRequestedPortsHash(["settings"]); // a prior, narrower request

  type GrantRow = { orgId: string | null; status: string; approvedPorts: string[]; requestedPortsHash: string };

  function probeCapturingDeps(over: Partial<InstallPipelineDeps> = {}) {
    const probeApprovedPorts: string[][] = [];
    const deps: InstallPipelineDeps = {
      resolveIntegrity: async () => ({ integrity: "sha512-new", registryUrl: REGISTRY }),
      materialize: async () => ({ storeDir: "/store/foo/new-digest", digest: "new-digest", integrity: "sha512-new", contentHash: "ch-new" }),
      readRequestedPorts: async () => [...REQUESTED],
      recordProvenance: async () => {},
      recordRequestedGrant: async () => {},
      approveGrant: async () => {},
      // An UPDATE whose new digest activates fine — capture the ports it was probed with.
      verifyActivatableBeforeFinalize: async (i) => {
        probeApprovedPorts.push([...i.approvedPorts]);
        return { supersedes: true, ok: true };
      },
      ...over,
    };
    return { deps, probeApprovedPorts };
  }

  afterEach(() => {
    delete process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS;
    delete process.env.CINATRA_EXTENSION_REQUIRE_SIGNATURES;
  });

  it("(b) BOOTSTRAP update, exact-org grant APPROVED + SAME requested hash → probes those approved ports (== activation)", async () => {
    // The grant's stored hash matches the in-flight request, so recordRequestedGrant
    // leaves the approval untouched → activation honors it → the probe must too.
    const readScopeCalls: Array<{ packageName: string; orgId: string | null }> = [];
    const { deps, probeApprovedPorts } = probeCapturingDeps({
      readGrantForScope: async (packageName, orgId): Promise<GrantRow | null> => {
        readScopeCalls.push({ packageName, orgId });
        return { orgId: null, status: "approved", approvedPorts: ["settings"], requestedPortsHash: SAME_HASH };
      },
    });
    const r = await installExtensionFromRegistry({ packageName: "@cinatra-ai/foo", version: "2.0.0", orgId: null }, deps);
    // Bootstrap stays pending (no auto self-grant) — the intent is preserved.
    expect(r.grantStatus).toBe("pending");
    // The probe saw the EXACT-scope approved ports, NOT [].
    expect(probeApprovedPorts).toEqual([["settings"]]);
    expect(readScopeCalls).toEqual([{ packageName: "@cinatra-ai/foo", orgId: null }]);
  });

  it("(c) BOOTSTRAP update, exact-org grant APPROVED but DIFFERENT requested ports → probes [] (recordRequestedGrant will reset to pending)", async () => {
    // The in-flight request changed the requested-ports hash, so recordRequestedGrant
    // will RESET the grant to pending → activation gets no ports → the probe must be [].
    const { deps, probeApprovedPorts } = probeCapturingDeps({
      readGrantForScope: async (): Promise<GrantRow | null> => ({
        orgId: null,
        status: "approved",
        approvedPorts: ["settings"],
        requestedPortsHash: DIFFERENT_HASH,
      }),
    });
    const r = await installExtensionFromRegistry({ packageName: "@cinatra-ai/foo", version: "2.0.0", orgId: null }, deps);
    expect(r.grantStatus).toBe("pending");
    expect(probeApprovedPorts).toEqual([[]]);
  });

  it("(d) ORG-scoped install with ONLY a GLOBAL grant → probes [] (no cross-scope inheritance — matches the anchor)", async () => {
    // The exact-scope reader returns the global (org_id IS NULL) row only because
    // the test stub falls back; the pipeline must REJECT it (grant.orgId !== input.orgId)
    // exactly as resolveInstallAnchor does → []. Even though it is approved + same hash.
    const { deps, probeApprovedPorts } = probeCapturingDeps({
      readGrantForScope: async (): Promise<GrantRow | null> => ({
        orgId: null, // a GLOBAL grant — wrong scope for an org-scoped install
        status: "approved",
        approvedPorts: ["secrets"],
        requestedPortsHash: SAME_HASH,
      }),
    });
    const r = await installExtensionFromRegistry({ packageName: "@cinatra-ai/foo", version: "2.0.0", orgId: "org1" }, deps);
    expect(r.grantStatus).toBe("pending");
    expect(probeApprovedPorts).toEqual([[]]); // ZERO ports cross the org boundary
  });

  it("(e) BOOTSTRAP update, NO grant row → probes [] (genuinely pending / no ports)", async () => {
    const { deps, probeApprovedPorts } = probeCapturingDeps({
      readGrantForScope: async (): Promise<GrantRow | null> => null,
    });
    const r = await installExtensionFromRegistry({ packageName: "@cinatra-ai/foo", version: "2.0.0", orgId: null }, deps);
    expect(r.grantStatus).toBe("pending");
    expect(probeApprovedPorts).toEqual([[]]);
  });

  it("(e) BOOTSTRAP update with NO readGrantForScope dep wired (legacy) → probes [] (unchanged fallback)", async () => {
    const { deps, probeApprovedPorts } = probeCapturingDeps(); // readGrantForScope omitted
    await installExtensionFromRegistry({ packageName: "@cinatra-ai/foo", version: "2.0.0", orgId: null }, deps);
    expect(probeApprovedPorts).toEqual([[]]);
  });

  it("BOOTSTRAP update, exact-org grant PENDING (same hash) → probes [] (only an APPROVED grant counts)", async () => {
    // A pending grant carries the right hash but is not yet approved → activation
    // grants nothing → the probe must be [] (mirrors the anchor's status check).
    const { deps, probeApprovedPorts } = probeCapturingDeps({
      readGrantForScope: async (): Promise<GrantRow | null> => ({
        orgId: null,
        status: "pending",
        approvedPorts: [],
        requestedPortsHash: SAME_HASH,
      }),
    });
    await installExtensionFromRegistry({ packageName: "@cinatra-ai/foo", version: "2.0.0", orgId: null }, deps);
    expect(probeApprovedPorts).toEqual([[]]);
  });

  it("(a) SIGNED update (autoGrantPrivileged) → probes requestedPorts (unchanged), NOT the existing grant", async () => {
    // A trusted-signed package self-grants its requested ports this install, so the
    // probe must use requestedPorts — and must NOT consult readGrantForScope.
    const kp = generateExtensionSigningKeyPair();
    const signature = signExtension({ packageName: "@cinatra-ai/foo", version: "2.0.0", integrity: "sha512-new" }, kp.privateKeyPkcs8DerB64);
    process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS = kp.publicKeyDerB64;
    let readScopeCalled = false;
    const { deps, probeApprovedPorts } = probeCapturingDeps({
      resolveIntegrity: async () => ({ integrity: "sha512-new", registryUrl: REGISTRY, signature }),
      readGrantForScope: async (): Promise<GrantRow | null> => {
        readScopeCalled = true;
        return { orgId: null, status: "approved", approvedPorts: ["settings"], requestedPortsHash: SAME_HASH };
      },
    });
    const r = await installExtensionFromRegistry({ packageName: "@cinatra-ai/foo", version: "2.0.0", orgId: null, actorUserId: "u1" }, deps);
    expect(r.grantStatus).toBe("approved"); // signed → auto-granted
    expect(probeApprovedPorts).toEqual([[...REQUESTED]]);
    // The signed path uses requestedPorts directly — it never reads the existing grant.
    expect(readScopeCalled).toBe(false);
  });

  it("BOOTSTRAP update threads the orgId through to readGrantForScope (scoped resolution)", async () => {
    const readScopeCalls: Array<{ packageName: string; orgId: string | null }> = [];
    const { deps, probeApprovedPorts } = probeCapturingDeps({
      readGrantForScope: async (packageName, orgId): Promise<GrantRow | null> => {
        readScopeCalls.push({ packageName, orgId });
        // An exact-org-scoped, approved grant whose hash matches the request.
        return { orgId: "org1", status: "approved", approvedPorts: ["secrets"], requestedPortsHash: SAME_HASH };
      },
    });
    await installExtensionFromRegistry({ packageName: "@cinatra-ai/foo", version: "2.0.0", orgId: "org1" }, deps);
    expect(readScopeCalls).toEqual([{ packageName: "@cinatra-ai/foo", orgId: "org1" }]);
    expect(probeApprovedPorts).toEqual([["secrets"]]);
  });
});

// ===========================================================================
// DESIGN B — ATOMIC HOT-UPDATE WITH DURABLE-ROLLBACK-FIRST (pipeline DI).
//
// The pre-finalize probe is NO LONGER the safety boundary; the post-commit
// `activateUpdateWithRollback` is. These DI tests prove the pipeline:
//   - routes an UPDATE (prior finalized op + a superseding digest) through
//     `activateUpdateWithRollback`, NOT `activateInProcess`;
//   - CAPTURES the prior source + prior grant (BEFORE provenance overwrites them)
//     and builds a `restoreDurableAnchor` closure that re-records OLD provenance,
//     restores the OLD finalized journal op, and restores the OLD grant;
//   - surfaces `{ rolledBack:true, activated:false }` (NOT update success) when the
//     activator rolls back;
//   - leaves a FRESH install on the plain `activateInProcess` path (no rollback).
// ===========================================================================
describe("installExtensionFromRegistry — Design B durable-rollback routing + restore closure", () => {
  function updateBaseDeps(over: Partial<InstallPipelineDeps>): InstallPipelineDeps {
    return {
      resolveIntegrity: async () => ({ integrity: "sha512-new", registryUrl: REGISTRY }),
      materialize: async () => ({ storeDir: "/store/foo/new-digest", digest: "new-digest", integrity: "sha512-new", contentHash: "ch-new" }),
      readRequestedPorts: async () => ["settings"],
      recordProvenance: async () => {},
      recordRequestedGrant: async () => {},
      approveGrant: async () => {},
      beginInstallOp: async () => {},
      advanceInstallOpPhase: async () => {},
      // A prior FINALIZED op with a DIFFERENT digest = a real superseding UPDATE.
      readInstallOp: async () => ({ installOpId: "old-op", phase: "finalized", digest: "old-digest" }),
      ...over,
    };
  }

  afterEach(() => {
    delete process.env.CINATRA_EXTENSION_SIGNING_PUBLIC_KEYS;
    delete process.env.CINATRA_EXTENSION_REQUIRE_SIGNATURES;
  });

  it("UPDATE routes to activateUpdateWithRollback (NOT activateInProcess); a ROLLED-BACK update returns rolledBack:true/activated:false (NOT success)", async () => {
    let freshCalled = false;
    let updateCalled = false;
    const deps = updateBaseDeps({
      activateInProcess: async () => {
        freshCalled = true;
        return { activated: true };
      },
      activateUpdateWithRollback: async () => {
        updateCalled = true;
        // The new digest failed live activation → durable rollback to OLD.
        return { activated: false, rolledBack: true, reason: "failed:register-threw:live-only-boom" };
      },
    });
    const r = await installExtensionFromRegistry({ packageName: "@cinatra-ai/foo", version: "2.0.0", orgId: null }, deps);
    expect(updateCalled, "an UPDATE routes through the rollback activator").toBe(true);
    expect(freshCalled, "the fresh-install activator is NOT used for an update").toBe(false);
    // The install row COMMITTED (installed:true) but the UPDATE did NOT take.
    expect(r.installed).toBe(true);
    expect(r.activated).toBe(false);
    expect(r.rolledBack).toBe(true);
    expect(r.reason).toContain("register-threw:live-only-boom");
  });

  it("UPDATE with a GOOD new digest → activated:true, NOT rolledBack", async () => {
    const deps = updateBaseDeps({
      activateUpdateWithRollback: async () => ({ activated: true }),
    });
    const r = await installExtensionFromRegistry({ packageName: "@cinatra-ai/foo", version: "2.0.0", orgId: null }, deps);
    expect(r.installed).toBe(true);
    expect(r.activated).toBe(true);
    expect(r.rolledBack).toBeUndefined();
  });

  it("the restoreDurableAnchor closure re-records OLD provenance + restores the OLD finalized journal op + restores the OLD grant", async () => {
    const provenanceCalls: unknown[] = [];
    const begins: unknown[] = [];
    const advances: unknown[] = [];
    const restoredGrants: unknown[] = [];
    // recordProvenance is called once on the FORWARD path (the new source) and once
    // by the rollback (the OLD source). We distinguish by the version/integrity.
    const deps = updateBaseDeps({
      recordProvenance: async (i) => { provenanceCalls.push(i); },
      beginInstallOp: async (i) => { begins.push(i); },
      advanceInstallOpPhase: async (i) => { advances.push(i); },
      // CAPTURE: the OLD canonical source (read BEFORE the forward provenance write).
      readCurrentSource: async () => ({
        registryUrl: REGISTRY,
        version: "1.0.0",
        integrity: "sha512-old",
        contentHash: "ch-old",
        signature: "old-sig",
      }),
      // CAPTURE: the OLD approved grant.
      readGrantForScope: async () => ({
        orgId: null,
        status: "approved",
        approvedPorts: ["settings"],
        requestedPortsHash: computeRequestedPortsHash(["settings"]),
        approvedBy: "admin-old",
      }),
      restoreGrant: async (i) => { restoredGrants.push(i); },
      // The activator INVOKES the restore closure (simulating a failed new digest)
      // then reports the rollback.
      activateUpdateWithRollback: async (i) => {
        await i.restoreDurableAnchor();
        return { activated: false, rolledBack: true, reason: "failed:register-threw" };
      },
    });

    const r = await installExtensionFromRegistry({ packageName: "@cinatra-ai/foo", version: "2.0.0", orgId: null }, deps);
    expect(r.rolledBack).toBe(true);
    expect(r.activated).toBe(false);

    // recordProvenance ran TWICE: forward (new) + rollback (old). The rollback re-recorded
    // the OLD source (version 1.0.0 / sha512-old / old-sig).
    const oldProvenance = provenanceCalls.find((p) => (p as { version?: string }).version === "1.0.0");
    expect(oldProvenance, "rollback re-recorded the OLD provenance/source").toMatchObject({
      version: "1.0.0",
      integrity: "sha512-old",
      contentHash: "ch-old",
      signature: "old-sig",
    });
    // The OLD finalized journal op was restored: re-begun at its ORIGINAL id + digest,
    // then advanced to `finalized`.
    expect(begins, "OLD journal op re-begun at its original id + digest").toContainEqual(
      expect.objectContaining({ installOpId: "old-op", digest: "old-digest" }),
    );
    expect(advances, "OLD journal op re-finalized").toContainEqual({ installOpId: "old-op", phase: "finalized" });
    // The OLD grant was restored to its exact captured state.
    expect(restoredGrants).toEqual([
      {
        packageName: "@cinatra-ai/foo",
        orgId: null,
        status: "approved",
        approvedPorts: ["settings"],
        requestedPortsHash: computeRequestedPortsHash(["settings"]),
        approvedBy: "admin-old",
      },
    ]);
  });

  it("HIGH 3: a durable restore STEP failing during post-commit rollback → NOT a clean rolledBack (rollbackComplete:false), with the failed-step reason surfaced", async () => {
    // The activator forwards the closure's completeness verdict as rollbackComplete
    // (mirroring the real hotUpdateWithDurableRollback). recordProvenance throws ONLY
    // for the OLD source (the rollback re-record), so the durable restore is PARTIAL —
    // the pipeline must report rolledBack:true BUT rollbackComplete:false.
    const deps = updateBaseDeps({
      readCurrentSource: async () => ({ registryUrl: REGISTRY, version: "1.0.0", integrity: "sha512-old", contentHash: "ch-old" }),
      recordProvenance: async (i) => {
        // Forward write (the NEW source) succeeds; the rollback re-record (OLD, v1.0.0) FAILS.
        if ((i as { version?: string }).version === "1.0.0") throw new Error("old-provenance-restore-failed");
      },
      readGrantForScope: async () => ({ orgId: null, status: "approved", approvedPorts: ["settings"], requestedPortsHash: computeRequestedPortsHash(["settings"]), approvedBy: "admin-old" }),
      restoreGrant: async () => {},
      // The activator runs the restore closure + forwards its completeness verdict.
      activateUpdateWithRollback: async (i) => {
        const outcome = await i.restoreDurableAnchor();
        return { activated: false, rolledBack: true, rollbackComplete: outcome.complete, reason: `failed:register-threw${outcome.complete ? "" : ` (${outcome.reason})`}` };
      },
    });

    const r = await installExtensionFromRegistry({ packageName: "@cinatra-ai/foo", version: "2.0.0", orgId: null }, deps);
    expect(r.installed).toBe(true);
    expect(r.activated).toBe(false);
    expect(r.rolledBack).toBe(true);
    // NOT a clean rollback — the OLD provenance re-record failed.
    expect(r.rollbackComplete, "a failed restore step → NOT a clean rollback").toBe(false);
    expect(r.reason, "the failed restore step is surfaced").toContain("provenance");
  });

  it("HIGH 3: when the activator forwards rollbackComplete:false (or omits it), the pipeline fail-closes rollbackComplete to false (never a spurious clean rollback)", async () => {
    // An activator that reports a rollback but OMITS rollbackComplete must be treated
    // as INCOMPLETE (fail-closed) — never claim a clean rollback we cannot confirm.
    const deps = updateBaseDeps({
      activateUpdateWithRollback: async () => ({ activated: false, rolledBack: true, reason: "failed:register-threw" }),
    });
    const r = await installExtensionFromRegistry({ packageName: "@cinatra-ai/foo", version: "2.0.0", orgId: null }, deps);
    expect(r.rolledBack).toBe(true);
    expect(r.rollbackComplete, "an absent rollbackComplete on a rollback is fail-closed to false").toBe(false);
  });

  it("CAPTURE only happens on an UPDATE: a FRESH install (no prior finalized op) never reads the prior source/grant and never routes to the rollback activator", async () => {
    let readSourceCalled = false;
    let updateCalled = false;
    let freshCalled = false;
    const deps = updateBaseDeps({
      readInstallOp: async () => null, // FRESH — no prior op
      readCurrentSource: async () => {
        readSourceCalled = true;
        return null;
      },
      activateUpdateWithRollback: async () => {
        updateCalled = true;
        return { activated: false, rolledBack: true };
      },
      activateInProcess: async () => {
        freshCalled = true;
        return { activated: true };
      },
    });
    const r = await installExtensionFromRegistry({ packageName: "@cinatra-ai/foo", version: "1.0.0", orgId: null }, deps);
    expect(readSourceCalled, "no prior-source capture on a fresh install").toBe(false);
    expect(updateCalled, "fresh install does NOT route to the rollback activator").toBe(false);
    expect(freshCalled, "fresh install uses the plain in-process activator").toBe(true);
    expect(r.activated).toBe(true);
    expect(r.rolledBack).toBeUndefined();
  });

  it("a SAME-digest re-install (prior finalized op, SAME digest) is NOT a superseding update → plain activator, no rollback path", async () => {
    let updateCalled = false;
    let freshCalled = false;
    const deps = updateBaseDeps({
      // prior op's digest EQUALS the new materialized digest → not superseding.
      readInstallOp: async () => ({ installOpId: "op", phase: "finalized", digest: "new-digest" }),
      activateUpdateWithRollback: async () => {
        updateCalled = true;
        return { activated: true };
      },
      activateInProcess: async () => {
        freshCalled = true;
        return { activated: true };
      },
    });
    const r = await installExtensionFromRegistry({ packageName: "@cinatra-ai/foo", version: "2.0.0", orgId: null }, deps);
    expect(updateCalled, "same-digest re-install is not a superseding update").toBe(false);
    expect(freshCalled).toBe(true);
    expect(r.activated).toBe(true);
    expect(r.rolledBack).toBeUndefined();
  });

  it("if activateUpdateWithRollback itself THROWS, the pipeline still reports rolledBack:true/activated:false (never update success) + runs the durable restore", async () => {
    let restoreRan = false;
    const deps = updateBaseDeps({
      readCurrentSource: async () => ({ registryUrl: REGISTRY, version: "1.0.0", integrity: "sha512-old", contentHash: "ch-old" }),
      recordProvenance: async (i) => {
        if ((i as { version?: string }).version === "1.0.0") restoreRan = true;
      },
      activateUpdateWithRollback: async (i) => {
        // Simulate the activator throwing AFTER it could not roll back internally.
        void i;
        throw new Error("activator-crashed");
      },
    });
    const r = await installExtensionFromRegistry({ packageName: "@cinatra-ai/foo", version: "2.0.0", orgId: null }, deps);
    expect(r.installed).toBe(true);
    expect(r.activated).toBe(false);
    expect(r.rolledBack).toBe(true);
    expect(r.reason).toContain("update-activate-threw:activator-crashed");
    expect(restoreRan, "the pipeline ran the durable restore as a last resort").toBe(true);
  });
});
