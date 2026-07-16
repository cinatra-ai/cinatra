import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import tsDefault from "typescript";

import {
  detectFindingsInSource,
  classifyIdentity,
  keyingKindOf,
  fingerprintOf,
  IDENTITY_CLASS,
} from "../lib/artifact-presentation-identity.mjs";
import {
  validateBaseline,
  diffFindings,
  baselineGrowth,
  deriveFingerprint,
  coreFields,
} from "../artifact-ui-boundary-gate.mjs";

const ts = tsDefault;
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const GATE = join(REPO_ROOT, "scripts/audit/artifact-ui-boundary-gate.mjs");
const BASELINE = join(REPO_ROOT, "scripts/audit/artifact-ui-boundary-gate.baseline.json");

function runGate(env = {}) {
  return spawnSync("node", [GATE], { cwd: REPO_ROOT, env: { ...process.env, ...env }, encoding: "utf8" });
}

/** Run `fn` with the real baseline replaced by `mutate(originalDoc)`, restoring
 * the byte-exact original afterwards (even on throw). */
function withMutatedBaseline(mutate, fn) {
  const original = readFileSync(BASELINE, "utf8");
  try {
    const doc = JSON.parse(original);
    writeFileSync(BASELINE, JSON.stringify(mutate(doc), null, 2) + "\n");
    return fn();
  } finally {
    writeFileSync(BASELINE, original);
  }
}

describe("artifact-ui presentation-identity detector (G1)", () => {
  it("flags a representation MIME equality in core", () => {
    const f = detectFindingsInSource("src/x.ts", `const a = mime === "application/pdf";`, ts);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ canonicalIdentity: "application/pdf", identityClass: "representation", keyingKind: "equality" });
  });

  it("flags a switch case, a startsWith arg, and an element-access key", () => {
    const src = [
      `switch (m) { case "text/plain": break; }`,
      `const b = m.startsWith("image/");`,
      `const c = caps["application/pdf"];`,
    ].join("\n");
    const kinds = detectFindingsInSource("src/x.ts", src, ts).map((f) => f.keyingKind).sort();
    expect(kinds).toEqual(["element-access-key", "method-arg", "switch-case"]);
  });

  it("does NOT flag a presentation identity used as a plain VALUE (schema descriptor)", () => {
    const f = detectFindingsInSource("src/x.ts", `const v = { viewType: "content_change_proposal", mime: "application/pdf" };`, ts);
    // `mime:` value is not a key/comparison; `viewType:` value likewise. Neither
    // is a keying context — but note `mime: "application/pdf"` IS a property
    // VALUE, so it must NOT match. The object KEYS here are `viewType`/`mime`.
    expect(f).toEqual([]);
  });

  it("flags the chat renderable-view registry identifier keys ONLY in a .tsx module", () => {
    const registry = `const R = { content_change_proposal: Card, change_history: Card2 };`;
    expect(detectFindingsInSource("packages/chat/src/registry.tsx", registry, ts).map((f) => f.canonicalIdentity).sort()).toEqual([
      "change_history",
      "content_change_proposal",
    ]);
    // The same identifier keys in a .ts schema/fixtures module are NOT flagged.
    expect(detectFindingsInSource("packages/chat/src/schema.ts", registry, ts)).toEqual([]);
  });

  it("flags an object-type id keying only in a .tsx presentational module", () => {
    const src = `const g = id === "@cinatra-ai/asset-blog:post";`;
    expect(detectFindingsInSource("src/lib/blog/renderers.tsx", src, ts)).toHaveLength(1);
    expect(detectFindingsInSource("src/lib/blog/store.ts", src, ts)).toEqual([]); // materializer/store → not presentation
  });

  it("ignores a non-vocabulary literal and a package import specifier", () => {
    expect(detectFindingsInSource("src/x.ts", `const a = t === "application/json"; import("mermaid");`, ts)).toEqual([]);
  });

  it("flags a viewType/object-type ARRAY-element table in a .tsx module (lookup-table shape)", () => {
    // A .tsx renderer condition keyed by an x-renderer / type-id array table.
    const src = `const ok = ["@vendor/x:panel","panel"].includes(binding);`;
    const f = detectFindingsInSource("packages/agents/src/x-renderer.tsx", src, ts);
    expect(f.map((x) => [x.canonicalIdentity, x.keyingKind])).toEqual([["@vendor/x:panel", "array-element"]]);
  });

  it("REPRESENTATION array-element is swept INSIDE the rendering/preview-serving surface (closes the reshape bypass)", () => {
    const src = `const S = new Set(["application/pdf","text/plain"]);`;
    // artifact-read.ts (the inline-preview allowlist) IS the surface → swept.
    expect(detectFindingsInSource("src/lib/artifacts/artifact-read.ts", src, ts).map((f) => f.canonicalIdentity).sort()).toEqual([
      "application/pdf",
      "text/plain",
    ]);
    // the detail rendering surface too — a reshape of a pick-handler arm to an array is caught.
    expect(detectFindingsInSource("src/app/artifacts/[id]/pick-handler.ts", `const ok = ["application/pdf"].includes(mime);`, ts)).toHaveLength(1);
  });

  it("does NOT flag REPRESENTATION arrays OUTSIDE the surface (capability/protocol/authoring lists share the vocabulary)", () => {
    // Same shape + vocabulary, different purpose: LLM attachment support, A2A
    // protocol, authoring templates — NOT presentation, NOT swept.
    expect(detectFindingsInSource("packages/llm/src/x.ts", `const caps = ["image/","audio/mpeg"];`, ts)).toEqual([]);
    expect(detectFindingsInSource("src/lib/artifacts/artifact-authoring.ts", `const t = ["text/markdown","text/plain"];`, ts)).toEqual([]);
  });

  it("assigns stable, unique fingerprints per repeated arm (occurrence index)", () => {
    const src = `const a = m === "application/pdf"; const b = m === "application/pdf";`;
    const f = detectFindingsInSource("src/x.ts", src, ts);
    expect(f).toHaveLength(2);
    expect(f[0].occurrence).toBe(0);
    expect(f[1].occurrence).toBe(1);
    expect(f[0].fingerprint).not.toBe(f[1].fingerprint);
    expect(f[0].fingerprint).toBe(fingerprintOf(coreFields(f[0])));
  });

  it("classifyIdentity / keyingKindOf behave as documented", () => {
    expect(classifyIdentity("application/pdf", "src/x.ts")).toBe(IDENTITY_CLASS.REPRESENTATION);
    expect(classifyIdentity("content_change_proposal", "src/x.ts")).toBeNull(); // .ts → not presentation
    expect(classifyIdentity("content_change_proposal", "src/x.tsx")).toBe(IDENTITY_CLASS.VIEW_TYPE);
    expect(classifyIdentity("application/json", "src/x.tsx")).toBeNull();
  });
});

describe("baseline validation (G1)", () => {
  const good = {
    fingerprint: "",
    path: "src/x.ts",
    identityClass: "representation",
    canonicalIdentity: "application/pdf",
    keyingKind: "equality",
    occurrence: 0,
    disposition: "MIGRATE",
    owner: "artifact-ui S4",
    wave: "S4",
  };
  good.fingerprint = deriveFingerprint(good);

  it("accepts a well-formed MIGRATE entry", () => {
    expect(validateBaseline({ entries: [good] })).toEqual([]);
  });

  it("rejects UNCLASSIFIED, missing owner/wave, STAY-with-owner, STAY-without-rationale", () => {
    const unclassified = { ...good, disposition: "UNCLASSIFIED" };
    const noOwner = { ...good, owner: undefined, wave: undefined };
    const stayOwner = { ...good, disposition: "STAY", rationale: "r" };
    const stayNoRat = { ...good, disposition: "STAY", owner: undefined, wave: undefined };
    expect(validateBaseline({ entries: [unclassified] }).join()).toMatch(/MIGRATE\|DEFER\|STAY/);
    expect(validateBaseline({ entries: [noOwner] }).join()).toMatch(/require both owner and wave/);
    expect(validateBaseline({ entries: [stayOwner] }).join()).toMatch(/STAY entries must NOT carry owner\/wave/);
    expect(validateBaseline({ entries: [stayNoRat] }).join()).toMatch(/STAY entries require a rationale/);
  });

  it("rejects a fingerprint that does not authenticate, and duplicates", () => {
    const tampered = { ...good, fingerprint: "deadbeefdeadbeef" };
    expect(validateBaseline({ entries: [tampered] }).join()).toMatch(/does not authenticate/);
    expect(validateBaseline({ entries: [good, { ...good }] }).join()).toMatch(/duplicate fingerprint/);
  });
});

describe("ratchet set-diff + shrink-only growth (G1)", () => {
  const mk = (fp) => ({ fingerprint: fp, path: "src/x.ts", line: 1, canonicalIdentity: "application/pdf", identityClass: "representation", keyingKind: "equality" });

  it("diffFindings reports UNKNOWN live arms and STALE baseline entries", () => {
    const live = [mk("aaaa"), mk("bbbb")];
    const base = [mk("bbbb"), mk("cccc")];
    const { unknown, stale } = diffFindings(live, base);
    expect(unknown.map((f) => f.fingerprint)).toEqual(["aaaa"]);
    expect(stale.map((e) => e.fingerprint)).toEqual(["cccc"]);
  });

  it("SHRINK-ONLY PROBE: a baseline that GREW vs base is flagged (must fail)", () => {
    const base = [mk("aaaa"), mk("bbbb")];
    // committed added "cccc" that the base did not have — growth.
    const grownCommitted = [mk("aaaa"), mk("bbbb"), mk("cccc")];
    expect(baselineGrowth(base, grownCommitted).map((g) => g.fingerprint)).toEqual(["cccc"]);
    // a shrunk (subset) committed baseline is clean.
    expect(baselineGrowth(base, [mk("aaaa")])).toEqual([]);
  });
});

describe("gate CLI end-to-end (G1)", () => {
  it("passes on the committed, fully-dispositioned baseline (exit 0)", () => {
    const r = runGate();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/OK — .* presentation-identity arm/);
  });

  it("fails when an arm's baseline entry is dropped — the live arm becomes UNKNOWN (exit 1)", () => {
    const r = withMutatedBaseline((doc) => ({ ...doc, entries: doc.entries.slice(1) }), () => runGate());
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/UNKNOWN core→identity keying arm/);
  });

  it("fails when a disposition is left UNCLASSIFIED (exit 1)", () => {
    const r = withMutatedBaseline(
      (doc) => ({ ...doc, entries: doc.entries.map((e, i) => (i === 0 ? { ...e, disposition: "UNCLASSIFIED" } : e)) }),
      () => runGate(),
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/baseline invalid/);
  });
});
