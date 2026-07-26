import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Offline assertion layer for the WP MCP gateway captures (issue #2016, S1 §5).
//
// Runs in NORMAL PR CI (no boot): it asserts the COMMITTED transcripts under
// tests/e2e/wp-mcp-gateway/captures/ satisfy the five annotation-transport
// sub-claims (a/b/d/e/f), the exposure-mode record shape (§4), the drift-proof
// provenance block on every capture, and — once C5 lands — the four VERIFY
// verdict invariants. Paired with the REQUIRED capture-freshness gate
// (scripts/audit/wp-gateway-capture-freshness.mjs), so these assertions can never
// pass against a transcript that is stale vs the current pins / fixture / producer
// / api-map. Together they make "captures committed alongside the suite"
// self-checking and drift-proof on every PR (design §5, acceptance-criteria trace).
//
// The captures were produced ONLY on a runner against the booted pinned fixture
// (tests/e2e/wp-mcp-gateway/capture-annotations.mjs) — the operator box never
// boots. This test reads their bytes; it does no network I/O.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const CAPTURES_DIR = path.join(REPO_ROOT, "tests/e2e/wp-mcp-gateway/captures");
const SHA256_RE = /^[0-9a-f]{64}$/;
const CANONICAL_HASHES = ["pinsLockSha256", "fixturePluginSha256", "producerSha256", "apiMapSha256"];

const read = (name: string): any => JSON.parse(readFileSync(path.join(CAPTURES_DIR, name), "utf8"));

describe("WP MCP gateway captures — provenance (drift-proof)", () => {
  it("every capture EXCEPT the upstream api-map carries a provenance block (no drop-the-block bypass)", () => {
    const exempt = new Set(["adapter-0.5.0-api-map.json"]);
    for (const n of readdirSync(CAPTURES_DIR).filter((f) => f.endsWith(".json"))) {
      if (exempt.has(n)) continue;
      expect(read(n)?.provenance, `${n} must carry a provenance block`).toBeTruthy();
    }
  });

  it("every committed capture carries a provenance block with the four canonical sha256s", () => {
    const provenanced = readdirSync(CAPTURES_DIR)
      .filter((n) => n.endsWith(".json"))
      .map((n) => ({ n, j: read(n) }))
      .filter(({ j }) => j && j.provenance);
    // The six sub-claim transcripts + index + exposure-mode all carry provenance.
    expect(provenanced.length).toBeGreaterThanOrEqual(8);
    for (const { n, j } of provenanced) {
      const p = j.provenance;
      expect(typeof p.capturedAtCommit, `${n} capturedAtCommit`).toBe("string");
      expect(p.runUrl, `${n} runUrl`).toMatch(/^https:\/\/github\.com\//);
      for (const key of CANONICAL_HASHES) {
        expect(p[key], `${n} provenance.${key}`).toMatch(SHA256_RE);
      }
    }
  });
});

describe("WP MCP gateway captures — sub-claim (a) raw tools/list annotation transport", () => {
  const a = () => read("annotations-a-raw-tools-list.json");

  it("the read/write/destructive trio transports readOnly/destructive/idempotent hints", () => {
    const r = a().trioHintReport;
    expect(r["fixturelabs/note-get"].annotations.readOnlyHint).toBe(true);
    expect(r["fixturelabs/note-get"].annotations.destructiveHint).toBe(false);
    expect(r["fixturelabs/note-set"].annotations.readOnlyHint).toBe(false);
    expect(r["fixturelabs/note-set"].annotations.idempotentHint).toBe(true);
    expect(r["fixturelabs/note-delete"].annotations.destructiveHint).toBe(true);
  });

  it("both server routes answered a raw tools/list", () => {
    const j = a();
    expect(Array.isArray(j.defaultServer.tools)).toBe(true);
    expect(j.defaultServer.tools.length).toBeGreaterThan(0);
    expect(j.fixtureServer.tools.length).toBeGreaterThanOrEqual(6);
  });
});

describe("WP MCP gateway captures — sub-claim (b) MCP SDK preserves hints", () => {
  it("the SDK Client.listTools() ran and preserved the destructive hint on the fixture server", () => {
    const j = read("annotations-b-sdk-listtools.json");
    expect(j.defaultServer.sdkAvailable).toBe(true);
    expect(j.fixtureServer.sdkAvailable).toBe(true);
    expect(j.fixtureServer.transport).toBeTruthy();
    const del = (j.fixtureServer.tools || []).find((t: any) => t.name === "fixturelabs-note-delete");
    expect(del, "SDK listed fixturelabs-note-delete").toBeTruthy();
    expect(del.annotations.destructiveHint).toBe(true);
  });
});

describe("WP MCP gateway captures — sub-claim (c) gateway triad tools/call", () => {
  it("execute-ability returns a structured result for a fixture read ability", () => {
    const j = read("annotations-c-gateway-triad.json");
    const exec = j.calls.find((c: any) => c.abilityId.includes("execute"));
    expect(exec, "an execute-ability call was captured").toBeTruthy();
    expect(exec.response.status).toBe(200);
    expect(exec.response.parsed.result.structuredContent.success).toBe(true);
  });
});

describe("WP MCP gateway captures — sub-claim (d) eafm coverage annotations", () => {
  it("delete / search-replace / code-snippet coverage abilities are resolved (via get-ability-info under triad-only)", () => {
    const cov = read("annotations-d-eafm-coverage.json").coverageViaGetInfo;
    for (const id of ["ewpa/delete-post", "ewpa/search-replace", "ewpa/create-code-snippet"]) {
      expect(cov[id], `coverage for ${id}`).toBeTruthy();
      expect(cov[id].found).toBe(true);
      // annotations may be null (ewpa/* declare no hints) — the KEY must be present.
      expect(cov[id]).toHaveProperty("annotations");
    }
  });
});

describe("WP MCP gateway captures — sub-claim (e) edge-case annotations, as emitted", () => {
  const e = () => read("annotations-e-edge-cases.json").edgeReport;

  it("absent annotations stay absent", () => {
    expect(e()["fixturelabs/note-get-unannotated"].annotationsAsEmitted).toBeNull();
  });

  it("malformed annotation values are coerced (string 'true' -> true) and uninterpretable ones dropped", () => {
    const ann = e()["fixturelabs/note-get-malformed"].annotationsAsEmitted;
    expect(ann.readOnlyHint).toBe(true); // "true" coerced
    expect(ann).not.toHaveProperty("destructiveHint"); // "not-a-bool" dropped
    expect(ann).not.toHaveProperty("idempotentHint"); // 5 dropped
  });

  it("contradictory annotations (readOnly AND destructive) are transported as declared", () => {
    const ann = e()["fixturelabs/note-get-contradictory"].annotationsAsEmitted;
    expect(ann.readOnlyHint).toBe(true);
    expect(ann.destructiveHint).toBe(true);
  });

  it("each edge-case ability bound to its OWN distinct tool (no prefix mis-binding)", () => {
    const r = e();
    expect(r["fixturelabs/note-get-unannotated"].toolName).toBe("fixturelabs-note-get-unannotated");
    expect(r["fixturelabs/note-get-malformed"].toolName).toBe("fixturelabs-note-get-malformed");
    expect(r["fixturelabs/note-get-contradictory"].toolName).toBe("fixturelabs-note-get-contradictory");
  });
});

describe("WP MCP gateway captures — sub-claim (f) fixturelabs surfacing (hard)", () => {
  it("every fixturelabs trio ability is discoverable through the eafm/default aggregator", () => {
    const j = read("annotations-f-fixturelabs-surfacing.json");
    for (const id of ["fixturelabs/note-get", "fixturelabs/note-set", "fixturelabs/note-delete"]) {
      expect(j.surfacing[id].discoverable, `${id} discoverable`).toBe(true);
    }
    expect(j.hardFailures).toEqual([]);
  });
});

describe("WP MCP gateway captures — exposure-mode record (§4)", () => {
  it("records a valid mode with versions, evidence and a run URL", () => {
    const m = read("exposure-mode.json");
    expect(["first-class", "triad-only"]).toContain(m.mode);
    expect(m.versions).toMatchObject({ wp: expect.any(String), mcpAdapter: expect.any(String), eafm: expect.any(String) });
    expect(m.runUrl).toMatch(/^https:\/\/github\.com\//);
    expect(existsSync(path.join(CAPTURES_DIR, m.evidence)), `evidence file ${m.evidence} exists`).toBe(true);
  });
});

describe("WP MCP gateway captures — VERIFY verdicts (present from C5)", () => {
  const verdictsPath = path.join(CAPTURES_DIR, "verify-verdicts.json");
  const VERIFY_ITEMS = ["ewpa/create-post", "ewpa/upload-image", "ewpa/update-post-meta", "ewpa/get-posts"];

  it.runIf(existsSync(verdictsPath))(
    "records a PASS|FAIL verdict for each of the four VERIFY items; every FAIL names a fallback that never re-authors a cinatra ability",
    () => {
      const doc = JSON.parse(readFileSync(verdictsPath, "utf8"));
      const byItem = new Map<string, any>(doc.verdicts.map((v: any) => [v.item, v]));
      for (const item of VERIFY_ITEMS) {
        const v = byItem.get(item);
        expect(v, `verdict for ${item}`).toBeTruthy();
        expect(["PASS", "FAIL"]).toContain(v.verdict);
        expect(typeof v.evidence).toBe("string");
        if (v.verdict === "FAIL") {
          expect(v.fallback, `${item} FAIL fallback`).toBeTruthy();
          const fb = JSON.stringify(v.fallback).toLowerCase();
          // The AC is absolute: a FAIL fallback is another site ability, an S6
          // site-side config filter, or an upstream contribution — NEVER
          // re-authoring a cinatra ability.
          expect(fb).not.toMatch(/re-?author|author (?:a )?cinatra ability/);
          expect(fb).toMatch(/site ability|config filter|s6|upstream/);
        }
      }
    },
  );
});
