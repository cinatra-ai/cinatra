import { describe, it, expect } from "vitest";
import {
  HOST_PORT_NAMES,
  HOST_PORT_TIERS,
  HOST_PORT_TIER,
  RESERVED_HOST_PORTS,
} from "../index";
import type { HostPortName, HostPortTier } from "../index";

// ABI-evolution policy: per-port lifecycle tier. Locks the tier table as the
// canonical source the host factory imports directly (the manifest generator
// keeps a parity-guarded mirror; see host-port-tiers-parity.test.ts). ADDITIVE —
// no ABI bump (it adds no port and wires none; it is metadata about the frozen surface).

describe("host port ABI tiers", () => {
  it("declares exactly the two tiers", () => {
    expect([...HOST_PORT_TIERS]).toEqual(["stable", "reserved"]);
  });

  it("assigns a known tier to EVERY host port name (total coverage)", () => {
    const tierSet = new Set<HostPortTier>(HOST_PORT_TIERS);
    for (const name of HOST_PORT_NAMES) {
      expect(HOST_PORT_TIER[name]).toBeDefined();
      expect(tierSet.has(HOST_PORT_TIER[name])).toBe(true);
    }
  });

  it("declares NO tier for a non-port key (the table mirrors HOST_PORT_NAMES exactly)", () => {
    const tierKeys = Object.keys(HOST_PORT_TIER).sort();
    expect(tierKeys).toEqual([...HOST_PORT_NAMES].sort());
  });

  it("classifies `db` as the only reserved port; all others stable (today's state)", () => {
    expect(HOST_PORT_TIER.db).toBe("reserved");
    const nonDb = HOST_PORT_NAMES.filter((p) => p !== "db");
    for (const p of nonDb) {
      expect(HOST_PORT_TIER[p]).toBe("stable");
    }
  });

  it("derives RESERVED_HOST_PORTS from the tier table", () => {
    const expected: HostPortName[] = HOST_PORT_NAMES.filter(
      (p) => HOST_PORT_TIER[p] === "reserved",
    );
    expect([...RESERVED_HOST_PORTS]).toEqual(expected);
    expect([...RESERVED_HOST_PORTS]).toEqual(["db"]);
  });

  it("exposes the tier table + derived set as VALUES on the public root", () => {
    // Author-facing policy metadata (not host-bus addressing) — reachable from
    // the public author entry point.
    expect(HOST_PORT_TIER).toBeTruthy();
    expect(typeof HOST_PORT_TIER).toBe("object");
    expect(Array.isArray(HOST_PORT_TIERS as readonly string[])).toBe(true);
    expect(HOST_PORT_TIERS.length).toBe(2);
    expect(Array.isArray(RESERVED_HOST_PORTS as readonly string[])).toBe(true);
  });
});
