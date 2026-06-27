// Agent-bound skill identity / on-disk path derivation + pure SKILL.md
// frontmatter parsing (cinatra#537).
//
// Extracted verbatim (behavior-identical) from skills-store.ts to keep that file
// under the file-size ratchet. All helpers here are PURE (string/identity/parse
// only — NO fs/path/realpath/symlink operations), so they introduce no taint
// source and keep CodeQL clean. The agent-identity helpers are the SINGLE source
// of truth for splitting an agent package id into a fail-closed (vendor, package)
// pair used by both the binding-context bridge (deriveContextFromLegacy) and the
// on-disk `~agents/<vendor>/<package>/<skill>/` resolver (getSkillDiskDir).
//
// INVARIANT: a parsePackageId-REJECTED, @-scoped input (after trimming) must
// NEVER contribute a path segment. We trim ONCE and gate on `trimmed`
// (parsePackageId trims internally, so gating the legacy fallback on the RAW
// value would let " @../foo" slip past the scoped check). Order:
//   (a) parsePackageId(trimmed) ok → {vendor, name}
//   (b) trimmed.startsWith("@")  → MALFORMED scoped → fail closed (no segment)
//   (c) trimmed.includes("/")    → legacy NON-scoped "<vendor>/<package>" split
//   (d) else                     → unscoped single name

import { parsePackageId, isSafePathSegment } from "@cinatra-ai/registries";

/**
 * Binding-context variant (for `deriveContextFromLegacy`): a rejected scoped id
 * or any segment that isn't a single safe path segment FAILS CLOSED to
 * `{ vendor: null }` (no binding) — never throws, since the bridge is
 * best-effort. The split never cuts a scope on `-`.
 */
export function deriveAgentBindingVendorPackage(packageSlug: string): {
  vendor: string | null;
  pkg: string;
} {
  const trimmed = packageSlug.trim();
  let vendor: string | null = null;
  let pkg: string = trimmed;
  const parsed = parsePackageId(trimmed);
  if (parsed && parsed.vendor) {
    // (a) Canonical scoped "@vendor/name" — both parts already safe segments.
    vendor = parsed.vendor;
    pkg = parsed.name;
  } else if (trimmed.startsWith("@")) {
    // (b) MALFORMED SCOPED id parsePackageId rejected (e.g. "@../foo", "@/foo",
    // "@~evil/foo", "@..", "@."). FAIL CLOSED: derive nothing — do NOT hand it
    // to the legacy splitter (which would mint a literal "@..", "@" or "@~evil"
    // vendor). Leaves vendor=null (no binding).
    vendor = null;
  } else if (trimmed.includes("/")) {
    // (c) Legacy NON-scoped "<vendor>/<package>" — split on the FIRST `/`.
    const ix = trimmed.indexOf("/");
    vendor = trimmed.slice(0, ix);
    pkg = trimmed.slice(ix + 1);
  }
  // (d) else: unscoped single name → vendor stays null (no hyphen mis-split).
  //
  // Belt-and-suspenders: the derived segments become on-disk path segments
  // downstream (resolveSkillDir). Drop the binding to the null fallback if
  // either segment is not a single safe path segment. The shared
  // `isSafePathSegment` rejects separators/`..`/control/leading-`~` AND
  // leading-`@`, so a leaked "@.."-style value can never persist as a vendor.
  if (vendor !== null && (!isSafePathSegment(vendor) || !isSafePathSegment(pkg))) {
    vendor = null;
  }
  return { vendor, pkg };
}

/**
 * Disk-path variant (for `getSkillDiskDir`): returns the `(vendor, pkg)`
 * segments for `~agents/<vendor>/<package>/<skill>/`. A rejected scoped id FAILS
 * CLOSED by THROWING (the resolver returns a non-null path, so a malformed value
 * must not silently land as a literal segment, not even under "unknown"). A flat
 * slug with no vendor keeps the historical "unknown" vendor fallback. The caller
 * still runs `assertSafePathSegment` on each returned segment before joining.
 */
export function deriveAgentDiskVendorPackage(packageSlug: string): {
  vendor: string;
  pkg: string;
} {
  const trimmed = packageSlug.trim();
  let vendor = "unknown";
  let pkg = trimmed;
  const parsed = parsePackageId(trimmed);
  if (parsed && parsed.vendor) {
    // (a) Canonical scoped "@vendor/name" — both parts already safe segments.
    vendor = parsed.vendor;
    pkg = parsed.name;
  } else if (trimmed.startsWith("@")) {
    // (b) MALFORMED SCOPED id parsePackageId rejected (e.g. "@../foo", "@/foo",
    // "@~evil/foo", "@..", "@."). FAIL CLOSED: refuse outright so the malformed
    // value can NEVER become a path segment (not as a vendor, and not as a `pkg`
    // under "unknown" either — e.g. no `~agents/unknown/@..`).
    throw new Error(
      `agent skill packageSlug is a malformed scoped id: ${JSON.stringify(trimmed)}`,
    );
  } else if (trimmed.includes("/")) {
    // (c) Legacy NON-scoped "<vendor>/<package>" — split on the FIRST `/`.
    const ix = trimmed.indexOf("/");
    vendor = trimmed.slice(0, ix);
    pkg = trimmed.slice(ix + 1);
  }
  // (d) else: unscoped single name → "unknown" vendor, pkg = the name.
  return { vendor, pkg };
}

/**
 * Derive the canonical `<vendor>/<package>` storage-path segment for an
 * agent-bound skill from its REAL npm package name (e.g.
 * "@marcushorndt-local/page-summarizer-agent" → "marcushorndt-local/page-summarizer-agent"),
 * or `undefined` when the name isn't a valid scoped id. Used by `upsertSkill`
 * when the caller didn't pass an explicit storagePackagePath — the flat
 * slugified packageSlug can't be split safely (cinatra#537). Both returned
 * segments come from parsePackageId, so they are guaranteed safe.
 */
export function deriveAgentStoragePathFromPackageName(
  packageName: string,
): string | undefined {
  const parsed = parsePackageId(packageName.trim());
  return parsed && parsed.vendor ? `${parsed.vendor}/${parsed.name}` : undefined;
}

/**
 * Minimal SKILL.md frontmatter reader (pure string parsing — no fs/path).
 * Parses the leading `---\n...\n---` YAML-ish block into a flat
 * `Record<string, string>` (block-sequence list values are JSON-serialized so
 * the value type stays `string`) and returns the remaining body. Extracted from
 * skills-store.ts verbatim (behavior identical) to keep that file under the
 * size ratchet; it is CodeQL-neutral (operates only on the in-memory string).
 */
export function parseFrontmatter(content: string): {
  attributes: Record<string, string>;
  body: string;
} {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) {
    return { attributes: {} as Record<string, string>, body: content };
  }

  const attributes: Record<string, string> = {};
  let lastKey: string | null = null;
  const listAccumulatorByKey: Record<string, string[]> = {};

  for (const rawLine of match[1].split("\n")) {
    // Detect YAML block-sequence continuation lines (`  - <value>`)
    // before trimming, so the leading whitespace signals list membership.
    const blockSequenceContinuation = /^[ \t]+-[ \t]+/.test(rawLine);
    if (blockSequenceContinuation && lastKey !== null) {
      const itemValue = rawLine.replace(/^[ \t]+-[ \t]+/, "").trim().replace(/^["']|["']$/g, "");
      if (!listAccumulatorByKey[lastKey]) {
        listAccumulatorByKey[lastKey] = [];
      }
      listAccumulatorByKey[lastKey].push(itemValue);
      continue;
    }

    const line = rawLine.trim();
    if (!line) continue;

    const separatorIndex = line.indexOf(":");
    if (separatorIndex < 0) {
      lastKey = line;
      attributes[line] = "";
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim().replace(/^["']|["']$/g, "");
    lastKey = key;
    attributes[key] = value;
  }

  // Serialize collected lists as JSON strings so the Record<string, string> type is preserved.
  for (const [key, items] of Object.entries(listAccumulatorByKey)) {
    attributes[key] = JSON.stringify(items);
  }

  return {
    attributes,
    body: content.slice(match[0].length),
  };
}

/**
 * Slugify a value to a filesystem-safe lowercase slug (pure string — no
 * fs/path). Trims, lowercases, collapses non-alnum runs to `-`, and strips
 * leading/trailing `-`. Extracted from skills-store.ts verbatim (behavior
 * identical) to keep that file under the size ratchet; CodeQL-neutral.
 */
export function slugify(value: string): string {
  // Split on non-alnum runs and rejoin with "-": behavior-identical to
  // replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"") but with no anchored "-+$"
  // quantifier (avoids the CodeQL polynomial-ReDoS pattern on uncontrolled input).
  return value
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join("-");
}
