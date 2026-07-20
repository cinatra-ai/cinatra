// Manifest-generator touchpoint for the shared assistant-declaration parser
// (cinatra#1874, Epic #1873 W1). `validateAgentAssistantDeclaration` is the
// build-time seam wired into `buildManifest`'s fail-closed `bindingErrors` set:
// a `kind:"agent"` package whose `cinatra/config.json` declares a MALFORMED
// `assistant` block fails generation (the earliest honest failure point); a
// well-formed / block-less / config-less agent contributes nothing.
//
// The generator consumes the SAME rules the host + gate use through the
// connector gate's already-agreement-pinned .mjs mirror
// (`validateAssistantConfig`/`hasAssistantBlock`), so this test proves the
// WIRING (read + prefix + fail-closed passthrough), not the schema (the gate's
// own agreement matrix pins that against the authoritative zod parser).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { validateAgentAssistantDeclaration } from "../generate-extension-manifest.mjs";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The generator resolves config.json against its REPO_ROOT (scripts/extensions/../..),
// so a repo-relative dir is required; the fixture lives under the repo in a temp
// dir that is cleaned up (same pattern as the D10 logo-containment fixtures).
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const REL_ROOT = ".tmp-assistant-manifest-test";
const ABS_ROOT = path.join(REPO_ROOT, REL_ROOT);

const VALID_BLOCK = {
  abiVersion: 1,
  displayName: "Cinatra",
  preferredTag: "cinatra",
  persona: "You are Cinatra.",
  skillBundle: ["chat-assistant-core"],
  launch: { kind: "local" },
  delivery: { kind: "host-runtime" },
};

/** Write a `cinatra/config.json` into a fresh per-case relative dir; return the rel dir. */
function fixture(slug, config) {
  const rel = path.join(REL_ROOT, slug);
  const absCinatra = path.join(REPO_ROOT, rel, "cinatra");
  mkdirSync(absCinatra, { recursive: true });
  if (config !== undefined) {
    writeFileSync(path.join(absCinatra, "config.json"), config === "RAW-NOT-JSON" ? "{not json" : JSON.stringify(config));
  }
  return rel;
}

describe("validateAgentAssistantDeclaration (manifest-generator parser touchpoint, #1874 W1)", () => {
  beforeAll(() => {
    rmSync(ABS_ROOT, { recursive: true, force: true });
    mkdirSync(ABS_ROOT, { recursive: true });
  });
  afterAll(() => {
    rmSync(ABS_ROOT, { recursive: true, force: true });
  });

  it("returns [] for an agent with NO cinatra/config.json (agents need not ship one)", () => {
    const rel = path.join(REL_ROOT, "no-config");
    mkdirSync(path.join(REPO_ROOT, rel), { recursive: true });
    expect(validateAgentAssistantDeclaration(rel, "@cinatra-ai/plain-agent")).toEqual([]);
  });

  it("returns [] for a config.json that declares NO assistant block", () => {
    const rel = fixture("no-block", { formatVersion: 1 });
    expect(validateAgentAssistantDeclaration(rel, "@cinatra-ai/blockless-agent")).toEqual([]);
  });

  it("returns [] for a WELL-FORMED assistant declaration", () => {
    const rel = fixture("valid", { formatVersion: 1, assistant: VALID_BLOCK });
    expect(validateAgentAssistantDeclaration(rel, "@cinatra-ai/cinatra-assistant")).toEqual([]);
  });

  it("FAILS a malformed assistant block, prefixing the package + file context", () => {
    const rel = fixture("bad-tag", {
      formatVersion: 1,
      assistant: { ...VALID_BLOCK, preferredTag: "Not A Token" },
    });
    const errors = validateAgentAssistantDeclaration(rel, "@cinatra-ai/bad-assistant");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("@cinatra-ai/bad-assistant cinatra/config.json assistant block —");
    expect(errors.join(" ")).toMatch(/preferredTag/);
  });

  it("FAILS an unknown top-level key (fail-closed: strict file schema)", () => {
    const rel = fixture("unknown-top", { formatVersion: 1, assistant: VALID_BLOCK, bogus: true });
    const errors = validateAgentAssistantDeclaration(rel, "@cinatra-ai/strict-agent");
    expect(errors.some((e) => /unknown top-level key "bogus"/.test(e))).toBe(true);
  });

  it("FAILS an assistant block missing a required field (persona)", () => {
    const { persona, ...noPersona } = VALID_BLOCK;
    const rel = fixture("no-persona", { formatVersion: 1, assistant: noPersona });
    const errors = validateAgentAssistantDeclaration(rel, "@cinatra-ai/incomplete-agent");
    expect(errors.some((e) => /persona/.test(e))).toBe(true);
  });

  it("THROWS on malformed JSON (the earliest honest failure point, mirrors the connector reader)", () => {
    const rel = fixture("bad-json", "RAW-NOT-JSON");
    expect(() => validateAgentAssistantDeclaration(rel, "@cinatra-ai/broken-json-agent")).toThrow(/not valid JSON/);
  });
});
