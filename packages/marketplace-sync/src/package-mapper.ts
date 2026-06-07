/**
 * Package metadata mapper.
 *
 * Normalises a Verdaccio package.json + (optional) README + version
 * timeline into a contract-shaped `PackageMetadata` ready to POST via
 * `marketplace_package_sync_from_registry`.
 *
 * The mapping is intentionally pure (no I/O) so it's straight to unit-test
 * + so the sync worker (the I/O side) and tests (the assertion side) share
 * the same logic.
 *
 * Mapping rules:
 *   - name / version / description → directly from package.json
 *   - kind → STRICTLY from `package.json#cinatra.kind`, which MUST be one of
 *     the canonical kinds ("agent" / "skill" / "connector" / "artifact" /
 *     "workflow"). FAILS CLOSED (throws) when `cinatra.kind` is missing or not
 *     a canonical value. There is NO keyword inference — a package is never
 *     silently categorised from `keywords`, and never silently mis-categorised
 *     as "agent".
 *   - license → `package.json#license` SPDX (string only, not the
 *     deprecated `{type,url}` object)
 *   - marketplaceAssets → `package.json#cinatra.marketplace.assets` if
 *     present (relative-path-only per the media policy); else []
 *   - readmeMarkdown → the optional `readme` arg (already extracted +
 *     size-capped by the sync worker via getPackageReadme from
 *     @cinatra-ai/registries)
 */

import type {
  ExtensionKind,
  MarketplaceAsset,
  PackageMetadata,
} from "@cinatra-ai/marketplace-mcp-client";

export interface MappedMetadataResult {
  metadata: PackageMetadata;
  warnings: string[];
}

export interface RawPackageJson {
  name: string;
  version: string;
  description?: string | null;
  license?: string | { type?: string; url?: string };
  /** Cinatra-namespaced manifest extension. */
  cinatra?: {
    kind?: ExtensionKind;
    marketplace?: {
      longDescription?: string;
      assets?: Array<{ path: string; role: "hero" | "screenshot" | "icon" }>;
    };
  };
}

const VALID_KINDS: readonly ExtensionKind[] = ["agent", "skill", "connector", "artifact", "workflow"];

function isValidKind(value: unknown): value is ExtensionKind {
  return typeof value === "string" && (VALID_KINDS as readonly string[]).includes(value);
}

function pickKind(pkg: RawPackageJson): ExtensionKind {
  const declared: unknown = pkg.cinatra?.kind;
  // STRICT fail-closed: an explicit, canonical `cinatra.kind` is REQUIRED.
  // We do NOT infer the kind from `keywords` (removed) and we do NOT default
  // to "agent". A package with a missing or invalid kind is recorded by the
  // caller as a per-package failure and skipped, rather than mis-categorised
  // in the catalog.
  if (declared === undefined || declared === null || declared === "") {
    throw new Error(
      `${pkg.name}: no cinatra.kind declared; refusing to default — declare cinatra.kind explicitly (one of agent/skill/connector/artifact/workflow).`,
    );
  }
  if (!isValidKind(declared)) {
    throw new Error(
      `${pkg.name}: invalid cinatra.kind "${String(declared)}"; must be one of agent/skill/connector/artifact/workflow.`,
    );
  }
  return declared;
}

function pickLicense(pkg: RawPackageJson): string | null {
  if (typeof pkg.license === "string") {
    return pkg.license;
  }
  if (pkg.license && typeof pkg.license === "object" && typeof pkg.license.type === "string") {
    return pkg.license.type;
  }
  return null;
}

function pickAssets(pkg: RawPackageJson, warnings: string[]): MarketplaceAsset[] {
  const raw = pkg.cinatra?.marketplace?.assets;
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: MarketplaceAsset[] = [];
  for (const entry of raw) {
    if (typeof entry?.path !== "string" || entry.path === "") {
      warnings.push(`${pkg.name}: skipping marketplace asset with empty/missing path`);
      continue;
    }
    if (entry.path.startsWith("/") || entry.path.startsWith("http://") || entry.path.startsWith("https://")) {
      warnings.push(`${pkg.name}: skipping marketplace asset "${entry.path}" — path must be relative to package root (no URL fetching)`);
      continue;
    }
    if (entry.role !== "hero" && entry.role !== "screenshot" && entry.role !== "icon") {
      warnings.push(`${pkg.name}: skipping marketplace asset "${entry.path}" — invalid role "${String(entry.role)}"`);
      continue;
    }
    if (out.length >= 20) {
      warnings.push(`${pkg.name}: marketplaceAssets exceeded 20-entry cap; remaining entries dropped`);
      break;
    }
    out.push({ path: entry.path, role: entry.role });
  }
  return out;
}

export function mapPackageMetadata(args: {
  packageJson: RawPackageJson;
  readme: string | null;
}): MappedMetadataResult {
  const { packageJson, readme } = args;
  const warnings: string[] = [];
  const kind = pickKind(packageJson);
  const license = pickLicense(packageJson);
  const marketplaceAssets = pickAssets(packageJson, warnings);
  const longDescription = packageJson.cinatra?.marketplace?.longDescription ?? null;

  if (typeof packageJson.name !== "string" || packageJson.name === "") {
    warnings.push(`Package JSON missing name`);
  }
  if (typeof packageJson.version !== "string" || packageJson.version === "") {
    warnings.push(`Package JSON missing version`);
  }

  return {
    metadata: {
      packageName: packageJson.name,
      version: packageJson.version,
      description: typeof packageJson.description === "string" ? packageJson.description : null,
      longDescription,
      kind,
      license,
      marketplaceAssets,
      readmeMarkdown: readme,
    },
    warnings,
  };
}
