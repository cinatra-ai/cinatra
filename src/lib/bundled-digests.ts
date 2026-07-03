// Recorded bundled-payload digests — the boot-side READER half of the
// bundled-identity parity mechanism (cinatra#795).
//
// The prod image build records a deterministic content digest per bundled
// extension payload (scripts/extensions/record-bundled-digests.mjs → the
// image artifact `/app/.cinatra-bundled-digests.json`, copied into the
// runtime stage next to the required-OAS seed). At boot, the static-bundle
// lifecycle seeder reads it through this module and stamps the digest into
// each platform anchor row's typed `source.digest` (`ExtensionSourceBundled`)
// — giving bundled packages the same `<kind>/<slug>/<digest>` identity as
// store-installed ones WITHOUT touching the sealed static import (no store
// read, no network; one JSON read of an image-shipped file).
//
// FAIL-SOFT by design: bundled activation must never depend on this file.
//   - absent file → empty map (every dev boot: a mutable dev tree has no
//     sealed payload, so recording a digest there would be a lie);
//   - malformed JSON / wrong shape → loud warn + empty map;
//   - an individually invalid entry (bad digest grammar, empty version) →
//     loud warn + that entry dropped, the rest kept.
//
// The digest value itself is TRUST-NEUTRAL (like the store sidecar and the
// `current` file): it is provenance/identity metadata on the anchor row, never
// an input to the loader's activation decision.
//
// Pure module (fs + console only) — unit-testable without a host.

import { existsSync, readFileSync } from "node:fs";

import { isStoreDigestSegment } from "@/lib/extension-package-store-core";

/** Env override for the recorded-digests file (tests, non-/app layouts). */
export const BUNDLED_DIGESTS_PATH_ENV = "CINATRA_BUNDLED_DIGESTS_PATH";

/** Where the image build records the digests (Dockerfile runtime stage). */
export const DEFAULT_BUNDLED_DIGESTS_PATH = "/app/.cinatra-bundled-digests.json";

export type RecordedBundledDigest = {
  /** package.json version the digest was computed for (`"0.0.0"` fallback). */
  version: string;
  /** `cinatra.kind` declared by the package manifest, when present. */
  kind: string | null;
  /** Hex content digest of the sealed payload (store digest-segment grammar). */
  digest: string;
};

/**
 * Read the image-recorded bundled digests, keyed by package name. Never
 * throws; see the fail-soft contract above.
 */
export function readRecordedBundledDigests(
  explicitPath?: string,
): Map<string, RecordedBundledDigest> {
  const path =
    explicitPath ?? process.env[BUNDLED_DIGESTS_PATH_ENV] ?? DEFAULT_BUNDLED_DIGESTS_PATH;
  const out = new Map<string, RecordedBundledDigest>();
  try {
    if (!existsSync(path)) return out; // normal on dev boots — no image, no digest
    const doc: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!doc || typeof doc !== "object" || (doc as { formatVersion?: unknown }).formatVersion !== 1) {
      console.warn(
        `[bundled-digests] ${path} is not a formatVersion=1 recorded-digests document — ignoring it`,
      );
      return out;
    }
    const packages = (doc as { packages?: unknown }).packages;
    if (!packages || typeof packages !== "object") {
      console.warn(`[bundled-digests] ${path} has no packages map — ignoring it`);
      return out;
    }
    for (const [name, value] of Object.entries(packages as Record<string, unknown>)) {
      const v = value as { version?: unknown; kind?: unknown; digest?: unknown } | null;
      const version = typeof v?.version === "string" && v.version.length > 0 ? v.version : null;
      const digest =
        typeof v?.digest === "string" && isStoreDigestSegment(v.digest) ? v.digest : null;
      const kind = typeof v?.kind === "string" && v.kind.length > 0 ? v.kind : null;
      if (version === null || digest === null) {
        console.warn(
          `[bundled-digests] dropping invalid recorded entry for ${name} ` +
            `(version/digest malformed) — that package's anchor row will carry no digest`,
        );
        continue;
      }
      out.set(name, { version, kind, digest });
    }
    return out;
  } catch (err) {
    console.warn(
      `[bundled-digests] failed to read ${path} — bundled anchor rows will carry no digest:`,
      err instanceof Error ? err.message : err,
    );
    return out;
  }
}
