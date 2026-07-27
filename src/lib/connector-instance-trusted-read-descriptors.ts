// The cinatra-shipped trusted-read descriptor set for WordPress trusted-site
// mode (cinatra#2019 S4) + the shipped consent constants the opt-in setter
// stamps (connector-instance-native-injection-store.ts /
// connector-instance-native-injection-consent.ts).
//
// WHAT THIS IS: the enumerated, capture-derived allowlist of site tools that
// MAY be natively injected (handed to the model provider to call directly)
// once an org-admin opts an instance into trusted-site mode. An entry exists
// ONLY for a tool name the committed community-stack capture
// (tests/e2e/wp-mcp-gateway/captures/) proves as a FIRST-CLASS wire tool on
// the DEFAULT adapter server with a computable interface fingerprint.
//
// v1 IS DELIBERATELY EMPTY. The pinned community stack (WP 6.9 ·
// mcp-adapter 0.5.0 · enable-abilities-for-mcp 2.0.20) exposes the default
// server TRIAD-ONLY (see docker/wordpress/EXPOSURE-MODE.md): no per-ability
// wire tools exist there, so no name can carry the capture proof an entry
// requires. The injectable set on the pinned stack is therefore EMPTY BY
// CONSTRUCTION — opt-in ON injects nothing today. Populating this set is a
// reviewed code change in a future stack-pin bump whose refreshed capture
// shows first-class default-server reads; that change MUST bump `version`
// (consent re-acknowledgement rides on it — see below).
//
// CONSENT BINDING (why the hash exists): when an org-admin enables
// trusted-site mode, the HOST stamps the policy row with the shipped
// `{version, sha256(canonical entries), disclosure version}` — never
// caller-supplied values. The injection builder later requires EXACT equality
// of all three stamps against these shipped constants; ANY drift (older,
// newer, or same-version-different-content) refuses as stale consent. The
// hash is COMPUTED from the same canonical-entries helper every consumer
// imports from this module — never an independently maintained value — so an
// entries change can never sail under an unchanged stamp.
//
// Entry names are EXACT concrete wire-tool names. Prefix/namespace selectors
// are deliberately unrepresentable: nothing in this module or its consumers
// interprets a name as a pattern, and `canonicalizeTrustedReadDescriptorEntries`
// throws on duplicate names so the set stays a proper enumeration.

import { createHash } from "node:crypto";

/** One trusted-read descriptor: an exact wire-tool name pinned to the
 * fingerprint of its ADVERTISED interface at capture time. `hasOutputSchema`
 * records output-schema PRESENCE explicitly (absence is part of the pin). */
export type TrustedReadDescriptorEntry = {
  /** Exact wire-tool name on the DEFAULT adapter server (never a pattern). */
  name: string;
  /** Versioned interface fingerprint (`tsr1` sha256 hex) of the advertised
   * input/output schemas as captured on the pinned stack. */
  fingerprint: string;
  /** Whether the captured tool advertised an output schema at all. */
  hasOutputSchema: boolean;
  /** Optional reviewer note (why this read is trusted). */
  note?: string;
};

export type TrustedReadDescriptorSet = {
  /** Monotonic set version. Every entries change MUST bump it (the persisted
   * consent stamps make an unbumped change fail CLOSED regardless). */
  version: number;
  /** The community-stack tuple the entries were captured against. */
  pinnedTuple: { wp: string; mcpAdapter: string; eafm: string };
  /** The fingerprint algorithm every entry's `fingerprint` was computed with. */
  fingerprintAlgorithm: "tsr1";
  entries: TrustedReadDescriptorEntry[];
};

/** The shipped set. EMPTY at v1 — see the module header for why. */
export const TRUSTED_READ_DESCRIPTOR_SET = {
  version: 1,
  pinnedTuple: { wp: "6.9", mcpAdapter: "0.5.0", eafm: "2.0.20" },
  fingerprintAlgorithm: "tsr1",
  entries: [] as TrustedReadDescriptorEntry[],
} satisfies TrustedReadDescriptorSet;

/** The disclosure version an enable/re-acknowledge ceremony records. Bump it
 * whenever the residual-risk disclosure text materially changes; existing
 * `trusted_site` rows then read as stale consent until re-acknowledged. */
export const TRUSTED_SITE_DISCLOSURE_VERSION = "v1";

/** Deterministic JSON canonicalization: recursive object-key sort, arrays
 * order-preserved, compact separators (plain JSON.stringify semantics —
 * `undefined` members are dropped). Local to descriptor-entry hashing; the
 * (stricter) tool-schema fingerprint canonicalizer is a separate concern. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Canonical string form of a descriptor-entries list: entries sorted by
 * `name` (a reorder is not a content change), per-entry keys sorted, compact.
 * Throws on a duplicate name — the set is an enumeration of exact names, and
 * a duplicate can only be a population mistake.
 */
export function canonicalizeTrustedReadDescriptorEntries(
  entries: readonly TrustedReadDescriptorEntry[],
): string {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.name)) {
      throw new Error(
        `trusted-read descriptor set contains a duplicate entry name: ${JSON.stringify(entry.name)}`,
      );
    }
    seen.add(entry.name);
  }
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return stableStringify(sorted);
}

/**
 * sha256 hex of the canonical entries — the content half of the persisted
 * consent stamp. EVERY consumer (the opt-in setter's stamp, the injection
 * builder's equality check, the descriptor test pins) derives it through this
 * one helper so the stamp and the shipped content can never diverge.
 */
export function computeTrustedReadDescriptorSetHash(
  entries: readonly TrustedReadDescriptorEntry[],
): string {
  return createHash("sha256")
    .update(canonicalizeTrustedReadDescriptorEntries(entries), "utf8")
    .digest("hex");
}

/** The three host-stamped consent values as currently shipped. */
export type ShippedTrustedSiteConsent = {
  descriptorSetVersion: number;
  descriptorSetHash: string;
  disclosureVersion: string;
};

/**
 * Resolve the currently shipped consent stamps `{version, hash, disclosure}`.
 * The opt-in setter records EXACTLY these on every enable/re-acknowledge —
 * caller-supplied values are ignored — and the injection builder requires
 * EXACT equality against them before anything may be emitted.
 */
export function resolveShippedTrustedSiteConsent(): ShippedTrustedSiteConsent {
  return {
    descriptorSetVersion: TRUSTED_READ_DESCRIPTOR_SET.version,
    descriptorSetHash: computeTrustedReadDescriptorSetHash(TRUSTED_READ_DESCRIPTOR_SET.entries),
    disclosureVersion: TRUSTED_SITE_DISCLOSURE_VERSION,
  };
}
