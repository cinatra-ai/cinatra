// Upgrade-matrix gate (upgrade-paths slice 1, cinatra#1420): unit tests over
// the pure core + the LIVE enforcement test. The live test IS the CI
// completeness gate: it runs schema + volume-completeness + pin-drift +
// floating-tag + fail-closed checks against THIS repo's docker-compose.yml and
// docs/architecture/upgrade-matrix.json inside the root Vitest suite, so a new
// stateful service (new named volume), a compose pin bump without a matrix
// update, or a reintroduced floating tag reds a required check.
//
// The injected-regression tests below prove the gate is not a no-op.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { collectProblems, parseCompose } from "../../check-upgrade-matrix.mjs";
import {
  MATRIX_REVISION,
  MATRIX_SCHEMA_MAJOR,
  REQUIRED_FAMILIES,
  assertMatrixRevision,
  loadUpgradeMatrix,
  resolveTransition,
} from "../../lib/upgrade-matrix.mjs";

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const composeText = readFileSync(path.join(REPO_ROOT, "docker-compose.yml"), "utf8");
const matrix = JSON.parse(readFileSync(path.join(REPO_ROOT, "docs/architecture/upgrade-matrix.json"), "utf8"));
const schema = JSON.parse(readFileSync(path.join(REPO_ROOT, "docs/architecture/upgrade-matrix.schema.json"), "utf8"));

const clone = (o) => JSON.parse(JSON.stringify(o));

describe("upgrade-matrix LIVE gate (the CI completeness/pin-drift check of record)", () => {
  it("the committed matrix is schema-valid, complete against compose, pin-synced, and fail-closed", () => {
    const { errors, stats } = collectProblems({ composeText, matrix, schema });
    expect(errors).toEqual([]);
    expect(stats.revision).toBe(MATRIX_REVISION);
    expect(stats.caseExceptions).toBeGreaterThanOrEqual(1);
  });

  it("compose carries no floating :latest/:stable tag (the two frozen tags stay frozen)", () => {
    const { services } = parseCompose(composeText);
    const floating = Object.entries(services)
      .filter(([, s]) => s.image && /:(latest|stable)$/.test(s.image))
      .map(([name, s]) => `${name} -> ${s.image}`);
    expect(floating).toEqual([]);
  });

  it("every required family is covered", () => {
    const families = new Set(matrix.services.map((s) => s.family));
    for (const f of REQUIRED_FAMILIES) expect(families, `family ${f}`).toContain(f);
  });

  it("#1417's pre-baseline nango pg15 volume is a CASE-SCOPED exception, not a baseline widening", () => {
    const ex = matrix.caseExceptions.find((e) => e.case === "nango-15-to-17");
    expect(ex).toBeTruthy();
    expect(ex.issue).toBe("cinatra#1417");
    // ...and it is NOT also a supported general transition.
    const nango = matrix.services.find((s) => s.id === "nango-postgres");
    expect(nango.transitions.find((t) => t.from === "15" && t.to === "17")).toBeUndefined();
  });

  it("#1417's platform 17->18 is the supported BASELINE transition (0.1.9 ships 18)", () => {
    const pg = matrix.services.find((s) => s.id === "platform-postgres");
    const t = pg.transitions.find((x) => x.from === "17" && x.to === "18");
    expect(t?.supported).toBe(true);
    expect(t?.mechanism).toBe("logical-dump-restore");
  });
});

describe("injected regressions (proves the gate is not a no-op)", () => {
  it("a NEW named volume in compose without a matrix classification FAILS", () => {
    const mutated = composeText + "\n";
    const withVolume = mutated.replace(/^volumes:\s*$/m, "volumes:\n  cinatra-new-unclassified-store:");
    const { errors } = collectProblems({ composeText: withVolume, matrix, schema });
    expect(errors.join("\n")).toMatch(/completeness: compose volume 'cinatra-new-unclassified-store' has no matrix service/);
  });

  it("a compose pin bump without a matrix update FAILS (pin drift)", () => {
    const drifted = composeText.replace(
      "image: postgres:18-alpine@sha256:9a8afca54e7861fd90fab5fdf4c42477a6b1cb7d293595148e674e0a3181de15",
      "image: postgres:19-alpine",
    );
    expect(drifted).not.toBe(composeText); // the pin we expect to exist was found
    const { errors } = collectProblems({ composeText: drifted, matrix, schema });
    expect(errors.join("\n")).toMatch(/pin-drift: 'platform-postgres'/);
  });

  it("a reintroduced floating tag FAILS", () => {
    const refloated = composeText.replace(
      /image: minio\/minio:RELEASE\.[^\n]+/,
      "image: minio/minio:latest",
    );
    expect(refloated).not.toBe(composeText);
    const { errors } = collectProblems({ composeText: refloated, matrix, schema });
    expect(errors.join("\n")).toMatch(/floating-tag: service 'plane-minio' still on a floating tag/);
  });

  it("a stale matrix volume (removed from compose) FAILS", () => {
    const m = clone(matrix);
    m.services.push({ ...clone(m.services[0]), id: "ghost", composeService: "postgres", volume: "ghost-volume" });
    const { errors } = collectProblems({ composeText, matrix: m, schema });
    expect(errors.join("\n")).toMatch(/completeness: matrix volume 'ghost-volume' is not a top-level compose volume/);
  });

  it("a schema violation FAILS (unknown family)", () => {
    const m = clone(matrix);
    m.services[0].family = "mongodb";
    const { errors } = collectProblems({ composeText, matrix: m, schema });
    expect(errors.join("\n")).toMatch(/schema: .*family/);
  });

  it("flipping the fail-closed default FAILS", () => {
    const m = clone(matrix);
    m.failClosed.default = "best-effort";
    const { errors } = collectProblems({ composeText, matrix: m, schema });
    expect(errors.join("\n")).toMatch(/fail-closed: failClosed.default must be "unsupported"/);
  });

  it("a case exception that duplicates a supported general transition FAILS (baseline-widening ambiguity)", () => {
    const m = clone(matrix);
    m.caseExceptions.push({
      case: "dup-platform-17-to-18",
      service: "platform-postgres",
      from: "17",
      to: "18",
      issue: "cinatra#0",
      notes: "duplicate of the baseline transition",
    });
    const { errors } = collectProblems({ composeText, matrix: m, schema });
    expect(errors.join("\n")).toMatch(/case-exception: 'dup-platform-17-to-18' duplicates supported general transition/);
  });

  it("a case exception referencing an unknown service FAILS", () => {
    const m = clone(matrix);
    m.caseExceptions.push({ case: "x", service: "nope", from: "1", to: "2", issue: "cinatra#0", notes: "n" });
    const { errors } = collectProblems({ composeText, matrix: m, schema });
    expect(errors.join("\n")).toMatch(/case-exception: 'x' references unknown service 'nope'/);
  });
});

describe("resolveTransition — the shared fail-closed consumption contract", () => {
  const live = loadUpgradeMatrix(path.join(REPO_ROOT, "docs/architecture/upgrade-matrix.json"));

  it("platform 17->18 resolves supported via the general baseline transition", () => {
    const r = resolveTransition(live, "platform-postgres", "17", "18");
    expect(r).toMatchObject({ supported: true, source: "transition", mechanism: "logical-dump-restore" });
  });

  it("nango 15->17 resolves supported via the CASE EXCEPTION (pre-baseline #1417 case)", () => {
    const r = resolveTransition(live, "nango-postgres", "15", "17");
    expect(r).toMatchObject({ supported: true, source: "case-exception", mechanism: "logical-dump-restore" });
  });

  it("nango 16->17 (not enumerated) fails CLOSED to unsupported", () => {
    const r = resolveTransition(live, "nango-postgres", "16", "17");
    expect(r).toMatchObject({ supported: false, source: "default", reason: "unsupported" });
  });

  it("platform 18->19 is EXPLICITLY unsupported (prerelease target)", () => {
    const r = resolveTransition(live, "platform-postgres", "18", "19");
    expect(r).toMatchObject({ supported: false, source: "transition", reason: "explicitly-unsupported" });
  });

  it("mariadb 11.4->12.0 skipping 11.8 is EXPLICITLY unsupported (sequential-only)", () => {
    const r = resolveTransition(live, "wordpress-mariadb", "11.4", "12.0");
    expect(r).toMatchObject({ supported: false, source: "transition" });
  });

  it("an unknown service fails CLOSED", () => {
    const r = resolveTransition(live, "mystery-store", "1", "2");
    expect(r.supported).toBe(false);
    expect(r.reason).toMatch(/^unknown-service:/);
  });

  it("an unclassified minio `latest` source fails CLOSED until the preflight ledger classifies it", () => {
    const r = resolveTransition(live, "plane-minio", "unknown-latest", "RELEASE.2025-09-07T16-13-09Z");
    expect(r).toMatchObject({ supported: false, source: "transition", reason: "explicitly-unsupported" });
  });
});

describe("assertMatrixRevision — fail-closed consumer/matrix skew guard", () => {
  it("accepts the revision + schema major this tree is built against", () => {
    expect(() => assertMatrixRevision(matrix)).not.toThrow();
    expect(MATRIX_SCHEMA_MAJOR).toBe(Number(String(matrix.schemaVersion).split(".")[0]));
  });

  it("throws on a revision skew", () => {
    const m = clone(matrix);
    m.revision = MATRIX_REVISION + 1;
    expect(() => assertMatrixRevision(m)).toThrow(/consumer\/matrix skew/);
  });

  it("throws on a schemaVersion MAJOR mismatch (unparseable contract)", () => {
    const m = clone(matrix);
    m.schemaVersion = `${MATRIX_SCHEMA_MAJOR + 1}.0.0`;
    expect(() => assertMatrixRevision(m)).toThrow(/unparseable contract/);
  });
});

describe("parseCompose", () => {
  it("resolves ${VAR:-default} image defaults (the PLANE_TAG knob)", () => {
    const { services } = parseCompose("services:\n  a:\n    image: repo/x:${TAG:-v1.2.3@sha256:aa}\n");
    expect(services.a.image).toBe("repo/x:v1.2.3@sha256:aa");
  });

  it("collects named volume mounts and top-level volumes", () => {
    const { services, topVolumes } = parseCompose(
      "services:\n  a:\n    image: x:1\n    volumes:\n      - data-vol:/var/lib/x\n      - ./bind:/etc/x\nvolumes:\n  data-vol:\n",
    );
    expect([...services.a.volumes]).toContain("data-vol");
    expect([...topVolumes]).toEqual(["data-vol"]);
  });
});
