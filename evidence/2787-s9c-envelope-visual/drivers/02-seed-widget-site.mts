// S9c round-2 capture, step 2 — register a widget INSTANCE and its connect-site
// for a plain local page, so the `site_widget` host can be driven without a
// WordPress container.
//
// This writes nothing by hand: it calls the two SHIPPED writers the CMS OAuth
// exchange itself calls —
//   * `writeConnectorConfigToDatabase("wordpress", { instances: [...] })`
//     (src/lib/database.ts), the same store the connector's own dev-setup hook
//     writes its `instances[]` row into, and
//   * `upsertConnectSiteAndMintCredential(...)` (src/lib/connect-provisioning.ts),
//     the same function `POST /api/connect/token` calls to mint a site.
// Everything the widget then does — the PKCE frame handshake, the `cwu_` mint,
// the resolve/decide envelope — is the shipped path, unseeded.
//
// Usage: node --env-file=.env.local --import tsx 02-seed-widget-site.mts <widgetOrigin> <instanceId>
import {
  readConnectorConfigFromDatabase,
  writeConnectorConfigToDatabase,
} from "../../../src/lib/database";
import { upsertConnectSiteAndMintCredential } from "../../../src/lib/connect-provisioning";
import { deriveFrameBinding } from "../../../src/lib/widget-frame-auth";

const WIDGET_ORIGIN = process.argv[2] || "http://localhost:5573";
const INSTANCE_ID = process.argv[3] || "s9c-local-site";
const CLIENT = "wordpress";

const org = process.env.S9C_ORG_ID;
const admin = process.env.S9C_ADMIN_USER_ID;
if (!org || !admin) throw new Error("set S9C_ORG_ID and S9C_ADMIN_USER_ID");

// 1. The instance row, in the connector's own instances config.
const current = readConnectorConfigFromDatabase<{ instances?: unknown[] }>(CLIENT, {
  instances: [],
});
const instances = Array.isArray(current?.instances) ? [...current.instances] : [];
const kept = instances.filter(
  (r) => !(r && typeof r === "object" && (r as { id?: unknown }).id === INSTANCE_ID),
);
// The connector declares `requiredInstanceFields` = id/name/username/
// applicationPassword, and the `cit_` consume refuses an origin whose instance
// row is short of them (`origin_unconfigured`). The two WordPress credential
// fields are what the connector would use to call a WordPress REST API; this
// capture never calls one (there is no WordPress), so they are present-but-inert
// placeholders. Nothing on the lifecycle path reads them.
kept.push({
  id: INSTANCE_ID,
  siteUrl: WIDGET_ORIGIN,
  name: "S9c capture site",
  username: "s9c-capture",
  applicationPassword: "s9c capture placeholder (no WordPress is called)",
});
writeConnectorConfigToDatabase(CLIENT, { ...(current ?? {}), instances: kept });
console.log(`instances[] now: ${JSON.stringify(kept)}`);

// 2. The connect-site, minted by the same writer the real exchange uses.
const { site } = upsertConnectSiteAndMintCredential({
  client: CLIENT,
  widgetOrigin: WIDGET_ORIGIN,
  callbackOrigin: null,
  webhookSecretHash: null,
  adminUserId: admin,
  orgId: org,
});
console.log(
  `connect site: ${JSON.stringify({
    siteId: site.siteId,
    client: site.client,
    widgetOrigin: site.widgetOrigin,
    orgId: site.orgId,
    credentialVersion: site.credentialVersion,
  })}`,
);

// 3. Prove the binding the frame will be judged by actually closes.
const binding = deriveFrameBinding({ assistant: CLIENT, instanceId: INSTANCE_ID });
console.log(`deriveFrameBinding: ${JSON.stringify(binding)}`);
if (!binding.ok) throw new Error(`frame binding did not close: ${JSON.stringify(binding)}`);
console.log("SEEDED OK");
