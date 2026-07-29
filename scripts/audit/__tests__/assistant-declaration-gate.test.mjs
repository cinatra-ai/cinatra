// assistant-declaration gate (cinatra#1874, Epic #1873 W1) — gate-rule tests +
// the AGREEMENT PIN: the gate's self-contained `.mjs` assistant mirror and the
// authoritative SDK validator
// (`packages/sdk-extensions/src/assistant-declaration.ts`) must accept and reject
// the SAME fixture matrix (the connector-access-config-gate precedent). Do not
// change one validator without the other.

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  validateAssistantConfig,
  hasAssistantBlock,
  FLAT_TOKEN_RE,
  ASSISTANT_LAUNCH_KINDS,
  ASSISTANT_DELIVERY_KINDS,
} from "../connector-access-config-gate.mjs";
import { safeParseAssistantDeclaration } from "../../../packages/sdk-extensions/src/assistant-declaration.ts";

const PKG = "@cinatra-ai/cinatra-assistant";
const GATE = resolve(process.cwd(), "scripts/audit/connector-access-config-gate.mjs");

/** A minimal VALID assistant block. */
const VALID_BLOCK = Object.freeze({
  abiVersion: 1,
  displayName: "Cinatra",
  preferredTag: "cinatra",
  persona: "You are the Cinatra assistant.",
  skillBundle: ["chat-assistant-core"],
  allowedTools: [],
  allowedAgents: [],
  modelPrefs: { provider: "anthropic", model: "claude" },
  mcp: { enabled: true, restriction: "org-members" },
  launch: { kind: "local" },
  delivery: { kind: "host-runtime" },
});
const file = (assistant, extra = {}) => ({ formatVersion: 1, ...extra, assistant });
/** clone the valid block, override/delete fields. */
const mut = (over, del = []) => {
  const b = structuredClone(VALID_BLOCK);
  Object.assign(b, over);
  for (const k of del) delete b[k];
  return b;
};

/** The shared proof-fixture matrix — every entry names an expected verdict. */
const FIXTURES = [
  // ---- valid ----
  { raw: file(VALID_BLOCK), ok: true },
  { raw: file(mut({}, ["allowedTools", "allowedAgents", "modelPrefs", "mcp"])), ok: true }, // optionals absent
  { raw: file(mut({ skillBundle: [] })), ok: true }, // empty skill bundle allowed
  { raw: file(mut({ launch: { kind: "remote", targetProvider: "wordpress" } })), ok: true },
  { raw: file(mut({ delivery: { kind: "webhook" } })), ok: true },
  { raw: file(mut({ mcp: { enabled: false } })), ok: true },
  { raw: file(mut({ modelPrefs: { temperature: 0.7 } })), ok: true },
  { raw: file(mut({ preferredTag: "cinatra-2" })), ok: true },
  // no assistant block at all → ok:true (file merely declares no assistant)
  { raw: { formatVersion: 1 }, ok: true },
  { raw: { formatVersion: 1, access: { scope: { default: "user" } } }, ok: true },
  // ---- invalid: file shape ----
  { raw: null, ok: false },
  { raw: [], ok: false },
  { raw: file(VALID_BLOCK, { formatVersion: undefined }), ok: false }, // handled below; keep explicit ones too
  { raw: { formatVersion: 2, assistant: VALID_BLOCK }, ok: false },
  { raw: { assistant: VALID_BLOCK }, ok: false }, // missing formatVersion
  { raw: { formatVersion: 1, telemetry: {}, assistant: VALID_BLOCK }, ok: false }, // unknown top-level
  // ---- invalid: block shape ----
  { raw: file(mut({ abiVersion: 2 })), ok: false },
  { raw: file(mut({}, ["abiVersion"])), ok: false },
  { raw: file(mut({}, ["displayName"])), ok: false },
  { raw: file(mut({ displayName: "" })), ok: false },
  { raw: file(mut({}, ["preferredTag"])), ok: false },
  { raw: file(mut({ preferredTag: "Cinatra" })), ok: false }, // uppercase → not flat
  { raw: file(mut({ preferredTag: "-lead" })), ok: false },
  { raw: file(mut({ preferredTag: "a__b" })), ok: false }, // double separator
  { raw: file(mut({}, ["persona"])), ok: false },
  { raw: file(mut({ persona: "" })), ok: false },
  { raw: file(mut({}, ["skillBundle"])), ok: false },
  { raw: file(mut({ skillBundle: [""] })), ok: false },
  { raw: file(mut({ skillBundle: "chat-core" })), ok: false }, // not an array
  { raw: file(mut({ allowedTools: [""] })), ok: false },
  { raw: file(mut({ modelPrefs: { temperature: 3 } })), ok: false },
  { raw: file(mut({ modelPrefs: { provider: "" } })), ok: false },
  { raw: file(mut({ modelPrefs: { unknown: 1 } })), ok: false },
  { raw: file(mut({ mcp: { restriction: "everyone" } })), ok: false },
  { raw: file(mut({ mcp: { enabled: "yes" } })), ok: false },
  { raw: file(mut({}, ["launch"])), ok: false },
  { raw: file(mut({ launch: { kind: "cloud" } })), ok: false },
  { raw: file(mut({ launch: {} })), ok: false }, // kind required
  { raw: file(mut({}, ["delivery"])), ok: false },
  { raw: file(mut({ delivery: { kind: "carrier-pigeon" } })), ok: false },
  { raw: file(mut({ delivery: {} })), ok: false }, // kind required
  { raw: file(mut({ surprise: 1 })), ok: false }, // unknown block key
  // ---- cinatra#1927: the generic, KIND-AGNOSTIC `protected` top-level domain ----
  { raw: file(VALID_BLOCK, { protected: true }), ok: true },
  { raw: file(VALID_BLOCK, { protected: false }), ok: true },
  { raw: { formatVersion: 1, protected: true }, ok: true }, // no assistant block
  { raw: { formatVersion: 1, protected: true, access: { scope: { default: "user" } } }, ok: true },
  { raw: file(VALID_BLOCK, { protected: "true" }), ok: false }, // fail-closed: never coerced
  { raw: file(VALID_BLOCK, { protected: 1 }), ok: false },
  { raw: file(VALID_BLOCK, { protected: null }), ok: false },
  { raw: file(VALID_BLOCK, { protectd: true }), ok: false }, // a misspelling is still an unknown domain
];

describe("assistant-declaration-gate — mirror rules", () => {
  it("agrees with the SDK safeParseAssistantDeclaration on the whole matrix", () => {
    const disagreements = [];
    for (const { raw, ok } of FIXTURES) {
      const mirrorOk = validateAssistantConfig(raw, PKG).length === 0;
      const sdkOk = safeParseAssistantDeclaration(raw, { packageName: PKG }).ok;
      if (mirrorOk !== ok || sdkOk !== ok) {
        disagreements.push({ raw: JSON.stringify(raw), expected: ok, mirrorOk, sdkOk });
      }
    }
    expect(disagreements).toEqual([]);
  });

  it("hasAssistantBlock mirrors the SDK presence probe", () => {
    expect(hasAssistantBlock(file(VALID_BLOCK))).toBe(true);
    expect(hasAssistantBlock({ formatVersion: 1 })).toBe(false);
    expect(hasAssistantBlock({ formatVersion: 1, assistant: null })).toBe(false);
    expect(hasAssistantBlock(null)).toBe(false);
    expect(hasAssistantBlock([])).toBe(false);
  });

  it("pins the shared vocabulary constants", () => {
    expect(FLAT_TOKEN_RE.test("cinatra-2")).toBe(true);
    expect(FLAT_TOKEN_RE.test("Cinatra")).toBe(false);
    expect(ASSISTANT_LAUNCH_KINDS).toEqual(["local", "remote"]);
    expect(ASSISTANT_DELIVERY_KINDS).toEqual(["host-runtime", "webhook", "mcp-poll"]);
  });
});

/** Materialize a temp extensions/<scope>/<slug> agent package, run the gate with
 *  cwd=tmp, return { status, stderr }. */
function runGateOnAgent(configJson, { files } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "asst-gate-"));
  try {
    const dir = join(tmp, "extensions", "cinatra-ai", "cinatra-assistant");
    mkdirSync(join(dir, "cinatra"), { recursive: true });
    const pkg = { name: PKG, version: "0.0.0", cinatra: { kind: "agent" } };
    if (files) pkg.files = files;
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
    if (configJson !== undefined) {
      writeFileSync(join(dir, "cinatra", "config.json"), configJson);
    }
    const res = spawnSync(process.execPath, [GATE], { cwd: tmp, encoding: "utf8" });
    return { status: res.status, stderr: res.stderr ?? "" };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe("assistant-declaration-gate — end-to-end", () => {
  it("passes an agent package with a valid assistant block", () => {
    const res = runGateOnAgent(JSON.stringify(file(VALID_BLOCK)), { files: ["dist", "cinatra"] });
    expect(res.status).toBe(0);
  });

  it("passes an agent package with NO config.json (agents need not ship one)", () => {
    const res = runGateOnAgent(undefined);
    expect(res.status).toBe(0);
  });

  it("passes an agent package whose config declares no assistant block", () => {
    const res = runGateOnAgent(JSON.stringify({ formatVersion: 1 }));
    expect(res.status).toBe(0);
  });

  it("FAILS RED on a malformed assistant block (AC#6)", () => {
    const res = runGateOnAgent(JSON.stringify(file(mut({ launch: { kind: "cloud" } }))));
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/assistant block/);
  });

  it("FAILS RED when a shipped assistant config is missing from the packlist", () => {
    const res = runGateOnAgent(JSON.stringify(file(VALID_BLOCK)), { files: ["dist"] });
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/package\.json#files/);
  });
});
