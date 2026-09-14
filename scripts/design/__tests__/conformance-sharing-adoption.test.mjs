// The app-connectors SHARING adoption (cinatra#3374).
//
// The published app-connectors manifest declares three surfaces the pinned copy
// did not — connector-sharing, connector-sharing-rollup and
// connector-sharing-locked. Per docs/internals/contracts/design-conformance-pin-drift.md
// a pin advance is an ADOPTION, not a hash edit: "the functional-acceptance
// suite is red for a declared surface with no driver and no allowlist entry
// while allowlist.json is a shrink-only ratchet that may not gain entries".
//
// This file pins that adoption where it can be checked without booting a
// browser: the committed artifact really is the published bytes, both pin
// hashes agree with it, every gained surface is declared with the shape the
// drivers answer, each has a registered driver, and the allowlist gained
// nothing.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const CONF_DIR = path.join(REPO_ROOT, "tests", "e2e", "design", "conformance");

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

const MANIFEST_BYTES = readFileSync(
  path.join(CONF_DIR, "manifests", "app-connectors.json"),
);
const MANIFEST = JSON.parse(MANIFEST_BYTES.toString("utf8"));
const PINS = readJson(path.join(REPO_ROOT, "tests", "e2e", "design", "conformance-pins.json"));
const PIN = PINS.manifests.find((m) => m.id === "app-connectors");
const ALLOWLIST = readJson(path.join(CONF_DIR, "allowlist.json"));
const CONTRACT_SRC = readFileSync(path.join(CONF_DIR, "contract.ts"), "utf8");

const SHARING_SURFACES = [
  "connector-sharing",
  "connector-sharing-rollup",
  "connector-sharing-locked",
];

describe("app-connectors pin adoption — the Sharing tab surfaces", () => {
  it("pins the committed artifact by BOTH hashes", () => {
    expect(PIN).toBeTruthy();
    expect(createHash("sha256").update(MANIFEST_BYTES).digest("hex")).toBe(
      PIN.manifestSha256,
    );
    expect(MANIFEST.contentHash).toBe(PIN.specContentHash);
  });

  it("declares the three sharing surfaces", () => {
    const ids = MANIFEST.surfaces.map((s) => s.id);
    for (const id of SHARING_SURFACES) expect(ids).toContain(id);
  });

  it("declares connector-sharing with its four bindings, four actions and loading state", () => {
    const surface = MANIFEST.surfaces.find((s) => s.id === "connector-sharing");
    expect(surface.fields.map((f) => [f.field, f.source])).toEqual([
      ["name", "connection.connectionId"],
      ["url", "connection.connectorKey"],
      ["access", "policy.runListVisibility"],
      ["co-owners", "connection.coOwners"],
    ]);
    expect(surface.actions.map((a) => [a.action, a.outcome])).toEqual([
      ["select-scope", "scopes-selected"],
      ["search-people", "people-listed"],
      ["remove-co-owner", "co-owner-removed"],
      ["save-access", "access-saved"],
    ]);
    expect(surface.states).toEqual(["loading"]);
  });

  it("registers a functional-acceptance driver for each of them", () => {
    for (const id of SHARING_SURFACES) {
      expect(CONTRACT_SRC).toContain(`"${id}": CONNECTOR_SHARING`);
    }
  });

  it("adds NO allowlist entry (the ratchet is shrink-only)", () => {
    const entries = ALLOWLIST.allow.filter((e) => SHARING_SURFACES.includes(e.surface));
    expect(entries).toEqual([]);
  });
});
