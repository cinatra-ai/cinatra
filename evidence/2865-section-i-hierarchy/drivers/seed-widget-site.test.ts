// cinatra#2865 §I widget pair, step 1 — register a widget INSTANCE and its
// connect-site so the `site_widget` host can be driven without a WordPress
// container.
//
// WHY THIS FILE EXISTS AT ALL. The previous round of this evidence directory
// withheld the widget pair and wrote that "the embedded column would not
// authenticate on this lane". That reading was wrong, and this file is the
// correction: the frame sat at `data-phase="signin"` and its hosted-PKCE popup
// died because THIS LANE HAD NEVER PROVISIONED THE WIDGET — no instance row,
// no connect-site — not because the ceremony is unavailable here. With the two
// rows below written, the same popup completes and the frame mints its own
// `cwu_`.
//
// Nothing here is written by hand. It calls the two SHIPPED writers the CMS
// OAuth exchange itself calls —
//   * `writeConnectorConfigToDatabase("wordpress", { instances: [...] })`
//     (src/lib/database.ts), the store the connector's own dev-setup hook
//     writes its `instances[]` row into, and
//   * `upsertConnectSiteAndMintCredential(...)` (src/lib/connect-provisioning.ts),
//     the function `POST /api/connect/token` calls to mint a site.
// Everything the widget then does — the PKCE frame handshake, the `cwu_` mint,
// the resolve/decide envelope — is the shipped path, unseeded.
//
// Recipe of record: `evidence/2754-island-wire/README.md` + that round's
// `drivers/02-seed-widget-site.mts`, which this follows rather than reinvents.
//
// Usage: pnpm vitest run --config evidence/2865-section-i-hierarchy/drivers/seed-widget-site.config.ts
//   with CAP_WIDGET_ORIGIN / CAP_INSTANCE_ID / CAP_ORG_ID / CAP_ADMIN_USER_ID in
//   the environment. It runs under vitest rather than plain node for ONE reason:
//   the shipped writers pull in `server-only`, and the repo's vitest config is
//   what aliases that to `tests/__stubs__/server-only.ts`.
import { it } from "vitest";
import {
  readConnectorConfigFromDatabase,
  writeConnectorConfigToDatabase,
} from "../../../src/lib/database";
import { upsertConnectSiteAndMintCredential } from "../../../src/lib/connect-provisioning";
import { deriveFrameBinding } from "../../../src/lib/widget-frame-auth";

// The host-page origin and the instance id come from the ENVIRONMENT, never
// from a literal: the lane's own ports are not written into this file.
const WIDGET_ORIGIN = process.env.CAP_WIDGET_ORIGIN;
const INSTANCE_ID = process.env.CAP_INSTANCE_ID;
const CLIENT = "wordpress";

if (!WIDGET_ORIGIN || !INSTANCE_ID) {
  throw new Error("set CAP_WIDGET_ORIGIN and CAP_INSTANCE_ID");
}

const org = process.env.CAP_ORG_ID;
const admin = process.env.CAP_ADMIN_USER_ID;
if (!org || !admin) throw new Error("set CAP_ORG_ID and CAP_ADMIN_USER_ID");

it("seeds the widget instance and its connect-site", () => {
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
    name: "2865 section-I widget capture site",
    username: "cap2865-capture",
    applicationPassword: "2865 capture placeholder (no WordPress is called)",
  });
  writeConnectorConfigToDatabase(CLIENT, { ...(current ?? {}), instances: kept });
  console.log(`instances[] now: ${JSON.stringify(kept.map((r) => (r as { id?: string }).id))}`);

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
      orgId: site.orgId,
      credentialVersion: site.credentialVersion,
    })}`,
  );

  // 3. Prove the binding the frame will be judged by actually closes. This is the
  //    assertion the previous round never made — and the one that would have shown
  //    it the widget was unprovisioned rather than unavailable.
  const binding = deriveFrameBinding({ assistant: CLIENT, instanceId: INSTANCE_ID });
  console.log(`deriveFrameBinding: ${JSON.stringify(binding)}`);
  if (!binding.ok) throw new Error(`frame binding did not close: ${JSON.stringify(binding)}`);
  console.log("SEEDED OK");

});
