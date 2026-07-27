// The `wp-site-inventory` contract v1 (cinatra#2018 S3): the zod-validated
// payload a connected WordPress site pushes to core to report its MCP Adapter
// server inventory. This module is the SHARED coupling artifact between core's
// enrollment reconciler (`@/lib/wordpress-server-enrollment`) and the site-side
// producer (the cinatra plugin's S6 enrichment sender, cinatra#2021): the S3
// synthetic fixture (`src/lib/__tests__/__fixtures__/wp-site-inventory-v1.json`)
// and the live S6 payload validate against the SAME schema.
//
// Human-facing contract doc: docs/internals/contracts/wp-site-inventory-contract.md
//
// TRUST BOUNDARY. Transport authentication (the per-site `cnx_` credential),
// origin→instance association, the org cross-check and the monotonic
// `inventorySeq` acceptance gate all run in the intake route BEFORE a parsed
// payload reaches the reconciler — nothing in this payload can widen the
// sender's identity. Within the payload, `restPath` is cross-checked against
// `namespace`/`route` and is a PATH, only ever resolved relative to the
// verified instance's own siteUrl (same-site by construction — a payload
// cannot point cinatra at a foreign host). Declared transports/auth flags
// gate ELIGIBILITY only; credential acceptance is verified operationally on
// the first probe/catalog load, never trusted from the payload.
//
// This module is deliberately dependency-light (zod only): the intake route,
// the reconciler and unit tests all parse through it, and the site-side
// producer treats this file plus the golden fixture as the normative shape.

import { z } from "zod";

/** Contract versions this core build accepts. An unknown version is rejected
 * by the intake route as `unsupported_contract_version` together with this
 * list, so a newer site degrades loudly, never silently. */
export const SUPPORTED_SITE_INVENTORY_VERSIONS = ["v1"] as const;

/** Hard cap on reported servers per payload (schema-enforced). */
export const SITE_INVENTORY_MAX_SERVERS = 100;

/** MCP Adapter registry id from `get_servers()` — the discovered-server
 * natural identity the host digests into a stable `serverId`. */
export const ADAPTER_SERVER_ID_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,127}$/i;

/** Adapter REST namespace component (no slashes). */
export const SERVER_NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

/** Adapter route component (may contain path segments). */
export const SERVER_ROUTE_PATTERN = /^[a-z0-9][a-z0-9/_-]{0,127}$/i;

/** The default MCP Adapter server's canonical REST path. An entry flagged
 * `isDefault` (or carrying this exact path) refreshes metadata on the
 * grandfathered `mcp-adapter-default` enrollment row — the default server is
 * enrolled regardless of what any payload reports. */
export const DEFAULT_ADAPTER_SERVER_REST_PATH = "/mcp/mcp-adapter-default-server";

/** Site-normalized transport vocabulary. The site-side producer maps the
 * adapter's PHP transport class names into this enum (HttpTransport →
 * `streamable-http`) and reports anything it cannot map as `unknown`. */
export const siteInventoryTransportSchema = z.enum([
  "streamable-http",
  "stdio",
  "sse",
  "unknown",
]);

export type WpSiteInventoryTransport = z.infer<typeof siteInventoryTransportSchema>;

const siteBlockSchema = z.strictObject({
  wpVersion: z.string().min(1).max(32),
  phpVersion: z.string().min(1).max(32),
  /** `null` ⇒ the MCP Adapter plugin is absent — `servers` MUST be empty
   * (cross-checked below) and every previously discovered server retires. */
  adapterVersion: z.string().min(1).max(64).nullable(),
  abilitiesPluginVersion: z.string().min(1).max(64).nullable().optional(),
  /** The connection App-Password user's primary role (least-privilege
   * surfacing for admin UIs; never an authorization input). */
  connectedUserRole: z.string().min(1).max(64),
  permalinkStructure: z.enum(["pretty", "plain"]),
});

const serverEntrySchema = z.strictObject({
  adapterServerId: z.string().regex(ADAPTER_SERVER_ID_PATTERN),
  namespace: z.string().regex(SERVER_NAMESPACE_PATTERN),
  route: z.string().regex(SERVER_ROUTE_PATTERN),
  /** MUST canonically equal `"/" + namespace + "/" + route` (cross-checked
   * below; a mismatch rejects the whole payload). */
  restPath: z.string().min(2).max(256),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  version: z.string().max(64).optional(),
  transports: z.array(siteInventoryTransportSchema).min(1).max(8),
  /** Site-declared "this server demands its own auth" flag — such a server is
   * surfaced `present_unenrolled` (`custom_auth`), never silently dropped. */
  requiresDedicatedAuth: z.boolean(),
  /** True only for the adapter default server (cross-checked against the
   * default REST path below). */
  isDefault: z.boolean(),
  /** Advisory only — never trusted for catalog content. */
  toolCount: z.number().int().nonnegative().optional(),
});

export type WpSiteInventoryServerEntryV1 = z.infer<typeof serverEntrySchema>;

/**
 * The `wp-site-inventory` v1 payload. Ordering/anti-replay: `inventorySeq` is a
 * REQUIRED site-generated strictly-increasing integer per credential
 * generation (a persisted WP option the sender increments per send), bounded
 * to the JS-safe range `0 ≤ seq ≤ 2^53−1`; the intake accepts a payload only
 * when its `(credentialVersion, inventorySeq)` pair is strictly newer than the
 * last accepted pair, so a replayed or out-of-order inventory can never retire
 * newer servers. Credential rotation starts a new epoch (the sequence may
 * restart), which is also the recovery path for a site that lost its counter.
 * `collectedAt` is advisory (debugging) and NEVER trusted for ordering.
 */
export const wpSiteInventoryV1Schema = z
  .strictObject({
    contractVersion: z.literal("v1"),
    /** v1 is WordPress-only by definition; the intake ADDITIONALLY cross-checks
     * this against the authenticating connect-site credential row's client. */
    client: z.literal("wordpress"),
    inventorySeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    collectedAt: z.string().datetime({ offset: true }),
    /** Optional instance-claim: DISAMBIGUATION ONLY among origin-matched
     * instances — a claim can never select an instance outside the verified
     * origin's match set. */
    claimedInstanceId: z.string().min(1).max(128).optional(),
    site: siteBlockSchema,
    servers: z.array(serverEntrySchema).max(SITE_INVENTORY_MAX_SERVERS),
  })
  .superRefine((payload, ctx) => {
    if (payload.site.adapterVersion === null && payload.servers.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: "servers must be empty when site.adapterVersion is null (adapter absent)",
        path: ["servers"],
      });
    }
    const seen = new Set<string>();
    let defaultEntries = 0;
    for (const [index, server] of payload.servers.entries()) {
      const canonical = `/${server.namespace}/${server.route}`;
      if (server.restPath !== canonical) {
        ctx.addIssue({
          code: "custom",
          message: `restPath must canonically equal "/" + namespace + "/" + route (expected "${canonical}")`,
          path: ["servers", index, "restPath"],
        });
      }
      // The default-route ⇄ isDefault pin is BIDIRECTIONAL: an entry may
      // neither claim isDefault on another route nor sit on the default route
      // without declaring it. Without the second direction, an entry could
      // alias an arbitrary adapterServerId onto the default route and shadow
      // that id's real discovered server out of the reconciler's retire pass.
      if (server.isDefault && server.restPath !== DEFAULT_ADAPTER_SERVER_REST_PATH) {
        ctx.addIssue({
          code: "custom",
          message: `isDefault is reserved for the adapter default server at "${DEFAULT_ADAPTER_SERVER_REST_PATH}"`,
          path: ["servers", index, "isDefault"],
        });
      }
      if (!server.isDefault && server.restPath === DEFAULT_ADAPTER_SERVER_REST_PATH) {
        ctx.addIssue({
          code: "custom",
          message: `an entry on "${DEFAULT_ADAPTER_SERVER_REST_PATH}" must declare isDefault`,
          path: ["servers", index, "isDefault"],
        });
      }
      if (server.isDefault) {
        defaultEntries += 1;
        if (defaultEntries > 1) {
          ctx.addIssue({
            code: "custom",
            message: "at most one default-server entry is allowed per payload",
            path: ["servers", index, "isDefault"],
          });
        }
      }
      if (seen.has(server.adapterServerId)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate adapterServerId "${server.adapterServerId}" — registry ids must be unique per payload`,
          path: ["servers", index, "adapterServerId"],
        });
      }
      seen.add(server.adapterServerId);
    }
  });

export type WpSiteInventoryV1 = z.infer<typeof wpSiteInventoryV1Schema>;
