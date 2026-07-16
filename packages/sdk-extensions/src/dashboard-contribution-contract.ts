// Shared DASHBOARD-CONTRIBUTION manifest contract (cinatra#1628, S11a).
//
// Re-homes extension-shipped dashboards off the dying `kind:"workflow"` carrier
// onto a versioned `cinatra.dashboardContribution` manifest claim, authored on
// `kind:"agent"` ONLY (the project-agent successor kind; #1030/#1035). Today the
// sidecar `cinatra/dashboard.json` rides the workflow install path, which #1035
// removed — this claim is the successor carrier.
//
// This module is the SCHEMA-ONLY, host-neutral LEAF (the same S1/#1621 discipline
// `artifact-contract.ts` uses): it lives in `@cinatra-ai/sdk-extensions` so an
// agent extension types its claim against the SDK alone and never imports a host
// package, AND so BOTH the host manifest-normalization path and the
// publish/conformance gate share ONE field-tolerant validator
// ({@link parseDashboardContribution}) without duplicating a literal. The concrete
// materialization + reconciliation + reader-gate runtime stay host-side
// (@cinatra-ai/dashboards + the app); this leaf owns only the DECLARATION shape.
//
// FIELD-TOLERANT PARSE (the `.strict()` mirror hazard). The claim is carried on
// the normalized record + the manifest as RAW `unknown` (like `accessConfig` /
// `envOverrides` / the artifact `ui` block) so a malformed contribution can NEVER
// reject the surrounding agent manifest and drop the agent's other claims. The
// boot/normalization path degrades-with-diagnostic (drops the claim); the
// publish/conformance gate rejects fail-closed on the SAME verdict.

import { z } from "zod";
import { SDK_EXTENSIONS_ABI_VERSION, isSdkAbiRangeSatisfied } from "./register";
import { generateArtifactUiSdkAbiRange, isContainedEntryPath } from "./artifact-contract";

// ===========================================================================
// Versioning + carrier-kind allowlist.
// ===========================================================================

/**
 * The `cinatra.dashboardContribution` claim ABI version (distinct from the SDK
 * ABI and from the DATA `contributionVersion`). v1 is the only shape this schema
 * accepts; a future v2 is an additive, versioned migration. Read AS A LITERAL by
 * the extension-repo conformance gate's rule derivation — never a re-listed copy.
 */
export const DASHBOARD_CONTRIBUTION_ABI_VERSION = 1;

/**
 * The carrier-kind allowlist for the claim (AC1). Initially `agent` ONLY: legacy
 * `kind:"workflow"` packages are readable SOLELY as grandfathered adoption
 * sources (the host rejects a `kind:"workflow"` install fail-closed), never as a
 * re-materialization carrier. Read as a literal by the conformance gate + the
 * generator (which emits the claim on `kind:"agent"` records only).
 */
export const DASHBOARD_CONTRIBUTION_CARRIER_KINDS = ["agent"] as const;
export type DashboardContributionCarrierKind = (typeof DASHBOARD_CONTRIBUTION_CARRIER_KINDS)[number];

/** True iff `kind` may author a `cinatra.dashboardContribution` claim. */
export function isDashboardContributionCarrierKind(kind: unknown): kind is DashboardContributionCarrierKind {
  return typeof kind === "string" && (DASHBOARD_CONTRIBUTION_CARRIER_KINDS as readonly string[]).includes(kind);
}

/**
 * Author-local contribution KEY grammar: strict lowercase kebab (a leading alnum
 * segment, hyphen-joined alnum segments) — the SAME slug grammar the registry
 * `<component>`/`<slug>` tokens use. The author-local key is scoped to the
 * package; the PERSISTED row instead carries a carrier-independent immutable
 * lineage `contribution_id` (host-owned) so identity survives the workflow→agent
 * re-home. Adoption is NEVER inferred from key equality — the successor declares
 * an explicit {@link DashboardContributionAdoption} list.
 */
export const CONTRIBUTION_KEY_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** True iff `key` is a valid author-local contribution key (strict lowercase kebab). */
export function isValidContributionKey(key: unknown): boolean {
  return typeof key === "string" && CONTRIBUTION_KEY_RE.test(key);
}

// ===========================================================================
// Types.
// ===========================================================================

/**
 * An explicit adoption edge: the successor agent claims an ORPHANED legacy row
 * by naming the legacy package + its author-local contribution key. The
 * reconciler (S11b) matches this against orphaned rows and adopt-in-place re-keys
 * them (never a short-key-equality inference, never a duplicate).
 */
export type DashboardContributionAdoption = {
  /** The legacy package that shipped the orphaned contribution (e.g. a `kind:"workflow"` demo). */
  legacyPackage: string;
  /** The legacy author-local contribution key on that package. */
  legacyContributionKey: string;
};

/**
 * The `cinatra.dashboardContribution` claim (v1). IDENTITY + versioning +
 * adoption; the dashboard CONTENT is the existing `cinatra/dashboard.json`
 * sidecar (validated by the host's `validateDashboardConfigV12`), referenced by
 * {@link sidecar}. `scopeLevel` is sidecar-owned (drives `template_scope`) and is
 * intentionally NOT duplicated here.
 */
export type DashboardContributionManifest = {
  abiVersion: typeof DASHBOARD_CONTRIBUTION_ABI_VERSION;
  /**
   * GENERATED from the canonical SDK ABI — never hand-written (same rule as the
   * artifact `ui` block). See {@link generateArtifactUiSdkAbiRange}, reused.
   */
  sdkAbiRange: string;
  /**
   * The monotonic DATA version of this contribution's default config
   * (integer ≥ 1). Bumped by the author on every default change; the host
   * persists it as `applied_contribution_version` provenance + drives the
   * baseline-backed 3-way upgrade merge (S11b).
   */
  contributionVersion: number;
  /** Author-local contribution key (strict lowercase kebab; package-scoped). */
  contributionKey: string;
  /**
   * Package-relative, path-contained subpath to the dashboard sidecar. Defaults
   * to `./cinatra/dashboard.json` when omitted. Content is validated as the
   * existing apiVersion 1.2 dashboard config (DASHBOARD_CONFIG_V12_VERSION) by
   * the host materializer — NOT re-validated here (this leaf pins the path SHAPE
   * only, like a renderer `entry`).
   */
  sidecar?: string;
  /**
   * Explicit workflow→successor adoption edges (AC2 "re-key not duplicate"). An
   * empty/absent list means this contribution adopts no legacy row.
   */
  adopts?: DashboardContributionAdoption[];
};

export type DashboardContributionParseResult =
  | { ok: true; contribution: DashboardContributionManifest }
  | { ok: false; diagnostic: string };

// ===========================================================================
// Schema.
// ===========================================================================

const adoptionSchema = z
  .object({
    legacyPackage: z.string().min(1),
    legacyContributionKey: z
      .string()
      .min(1)
      .refine(isValidContributionKey, {
        message: "adopts[].legacyContributionKey must be strict lowercase kebab (e.g. `blog-operator`)",
      }),
  })
  // `.strict()` = only the two adoption fields; an extra key is rejected.
  .strict();

const dashboardContributionSchema = z
  .object({
    abiVersion: z.literal(DASHBOARD_CONTRIBUTION_ABI_VERSION),
    sdkAbiRange: z.string().min(1),
    contributionVersion: z.number().int().min(1),
    contributionKey: z
      .string()
      .min(1)
      .refine(isValidContributionKey, {
        message: "contributionKey must be strict lowercase kebab (e.g. `blog-operator`)",
      }),
    sidecar: z
      .string()
      .min(1)
      .refine(isContainedEntryPath, {
        message:
          'sidecar must be a package-relative, path-contained subpath ("./…", no "..", no absolute path or URL)',
      })
      .optional(),
    adopts: z
      .array(adoptionSchema)
      .min(1)
      .superRefine((edges, ctx) => {
        // A (legacyPackage, legacyContributionKey) pair is unique within the
        // claim — two edges naming the same legacy contribution is a collision
        // the reconciler could never disambiguate.
        const seen = new Set<string>();
        for (const [i, e] of edges.entries()) {
          const k = `${e.legacyPackage} ${e.legacyContributionKey}`;
          if (seen.has(k)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [i],
              message: `duplicate adopts edge for ${e.legacyPackage}#${e.legacyContributionKey}`,
            });
          }
          seen.add(k);
        }
      })
      .optional(),
  })
  // `.strict()` = a closed v1 claim shape: any unknown key (a future-version
  // field, a typo, a smuggled port request) is rejected in v1.
  .strict();

/** The generated `sdkAbiRange` for the CURRENT canonical SDK ABI (reuses the
 *  artifact-ui caret-range rule; the range grammar is identical). */
export const DASHBOARD_CONTRIBUTION_SDK_ABI_RANGE = generateArtifactUiSdkAbiRange();

/**
 * SANITIZE a zod failure into a single-line diagnostic that echoes only the
 * failing PATH + issue CODE — never a received value — so a hostile manifest
 * cannot smuggle content into host logs / the boot diagnostic.
 */
function sanitizeContributionDiagnostic(error: z.ZodError): string {
  const parts = error.issues.slice(0, 6).map((issue) => {
    const at = issue.path.length ? issue.path.join(".") : "<root>";
    return `${at} (${issue.code})`;
  });
  const suffix = error.issues.length > 6 ? "; …" : "";
  return `cinatra.dashboardContribution is invalid: ${parts.join("; ")}${suffix}`;
}

/**
 * TOLERANT validator for the `cinatra.dashboardContribution` claim, shared by the
 * host manifest-normalization path and the publish/conformance gate. NEVER throws
 * and NEVER implies the surrounding agent manifest is invalid.
 *  - boot / normalization: on `{ ok: false }` the caller DROPS the claim (the
 *    agent keeps its other claims) and surfaces `diagnostic` — degrade, never
 *    reject.
 *  - publish / conformance gate: the SAME `{ ok: false }` is rejected fail-closed
 *    (see {@link validateDashboardContributionForPublish}).
 *
 * sdkAbiRange SEMANTICS — this HOST-SIDE verdict checks SATISFACTION, not the
 * exact generated pin (identical layering to `parseArtifactUi`): a contribution
 * built against an earlier host-compatible SDK must still materialize. The
 * GENERATED-only contract ("`sdkAbiRange` equals `^<the SDK it was built
 * against>`") is enforced one layer up, at the extension-repo conformance gate.
 */
export function parseDashboardContribution(input: unknown): DashboardContributionParseResult {
  const parsed = dashboardContributionSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, diagnostic: sanitizeContributionDiagnostic(parsed.error) };
  }
  if (!isSdkAbiRangeSatisfied(SDK_EXTENSIONS_ABI_VERSION, parsed.data.sdkAbiRange)) {
    return {
      ok: false,
      diagnostic:
        `cinatra.dashboardContribution declares sdkAbiRange the host SDK ABI ` +
        `${SDK_EXTENSIONS_ABI_VERSION} does not satisfy (built for an incompatible SDK)`,
    };
  }
  return { ok: true, contribution: parsed.data as DashboardContributionManifest };
}

/**
 * PUBLISH/authoring verdict wrapper (parity with
 * `validateSemanticArtifactManifestForPublish`). The authoring path is
 * FAIL-CLOSED on the claim: unlike the boot path — which DEGRADES an unsupported
 * contribution (dropping it, other claims intact) — a chat-authored agent
 * package with a malformed `dashboardContribution` (or one authored on a
 * non-`agent` carrier kind) must be REJECTED.
 *
 * `carrierKind` is the declaring package's `cinatra.kind`; a contribution on a
 * non-allowlisted kind is rejected here even when the claim body is well-formed.
 */
export function validateDashboardContributionForPublish(
  input: unknown,
  carrierKind: unknown,
): { valid: boolean; errors: string[] } {
  if (!isDashboardContributionCarrierKind(carrierKind)) {
    return {
      valid: false,
      errors: [
        `cinatra.dashboardContribution may be authored only on kind:"agent" (got kind:${JSON.stringify(carrierKind)})`,
      ],
    };
  }
  const r = parseDashboardContribution(input);
  if (!r.ok) return { valid: false, errors: [r.diagnostic] };
  return { valid: true, errors: [] };
}
