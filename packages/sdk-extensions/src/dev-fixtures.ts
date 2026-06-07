// Extension-declared DEV-MODE fixtures contract (declarative-only).
//
// An extension MAY declare `cinatra.devFixtures` (a path, recommended
// `cinatra/dev-fixtures.json`) pointing at a DECLARATIVE fixture file: demo /
// sample data the host's dev-only seeder applies into the extension's OWN
// `ctx.objects` / `ctx.settings` surfaces (org-scoped to a host-resolved dev
// org) so a freshly-installed extension is visible + exercisable on a dev boot.
//
// DECLARATIVE-ONLY by contract — data, never code: no `sql`, no `js`, no seed
// FUNCTION. The only allowed target surfaces are `setting` and `object`. There
// is deliberately NO way to target secrets, RBAC grants, `installed_extension`,
// or core tables (the surface enum makes those structurally impossible, and the
// seeder writes settings only inside the extension's own `ext:<pkg>:` namespace).
//
// This module is LEAF (no host imports, no deps — the SDK has zero runtime
// dependencies). The validator is hand-rolled rather than zod so the contract
// package stays dependency-free. The same rules are mirrored by the static CI
// gate `scripts/audit/dev-fixtures-gate.mjs`.

/** A non-secret config fixture written to `ctx.settings` (`ext:<pkg>:<orgId>:<key>`). */
export type DevFixtureSetting = {
  id: string;
  surface: "setting";
  key: string;
  value: unknown;
};

/** A structured-record fixture written to `ctx.objects`. */
export type DevFixtureObject = {
  id: string;
  surface: "object";
  typeId: string;
  data: Record<string, unknown>;
};

export type DevFixture = DevFixtureSetting | DevFixtureObject;

export type DevFixtureFile = {
  /** Fixture-set revision; bumping it lets the seeder REPLACE older still-fixture-owned rows. Default 1. */
  version: number;
  fixtures: DevFixture[];
};

export const DEV_FIXTURE_SURFACES = ["setting", "object"] as const;

// Keys that would imply executable / non-declarative content, or a target
// outside the allowed surfaces. Rejected anywhere in a fixture entry.
const FORBIDDEN_FIXTURE_KEYS = ["sql", "js", "fn", "function", "exec", "eval", "secret", "secrets"];

export class DevFixtureValidationError extends Error {
  constructor(message: string) {
    super(`[dev-fixtures] ${message}`);
    this.name = "DevFixtureValidationError";
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function assertNoForbiddenKeys(obj: Record<string, unknown>, where: string): void {
  for (const k of Object.keys(obj)) {
    if (FORBIDDEN_FIXTURE_KEYS.includes(k.toLowerCase())) {
      throw new DevFixtureValidationError(
        `${where}: forbidden key "${k}" — dev fixtures are declarative data only (no SQL/JS/secrets).`,
      );
    }
  }
}

/**
 * Validate + normalize a parsed `dev-fixtures.json`. Fail-LOUD: throws
 * `DevFixtureValidationError` on any structural violation. Returns the typed,
 * normalized file (version defaulted to 1). `raw` is the already-JSON-parsed
 * value (callers own file IO so this stays leaf).
 */
export function parseDevFixtures(raw: unknown): DevFixtureFile {
  if (!isPlainObject(raw)) {
    throw new DevFixtureValidationError("top-level must be an object `{ version?, fixtures: [...] }`.");
  }
  if (!("fixtures" in raw) || !Array.isArray(raw.fixtures)) {
    throw new DevFixtureValidationError("`fixtures` must be an array.");
  }
  if (raw.fixtures.length === 0) {
    throw new DevFixtureValidationError("`fixtures` must declare at least one entry (or omit `devFixtures`).");
  }
  let version = 1;
  if ("version" in raw && raw.version !== undefined) {
    if (typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 1) {
      throw new DevFixtureValidationError("`version` must be a positive integer when present.");
    }
    version = raw.version;
  }

  const seenIds = new Set<string>();
  const fixtures: DevFixture[] = raw.fixtures.map((entry, i) => {
    const where = `fixtures[${i}]`;
    if (!isPlainObject(entry)) throw new DevFixtureValidationError(`${where}: must be an object.`);
    assertNoForbiddenKeys(entry, where);

    const id = entry.id;
    if (typeof id !== "string" || id.trim().length === 0) {
      throw new DevFixtureValidationError(`${where}: \`id\` must be a non-empty string (stable fixture id).`);
    }
    if (seenIds.has(id)) {
      throw new DevFixtureValidationError(`${where}: duplicate fixture id "${id}".`);
    }
    seenIds.add(id);

    const surface = entry.surface;
    if (surface !== "setting" && surface !== "object") {
      throw new DevFixtureValidationError(
        `${where}: \`surface\` must be one of ${JSON.stringify(DEV_FIXTURE_SURFACES)} (got ${JSON.stringify(surface)}).`,
      );
    }

    if (surface === "setting") {
      if (typeof entry.key !== "string" || entry.key.trim().length === 0) {
        throw new DevFixtureValidationError(`${where}: a setting fixture needs a non-empty string \`key\`.`);
      }
      if (!("value" in entry) || entry.value === undefined) {
        throw new DevFixtureValidationError(`${where}: a setting fixture needs a \`value\` (any JSON-serializable value).`);
      }
      return { id, surface: "setting", key: entry.key, value: entry.value };
    }

    // surface === "object"
    if (typeof entry.typeId !== "string" || entry.typeId.trim().length === 0) {
      throw new DevFixtureValidationError(`${where}: an object fixture needs a non-empty string \`typeId\`.`);
    }
    if (!isPlainObject(entry.data)) {
      throw new DevFixtureValidationError(`${where}: an object fixture needs a \`data\` object.`);
    }
    assertNoForbiddenKeys(entry.data, `${where}.data`);
    return { id, surface: "object", typeId: entry.typeId, data: entry.data };
  });

  return { version, fixtures };
}
