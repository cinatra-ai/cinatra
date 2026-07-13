// Shared loader + fail-closed resolver for the stateful-service upgrade matrix
// (docs/architecture/upgrade-matrix.json). This is the CONSUMPTION CONTRACT in
// code: cinatra-cli (preflight + `db upgrade-major`) and the cinatra works-after
// harness resolve every source->target transition through THIS logic, against
// the SAME matrix revision, so neither can silently act on a different revision.
//
// Slice 1 of the upgrade-paths epic (cinatra#1420 / cinatra#1419). Dependency-
// free (no yaml/ajv dep — repo convention); structural conformance is gated by
// scripts/check-upgrade-matrix.mjs + scripts/ci/__tests__/upgrade-matrix.test.mjs.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
export const MATRIX_PATH = join(HERE, "..", "..", "docs", "architecture", "upgrade-matrix.json");

// The revision + schema-major a consumer in THIS tree is built against. A
// consumer in another repo (cinatra-cli) vendors/reads the matrix and pins its
// own copy of these two constants; assertMatrixRevision below is how both sides
// stay fail-closed on skew.
export const MATRIX_REVISION = 2;
export const MATRIX_SCHEMA_MAJOR = 1;

/** Load and JSON-parse the matrix (no schema validation — that is the check script's job). */
export function loadUpgradeMatrix(path = MATRIX_PATH) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Fail-closed skew guard. Throws unless the loaded matrix's schemaVersion MAJOR
 * and revision match what the caller was built against. A consumer MUST call
 * this before acting on the matrix.
 * @param {object} matrix
 * @param {{ revision?: number, schemaMajor?: number }} [expected]
 */
export function assertMatrixRevision(matrix, expected = {}) {
  const wantRev = expected.revision ?? MATRIX_REVISION;
  const wantMajor = expected.schemaMajor ?? MATRIX_SCHEMA_MAJOR;
  const gotMajor = Number(String(matrix.schemaVersion).split(".")[0]);
  if (gotMajor !== wantMajor) {
    throw new Error(
      `upgrade-matrix schemaVersion major ${gotMajor} != expected ${wantMajor} — unparseable contract (fail-closed).`,
    );
  }
  if (matrix.revision !== wantRev) {
    throw new Error(
      `upgrade-matrix revision ${matrix.revision} != expected ${wantRev} — consumer/matrix skew (fail-closed).`,
    );
  }
  return matrix;
}

/** @param {object} matrix @param {string} serviceId */
export function getService(matrix, serviceId) {
  return matrix.services.find((s) => s.id === serviceId) ?? null;
}

/**
 * Resolve a (service, from, to) tuple to a decision. FAIL-CLOSED: anything not
 * explicitly listed as a supported transition or a case exception resolves to
 * { supported: false, reason: "unsupported" }. Never returns a best-effort
 * "maybe".
 *
 * @param {object} matrix
 * @param {string} serviceId  matrix service id (e.g. "platform-postgres")
 * @param {string} from       deployed source version/major
 * @param {string} to         target version/major
 * @returns {{ supported: boolean, mechanism: string|null, source: "transition"|"case-exception"|"default", reason?: string, notes?: string }}
 */
export function resolveTransition(matrix, serviceId, from, to) {
  const svc = getService(matrix, serviceId);
  if (!svc) {
    return { supported: false, mechanism: null, source: "default", reason: `unknown-service:${serviceId}` };
  }
  // Case exceptions win (concrete named cases like the pre-baseline nango pg15).
  for (const ex of matrix.caseExceptions ?? []) {
    if (ex.service === serviceId && ex.from === from && ex.to === to) {
      return { supported: true, mechanism: svc.migrationMechanism, source: "case-exception", notes: ex.notes };
    }
  }
  for (const t of svc.transitions ?? []) {
    if (t.from === from && t.to === to) {
      return t.supported
        ? { supported: true, mechanism: t.mechanism, source: "transition", notes: t.notes }
        : { supported: false, mechanism: t.mechanism, source: "transition", reason: "explicitly-unsupported", notes: t.notes };
    }
  }
  // Not enumerated anywhere -> fail-closed default.
  return { supported: false, mechanism: null, source: "default", reason: matrix.failClosed?.default ?? "unsupported" };
}

/** The set of top-level families the epic requires the matrix to cover. */
export const REQUIRED_FAMILIES = Object.freeze([
  "postgres",
  "mariadb",
  "neo4j",
  "redis",
  "valkey",
  "rabbitmq",
  "minio",
  "verdaccio",
  "graphiti",
]);
