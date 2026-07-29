import "server-only";

// cinatra#2021 S6 / design D8 (PR α): the additive, lenient-parse READ member
// for the dormant `site_meta` column S3 PR-C already added to the
// `connector_instance_site_inventory` companion row
// (`SiteInventoryRecord.siteMeta: unknown`, written verbatim by
// `tryAdvanceSiteInventory` — connector-instance-server-store.ts). Until this
// module, nothing typed or read that column: `applySiteInventory`
// (connector-instance-server-enrollment.ts) only ever diffs `payload.servers[]`
// into `connector_instance_server` rows and never touches `payload.site`.
//
// This is a pure, additive, no-new-table, no-new-capability host member — the
// exact "host computes, connector renders" pattern S2/S3/S4 already established
// (`register-host-connector-services.ts` wires it onto the existing
// `wordpress-mcp` publication; see design §6/§9 PR α). It does NOT depend on the
// still-unopened site-inventory intake route (S3 PR-D / this epic's PR β) —
// `site_meta` rows can already exist from S3 PR-C's own store-level tests /
// any future intake caller; this module only reads what is already there.

import { z } from "zod";
import {
  readSiteInventory,
  type ServerStoreDeps,
} from "@/lib/connector-instance-server-store";

// TRI-STATE RETURN (design D8, paired with D6): a plain nullable/optional
// return would let "no signal" collapse into the same shape a caller might
// treat as "verified safe" (e.g. "no warning ⇒ not an administrator").
// `ConnectedSiteMetadata` is a discriminated union so
// a caller (the wordpress-mcp-connector least-privilege warning card, design
// §7, a LATER PR — not built here) is structurally forced to handle "unknown"
// as its own branch rather than an optional field it can `??`-collapse away.
export type ConnectedSiteMetadata =
  | {
      status: "known";
      wpVersion: string;
      phpVersion: string;
      adapterVersion: string | null;
      abilitiesPluginVersion: string | null;
      /** The connected Application-Password user's primary role. Surfacing
       * only — never an authorization input (contract doc's own words; see
       * `docs/internals/contracts/wp-site-inventory-contract.md`). */
      connectedUserRole: string;
      permalinkStructure: "pretty" | "plain";
      /** The companion inventory row's `received_at` (when this metadata was
       * last accepted), not `collectedAt` (which is site-advisory only). */
      receivedAt: string;
    }
  | {
      status: "unknown";
      /** `no_inventory` — the instance has never had an inventory row accepted
       * (S3 PR-C's store returns `null`, e.g. the intake route has never run
       * for it, or PR-D/β doesn't exist yet on this deployment).
       * `unparseable` — a row exists but `site_meta` fails the lenient partial
       * re-parse below (a legacy/short shape, a future producer field this
       * reader doesn't know yet, or genuinely malformed data). */
      reason: "no_inventory" | "unparseable";
    };

// Deliberately NOT the strict, module-private `siteBlockSchema` from
// connector-instance-site-inventory-contract.ts. That schema is the TRUST
// BOUNDARY the (not-yet-built) intake route enforces on the wire, before
// `payload.site` is ever persisted into `site_meta` — this module reads an
// ALREADY-PERSISTED, opaque jsonb blob back out, so re-validating here is
// defense-in-depth, not the real trust boundary (design §6). This schema is
// therefore intentionally looser: plain `z.object` (unknown keys are ignored,
// not rejected, unlike the producer's `z.strictObject`) so a future additive
// producer field, or a slightly differently-shaped historical row, degrades to
// `unknown/unparseable` only when a field this reader actually NEEDS is
// missing or the wrong type — never on an extra/renamed field alone.
const lenientSiteMetaSchema = z.object({
  wpVersion: z.string().min(1),
  phpVersion: z.string().min(1),
  adapterVersion: z.string().min(1).nullable(),
  abilitiesPluginVersion: z.string().min(1).nullable().optional(),
  connectedUserRole: z.string().min(1),
  permalinkStructure: z.enum(["pretty", "plain"]),
});

/**
 * Resolve the last-accepted, typed site metadata for a WordPress connector
 * instance. Never throws for a missing-or-malformed `site_meta` blob — that is
 * a normal, expected `unknown/unparseable` result, not an exceptional one
 * (parsing uses zod's `safeParse`, never `parse`). Underlying store/DB
 * failures are a DIFFERENT case and are NOT swallowed here — they propagate
 * exactly as every other read member on this publication (`readInstanceById`,
 * `getAPISettings`, ...) already does, so a genuine infrastructure failure
 * stays visible to callers/observability rather than silently reading as "no
 * inventory".
 *
 * `connectorKey` is exposed (mirrors `readSiteInventory`'s own signature) even
 * though the current binder only ever calls this bound to `"wordpress"`
 * (design §6's `resolveConnectedSiteMetadata(instanceId)` public shape) — the
 * companion store row is already keyed generically, so this stays reusable if
 * a future connector adopts the same inventory contract shape.
 */
export async function resolveConnectedSiteMetadata(
  connectorKey: string,
  instanceId: string,
  deps?: ServerStoreDeps,
): Promise<ConnectedSiteMetadata> {
  const record = await readSiteInventory(connectorKey, instanceId, deps);
  if (!record) {
    return { status: "unknown", reason: "no_inventory" };
  }
  const parsed = lenientSiteMetaSchema.safeParse(record.siteMeta);
  if (!parsed.success) {
    return { status: "unknown", reason: "unparseable" };
  }
  return {
    status: "known",
    wpVersion: parsed.data.wpVersion,
    phpVersion: parsed.data.phpVersion,
    adapterVersion: parsed.data.adapterVersion,
    abilitiesPluginVersion: parsed.data.abilitiesPluginVersion ?? null,
    connectedUserRole: parsed.data.connectedUserRole,
    permalinkStructure: parsed.data.permalinkStructure,
    receivedAt: record.receivedAt,
  };
}
