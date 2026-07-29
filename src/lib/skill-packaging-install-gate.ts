import "server-only";

// ---------------------------------------------------------------------------
// Host reader + PRE-FINALIZE install gate for SKILL PACKAGING (cinatra#2089,
// epic #2086 S2).
//
// The THIRD consumer of the shared verdict
// (`scripts/audit/_lib/skill-packaging-verdict.mjs`) — the same module CI runs
// and the extension repos' publish gate vendors — so a non-conforming extension
// is refused with THE SAME verdict text wherever it is met:
//
//   - a `kind:"skill"` extension must ship EXACTLY ONE Anthropic-schema bundle,
//     carry the singular `-skill` package name, and its SKILL.md router must
//     validate (schema, directory-name ≡ frontmatter name, router length, the
//     ONE-HOP reference lint, and the upload size boundary);
//   - a NON-skill extension must contain NO `SKILL.md` at ANY path outside the
//     shared fixture allowlist (`config/skill-fixture-allowlist.json`).
//
// The one-hop reference lint is the enforcement half of #2088's diagnostic: S1
// computed `captureDiagnostics.danglingReferences` and explicitly assigned
// fail-closed enforcement to S2. Here a dangling router reference REFUSES the
// install; on the sync path it refuses the upload candidate.
//
// PLACEMENT. The gate runs in the install pipeline's INERT window — after the
// SRI-verified materialization, BEFORE `beginInstallOp` — with the same
// GC-on-refuse contract as the access/assistant reads, so a refused install
// leaves nothing durable and nothing on disk.
//
// SEQUENCING. The epic's DAG runs S2 before S3 (the migration wave), so every
// `kind:"skill"` package that exists today is non-conforming. The verdict is
// therefore fail-closed WITH AN ENUMERATED LEDGER
// (`config/skill-packaging-legacy-exceptions.json`): exactly the recorded
// (package, code) pairs are waived and logged; a new package, or a new
// violation class on a listed package, is refused. The same ledger governs CI.
// The non-skill SKILL.md ban is likewise ratcheted for the already-installed
// universe (see `legacyEmbeddedSkillKeys`), so S3's migration — not this gate —
// is what removes the existing embedded skills.
// ---------------------------------------------------------------------------

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import fixtureAllowlistPolicy from "../../config/skill-fixture-allowlist.json";
import legacyLedger from "../../config/skill-packaging-legacy-exceptions.json";

// The shared verdict is a dependency-free `.mjs` ON PURPOSE (it is vendored
// verbatim into public extension repos whose CI has no TypeScript); its
// companion `.d.mts` gives this seam full type safety over the very same
// module, so the host never re-implements the rules.
import {
  VERDICT_CONTRACT_VERSION,
  SKILL_ROUTER_FILENAME,
  applyLegacyExceptions,
  formatViolations,
  resolveFixtureAllowlist,
  validateNonSkillExtensionPackage,
  validateSkillExtensionPackage,
  type SkillPackagingViolation,
} from "../../scripts/audit/_lib/skill-packaging-verdict.mjs";

export type { SkillPackagingViolation };

/** The packaging signals read off a materialized package. */
export type SkillPackagingSignals = {
  packageName: string;
  kind: string;
  violations: SkillPackagingViolation[];
  waived: SkillPackagingViolation[];
};

/** Refusal raised by the pre-finalize skill-packaging gate. */
export class SkillPackagingConstraintError extends Error {
  readonly violations: SkillPackagingViolation[];
  constructor(message: string, violations: SkillPackagingViolation[]) {
    super(`[skill-packaging] ${message}`);
    this.name = "SkillPackagingConstraintError";
    this.violations = violations;
  }
}

const SKIP_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  ".turbo",
]);

/** Walk a materialized package, returning POSIX package-relative file paths. */
async function walkPackageFiles(root: string): Promise<{ path: string; byteLength: number }[]> {
  const out: { path: string; byteLength: number }[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue; // never follow a link out of the package
      if (e.isDirectory()) {
        if (SKIP_DIR_NAMES.has(e.name)) continue;
        await walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      let byteLength = 0;
      try {
        byteLength = (await stat(full)).size;
      } catch {
        /* unreadable → counted as 0; the read below surfaces a real failure */
      }
      out.push({ path: path.relative(root, full).split(path.sep).join("/"), byteLength });
    }
  }
  await walk(root);
  return out;
}

/**
 * Group a package's files into skill bundles + strays. The canonical authoring
 * layout is `skills/<name>/SKILL.md`; a router at any other depth is a stray
 * (it is not a bundle root the packager would ever upload).
 */
export function groupPackageBundles(files: string[]): {
  bundles: { relDir: string; dirName: string; routerRel: string }[];
  strays: string[];
} {
  const routers = files.filter(
    (f) => f === SKILL_ROUTER_FILENAME || f.endsWith(`/${SKILL_ROUTER_FILENAME}`),
  );
  const bundles: { relDir: string; dirName: string; routerRel: string }[] = [];
  const strays: string[] = [];
  for (const router of routers) {
    const dir =
      router === SKILL_ROUTER_FILENAME
        ? ""
        : router.slice(0, -(SKILL_ROUTER_FILENAME.length + 1));
    const segments = dir === "" ? [] : dir.split("/");
    if (segments.length !== 2 || segments[0] !== "skills") {
      strays.push(router);
      continue;
    }
    bundles.push({ relDir: dir, dirName: segments[1], routerRel: router });
  }
  return { bundles, strays };
}

type PolicyDocuments = {
  /** `config/skill-fixture-allowlist.json`. */
  allowlistPolicy: unknown;
  /** `config/skill-packaging-legacy-exceptions.json`. */
  ledger: unknown;
  /**
   * `<packageName> :: <relPath>` keys for embedded skills that already exist
   * in the installed universe (the S3 migration wave removes them). Anything
   * NOT in this set is a new embedded skill and is refused.
   */
  legacyEmbeddedSkillKeys: ReadonlySet<string>;
};

/**
 * Compute the packaging verdict for a materialized package. PURE with respect
 * to the policy documents (they are passed in), so the same function is
 * exercised by unit tests with fixture policies.
 */
export async function computeSkillPackagingSignals(
  storeDir: string,
  policies: PolicyDocuments,
): Promise<SkillPackagingSignals> {
  const manifestRaw = await readFile(path.join(storeDir, "package.json"), "utf8");
  const manifest = JSON.parse(manifestRaw) as {
    name?: string;
    cinatra?: Record<string, unknown>;
  };
  const packageName = typeof manifest.name === "string" ? manifest.name : "(unnamed)";
  const kind = typeof manifest.cinatra?.kind === "string" ? (manifest.cinatra.kind as string) : "";

  const files = await walkPackageFiles(storeDir);
  const filePaths = files.map((f) => f.path);

  if (kind === "skill") {
    const { bundles, strays } = groupPackageBundles(filePaths);
    const resolved: {
      dirName: string;
      relDir: string;
      routerText: string;
      files: { path: string; byteLength: number }[];
    }[] = [];
    for (const b of bundles) {
      let routerText = "";
      try {
        routerText = await readFile(path.join(storeDir, b.routerRel), "utf8");
      } catch {
        /* an unreadable router yields an invalid-frontmatter violation below */
      }
      const prefix = `${b.relDir}/`;
      resolved.push({
        dirName: b.dirName,
        relDir: `${packageName}/${b.relDir}`,
        routerText,
        files: files
          .filter((f) => f.path.startsWith(prefix))
          .map((f) => ({ path: f.path.slice(prefix.length), byteLength: f.byteLength })),
      });
    }
    const raw = validateSkillExtensionPackage({
      packageName,
      manifest: manifest.cinatra ?? {},
      straySkillMdPaths: strays,
      bundles: resolved,
    });
    const { blocking, waived } = applyLegacyExceptions(raw, {
      packageName,
      ledger: policies.ledger,
    });
    return { packageName, kind, violations: blocking, waived };
  }

  // A package with no declared cinatra.kind is not an extension this gate owns.
  if (kind === "") return { packageName, kind, violations: [], waived: [] };

  const allowlist = resolveFixtureAllowlist(policies.allowlistPolicy, "__extension-repo__");
  const skillMdPaths = filePaths.filter(
    (f) => f === SKILL_ROUTER_FILENAME || f.endsWith(`/${SKILL_ROUTER_FILENAME}`),
  );
  const found = validateNonSkillExtensionPackage({
    packageName,
    kind,
    skillMdPaths,
    allowlist,
  });
  const violations: SkillPackagingViolation[] = [];
  const waived: SkillPackagingViolation[] = [];
  for (const v of found) {
    const key = `${packageName} :: ${v.path}`;
    (policies.legacyEmbeddedSkillKeys.has(key) ? waived : violations).push(v);
  }
  return { packageName, kind, violations, waived };
}

/**
 * The HOST reader the default pipeline factory wires: the same verdict over the
 * repo's own policy artifacts. The two documents are IMPORTED (not read from
 * disk at request time) so the built image always carries exactly the policy the
 * image was built from — the store-install seam can never diverge from the CI
 * gate that ran on the same commit.
 */
export async function readSkillPackagingSignalsFromStore(
  storeDir: string,
): Promise<SkillPackagingSignals> {
  return computeSkillPackagingSignals(storeDir, {
    allowlistPolicy: fixtureAllowlistPolicy,
    ledger: legacyLedger,
    legacyEmbeddedSkillKeys: new Set(
      Array.isArray(legacyLedger.embeddedSkills) ? legacyLedger.embeddedSkills : [],
    ),
  });
}

// ---------------------------------------------------------------------------
// Install-pipeline seam
// ---------------------------------------------------------------------------

export type SkillPackagingInstallDeps = {
  /**
   * Read the packaging verdict off the materialized store dir. Runs EARLY (with
   * the host-compat / dependency-edge / access reads, before any durable
   * mutation, same inertness + GC contract) so a refused install is fully
   * inert. OPTIONAL — omitted in unit tests (then no packaging gate runs); the
   * default factory always wires the host reader.
   */
  readSkillPackagingSignals?: (storeDir: string) => Promise<SkillPackagingSignals>;
};

type SkillPackagingReadDeps = SkillPackagingInstallDeps & {
  gcStoreDir?: (storeDir: string) => Promise<void>;
};

/**
 * PRE-FINALIZE skill-packaging install GATE — the pipeline seam. Reads the
 * verdict, then refuses the install when it carries any blocking violation.
 * Waived violations are LOGGED (never silent): an operator must be able to see
 * that a legacy package installed only because the S3 ledger still lists it.
 *
 * `isLiveDigest` is a THUNK evaluated at each original point (once for the
 * reader, again in the constraint catch), mirroring the access/assistant seams.
 */
export async function enforceSkillPackagingGateInertly(
  deps: SkillPackagingReadDeps,
  input: {
    storeDir: string;
    packageName: string;
    /**
     * True when the just-materialized dir IS the live install's dir (the
     * same-digest re-install guard) — GC must then never run.
     *
     * A THUNK, evaluated at each original point, mirroring the access/assistant
     * seams. Callers MUST fail SAFE here: when the prior finalized install-op
     * recorded no digest (a legacy row), the caller cannot prove the dir is not
     * the live one and must report `true`.
     */
    isLiveDigest: () => boolean;
  },
): Promise<void> {
  if (!deps.readSkillPackagingSignals) return;
  let signals: SkillPackagingSignals;
  try {
    signals = await deps.readSkillPackagingSignals(input.storeDir);
  } catch (err) {
    if (deps.gcStoreDir && !input.isLiveDigest()) {
      try {
        await deps.gcStoreDir(input.storeDir);
      } catch {
        /* best-effort GC — a leftover dir is recovered by a later retry's gate. */
      }
    }
    throw err;
  }

  if (signals.waived.length > 0) {
    console.warn(
      `[skill-packaging] ${input.packageName}: ${signals.waived.length} packaging violation(s) ` +
        `WAIVED by the enumerated legacy ledger (cinatra#2090 removes them): ` +
        signals.waived.map((v) => `[${v.code}] ${v.message}`).join(" | "),
    );
  }
  if (signals.violations.length === 0) return;

  const detail = formatViolations(signals.violations, input.packageName);
  const err = new SkillPackagingConstraintError(
    `refusing to install ${input.packageName} — it does not conform to the skill packaging contract ` +
      `(verdict v${VERDICT_CONTRACT_VERSION}; the SAME verdict CI and the extension repo's publish gate ` +
      `apply):\n${detail}`,
    signals.violations,
  );
  if (deps.gcStoreDir && !input.isLiveDigest()) {
    try {
      await deps.gcStoreDir(input.storeDir);
    } catch {
      /* best-effort GC — a leftover dir is recovered by a later retry's gate. */
    }
  }
  throw err;
}
