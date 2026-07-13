// cinatra#1391 PORTS AXIS — pure units of the grant-union durable capsule:
//   • reconcileSideBySidePortsOnTeardown: the 6-branch decision ladder that
//     restores/narrows/keeps/resets the SHARED per-(package, org) host-port
//     grant when a side-by-side version is torn down (newest-consistent-state
//     first; hash-guarded prior restore closes the non-LIFO resurrection hole).
//   • mergeSideBySideGrantCapsule: superset accumulation across up to two
//     capture events, first-capture-wins on the ports prior state.
//   • parseSideBySideGrantCapsule: tolerant boundary parse of the OPTIONAL v:1
//     ports fields (ownership-only capsule unchanged; malformed ports dropped,
//     ownership kept; never a throw).
//
// All PURE — no fs/db; the reconcile is orchestration over INJECTED functions.
import { describe, it, expect, vi } from "vitest";

import {
  reconcileSideBySidePortsOnTeardown,
  mergeSideBySideGrantCapsule,
  parseSideBySideGrantCapsule,
} from "@/lib/extension-side-by-side-install";
import type {
  SideBySideGrantCapsule,
  SideBySidePortsPriorState,
} from "@/lib/extension-install-batch-ops";

// Deterministic, order-insensitive stand-in for the real port-set hash.
const hash = (ports: readonly string[]): string =>
  `h:${Array.from(new Set(ports.map(String))).sort().join(",")}`;

type GrantState = {
  status: string;
  approvedPorts: string[];
  requestedPortsHash: string;
  approvedBy: string | null;
};

function harness(opts: {
  portsPrior: SideBySidePortsPriorState | null;
  survivorPorts: string[];
  current: GrantState | null;
}) {
  const restoreGrant = vi.fn(async () => undefined);
  const recordRequestedGrant = vi.fn(async () => undefined);
  const run = () =>
    reconcileSideBySidePortsOnTeardown({
      packageName: "@cinatra-ai/shared",
      orgId: null,
      portsPrior: opts.portsPrior,
      survivorPorts: opts.survivorPorts,
      computeHash: hash,
      readGrantForScope: async () => opts.current,
      restoreGrant,
      recordRequestedGrant,
    });
  return { run, restoreGrant, recordRequestedGrant };
}

describe("reconcileSideBySidePortsOnTeardown — decision ladder", () => {
  it("1. NO-OP when the current row already hashes to the survivor union", async () => {
    const h = hash(["p1"]);
    const { run, restoreGrant, recordRequestedGrant } = harness({
      portsPrior: { exists: true, status: "approved", approvedPorts: ["p1"], requestedPortsHash: h, approvedBy: "admin" },
      survivorPorts: ["p1"],
      current: { status: "approved", approvedPorts: ["p1"], requestedPortsHash: h, approvedBy: "admin" },
    });
    expect(await run()).toEqual({ action: "noop" });
    expect(restoreGrant).not.toHaveBeenCalled();
    expect(recordRequestedGrant).not.toHaveBeenCalled();
  });

  it("1b. NO-OP when there is no row, no survivors, and no prior to restore", async () => {
    const { run, restoreGrant, recordRequestedGrant } = harness({
      portsPrior: null,
      survivorPorts: [],
      current: null,
    });
    expect(await run()).toEqual({ action: "noop" });
    expect(restoreGrant).not.toHaveBeenCalled();
    expect(recordRequestedGrant).not.toHaveBeenCalled();
  });

  it("2. EXACT prior restore (hash-guarded) — the LIFO common case recovers the default's approved grant", async () => {
    const survivorHash = hash(["p1", "p2"]);
    const { run, restoreGrant } = harness({
      portsPrior: {
        exists: true,
        status: "approved",
        approvedPorts: ["p1", "p2"],
        requestedPortsHash: survivorHash,
        approvedBy: "admin",
      },
      survivorPorts: ["p2", "p1"], // order-insensitive
      // Current is the grown pending union (a sibling had bumped it).
      current: { status: "pending", approvedPorts: [], requestedPortsHash: hash(["p1", "p2", "p3"]), approvedBy: null },
    });
    expect(await run()).toEqual({ action: "restored-prior" });
    expect(restoreGrant).toHaveBeenCalledWith({
      status: "approved",
      approvedPorts: ["p1", "p2"],
      requestedPortsHash: survivorHash,
      approvedBy: "admin",
    });
  });

  it("2. a STALE prior (hash mismatches survivors, not covering) never restores — closes the non-LIFO resurrection hole", async () => {
    // Prior recorded a union that is NOT the survivor set and does not cover it.
    const { run, restoreGrant, recordRequestedGrant } = harness({
      portsPrior: {
        exists: true,
        status: "approved",
        approvedPorts: ["p9"],
        requestedPortsHash: hash(["p9"]),
        approvedBy: "admin",
      },
      survivorPorts: ["p1"],
      current: { status: "pending", approvedPorts: [], requestedPortsHash: hash(["p1", "p9"]), approvedBy: null },
    });
    expect(await run()).toEqual({ action: "reset-pending" });
    expect(restoreGrant).not.toHaveBeenCalled();
    expect(recordRequestedGrant).toHaveBeenCalledWith(["p1"]);
  });

  it("3. NARROWED prior restore — an approved prior SUPERSET shrinks to exactly the survivors", async () => {
    const survivorHash = hash(["p1", "p2"]);
    const { run, restoreGrant } = harness({
      portsPrior: {
        exists: true,
        status: "approved",
        approvedPorts: ["p1", "p2", "p3"], // superset of survivors
        requestedPortsHash: hash(["p1", "p2", "p3"]), // != survivorHash → branch 2 fails
        approvedBy: "admin",
      },
      survivorPorts: ["p1", "p2"],
      current: { status: "pending", approvedPorts: [], requestedPortsHash: hash(["x"]), approvedBy: null },
    });
    expect(await run()).toEqual({ action: "restored-prior-narrowed" });
    expect(restoreGrant).toHaveBeenCalledWith({
      status: "approved",
      approvedPorts: ["p1", "p2"],
      requestedPortsHash: survivorHash,
      approvedBy: "admin",
    });
  });

  it("4. NARROW CURRENT — the current approval covers the survivors, no usable prior", async () => {
    const survivorHash = hash(["p1"]);
    const { run, restoreGrant } = harness({
      portsPrior: null,
      survivorPorts: ["p1"],
      current: { status: "approved", approvedPorts: ["p1", "p2"], requestedPortsHash: hash(["p1", "p2"]), approvedBy: "admin2" },
    });
    expect(await run()).toEqual({ action: "narrowed-current" });
    expect(restoreGrant).toHaveBeenCalledWith({
      status: "approved",
      approvedPorts: ["p1"],
      requestedPortsHash: survivorHash,
      approvedBy: "admin2",
    });
  });

  it("5. KEPT-REVOKED — an explicit admin revoke stays revoked, hash corrected to the survivors", async () => {
    const survivorHash = hash(["p1"]);
    const { run, restoreGrant } = harness({
      portsPrior: null,
      survivorPorts: ["p1"],
      current: { status: "revoked", approvedPorts: [], requestedPortsHash: hash(["p1", "p2"]), approvedBy: "admin" },
    });
    expect(await run()).toEqual({ action: "kept-revoked" });
    expect(restoreGrant).toHaveBeenCalledWith({
      status: "revoked",
      approvedPorts: [],
      requestedPortsHash: survivorHash,
      approvedBy: "admin",
    });
  });

  it("6. RESET-PENDING — no consistent prior/current path, correct to a pending survivor union", async () => {
    const { run, restoreGrant, recordRequestedGrant } = harness({
      portsPrior: { exists: false },
      survivorPorts: ["p1"],
      current: { status: "pending", approvedPorts: [], requestedPortsHash: hash(["p1", "p2"]), approvedBy: null },
    });
    expect(await run()).toEqual({ action: "reset-pending" });
    expect(restoreGrant).not.toHaveBeenCalled();
    expect(recordRequestedGrant).toHaveBeenCalledWith(["p1"]);
  });

  it("0. a current REVOKE is NEVER un-revoked by a stale approved prior that hashes to the survivors (codex round-1)", async () => {
    const survivorHash = hash(["p1"]);
    const { run, restoreGrant } = harness({
      // A stale capsule captured an approved grant for exactly the survivor set…
      portsPrior: { exists: true, status: "approved", approvedPorts: ["p1"], requestedPortsHash: survivorHash, approvedBy: "old-admin" },
      survivorPorts: ["p1"],
      // …but an admin has since REVOKED the shared grant. Teardown must keep it revoked.
      current: { status: "revoked", approvedPorts: [], requestedPortsHash: hash(["p1", "p2"]), approvedBy: "revoking-admin" },
    });
    expect(await run()).toEqual({ action: "kept-revoked" });
    expect(restoreGrant).toHaveBeenCalledWith({
      status: "revoked",
      approvedPorts: [],
      requestedPortsHash: survivorHash,
      approvedBy: "revoking-admin",
    });
  });

  it("1. a PENDING row at the survivor hash still RESTORES a matching approved prior (not left degraded/pending)", async () => {
    const survivorHash = hash(["p1"]);
    const { run, restoreGrant, recordRequestedGrant } = harness({
      portsPrior: { exists: true, status: "approved", approvedPorts: ["p1"], requestedPortsHash: survivorHash, approvedBy: "admin" },
      survivorPorts: ["p1"],
      // Current already requests exactly the survivors but is PENDING (conveys no ports).
      current: { status: "pending", approvedPorts: [], requestedPortsHash: survivorHash, approvedBy: null },
    });
    expect(await run()).toEqual({ action: "restored-prior" });
    expect(restoreGrant).toHaveBeenCalledWith(expect.objectContaining({ status: "approved", approvedPorts: ["p1"] }));
    expect(recordRequestedGrant).not.toHaveBeenCalled();
  });

  it("ORDER: an exact prior wins over a current approval that also covers (never clobber a newer same-hash restore)", async () => {
    const survivorHash = hash(["p1"]);
    const { run, restoreGrant } = harness({
      portsPrior: { exists: true, status: "approved", approvedPorts: ["p1"], requestedPortsHash: survivorHash, approvedBy: "prior-admin" },
      survivorPorts: ["p1"],
      current: { status: "approved", approvedPorts: ["p1", "p2"], requestedPortsHash: hash(["p1", "p2"]), approvedBy: "newer-admin" },
    });
    expect(await run()).toEqual({ action: "restored-prior" });
    expect(restoreGrant).toHaveBeenCalledWith(expect.objectContaining({ approvedBy: "prior-admin" }));
  });
});

describe("mergeSideBySideGrantCapsule — superset accumulation", () => {
  it("returns null when there is nothing to capture", () => {
    expect(mergeSideBySideGrantCapsule(null, {})).toBeNull();
    expect(mergeSideBySideGrantCapsule(null, { declaredTokenKeys: [], declaredPorts: [] })).toBeNull();
  });

  it("accumulates a superset across two capture events (ownership keys, then ports)", () => {
    const first = mergeSideBySideGrantCapsule(null, { declaredTokenKeys: ["k2", "k1", "k1"] });
    expect(first).toEqual({ v: 1, declaredTokenKeys: ["k1", "k2"] });
    const second = mergeSideBySideGrantCapsule(first, {
      declaredPorts: ["pB", "pA"],
      portsPrior: { exists: false },
    });
    expect(second).toEqual({
      v: 1,
      declaredTokenKeys: ["k1", "k2"],
      declaredPorts: ["pA", "pB"],
      portsPrior: { exists: false },
    });
  });

  it("portsPrior is FIRST-CAPTURE-WINS — a later event never overwrites the captured prior", () => {
    const withPrior = mergeSideBySideGrantCapsule(
      { v: 1, declaredTokenKeys: [], portsPrior: { exists: true, status: "approved", approvedPorts: ["p1"], requestedPortsHash: "h1", approvedBy: "a" } },
      { portsPrior: { exists: false } },
    );
    expect(withPrior?.portsPrior).toEqual({
      exists: true,
      status: "approved",
      approvedPorts: ["p1"],
      requestedPortsHash: "h1",
      approvedBy: "a",
    });
  });
});

describe("parseSideBySideGrantCapsule — tolerant ports-axis boundary parse", () => {
  it("parses an ownership-ONLY capsule unchanged (backward compatible)", () => {
    expect(parseSideBySideGrantCapsule({ v: 1, declaredTokenKeys: ["k"] })).toEqual({
      v: 1,
      declaredTokenKeys: ["k"],
    });
  });

  it("parses the ports fields (sorted declaredPorts + a valid portsPrior)", () => {
    const parsed = parseSideBySideGrantCapsule({
      v: 1,
      declaredTokenKeys: [],
      declaredPorts: ["p2", "p1", "p1"],
      portsPrior: { exists: true, status: "approved", approvedPorts: ["p1"], requestedPortsHash: "h", approvedBy: "admin" },
    });
    expect(parsed).toEqual({
      v: 1,
      declaredTokenKeys: [],
      declaredPorts: ["p1", "p2"],
      portsPrior: { exists: true, status: "approved", approvedPorts: ["p1"], requestedPortsHash: "h", approvedBy: "admin" },
    });
  });

  it("DROPS a malformed ports part but KEEPS the ownership part (never a throw)", () => {
    const parsed = parseSideBySideGrantCapsule({
      v: 1,
      declaredTokenKeys: ["k"],
      declaredPorts: "not-an-array",
      portsPrior: { exists: "bad" },
    }) as SideBySideGrantCapsule;
    expect(parsed).toEqual({ v: 1, declaredTokenKeys: ["k"] });
    expect(parsed.declaredPorts).toBeUndefined();
    expect(parsed.portsPrior).toBeUndefined();
  });

  it("rejects a non-capsule value → null", () => {
    expect(parseSideBySideGrantCapsule(null)).toBeNull();
    expect(parseSideBySideGrantCapsule({ v: 2, declaredTokenKeys: [] })).toBeNull();
    expect(parseSideBySideGrantCapsule({ v: 1 })).toBeNull();
  });

  it("a portsPrior with exists:false parses to just { exists:false }", () => {
    const parsed = parseSideBySideGrantCapsule({
      v: 1,
      declaredTokenKeys: [],
      portsPrior: { exists: false },
    });
    expect(parsed?.portsPrior).toEqual({ exists: false });
  });
});
