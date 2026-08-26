// ---------------------------------------------------------------------------
// cinatra#2790 S9f round 2 — provision the widget instance + connect-site for
// the CONTENT-EDIT probe, through the two SHIPPED writers.
//
// The same two writers `evidence/2754-island-wire/README.md` names, called for
// the same reason: nothing here writes an instance or a credential by hand.
//   * `writeConnectorConfigToDatabase("wordpress", { instances: [...] })`
//     (src/lib/database.ts) — the store the connector's own dev-setup hook and
//     the CMS OAuth exchange write their `instances[]` row into;
//   * `upsertConnectSiteAndMintCredential(...)` (src/lib/connect-provisioning.ts)
//     — the same function `POST /api/connect/token` calls to mint a site.
// `deriveFrameBinding` is then asserted to close before anything is driven.
//
// It is a vitest file for one reason only: both writers are `server-only`
// modules, and the sibling configs in this directory already carry the stub
// alias that lets a driver import them. It asserts what it provisions rather
// than printing and hoping.
//
// LANE HYGIENE, disclosed: this lane database is a CLONE of an earlier lane, so
// `connector_config:wordpress` arrives carrying that lane's instance sealed
// under a key this lane does not hold. This round writes the instances array
// with THIS lane's instance only, so no row in it is undecryptable. Lane data,
// not code: it changes which site the widget is bound to, never what any
// surface draws.
//
// The two WordPress credential fields are present-but-inert placeholders, for
// the reason the island-wire round already recorded: no WordPress exists on this
// lane and none is called. The probe this provisions for measures whether the
// widget's conversation can REACH the content-editor carrier at all — a
// question answered before any site write.
// ---------------------------------------------------------------------------
import { describe, it, expect } from "vitest";

import { writeConnectorConfigToDatabase } from "@/lib/database";
import { upsertConnectSiteAndMintCredential } from "@/lib/connect-provisioning";
import { deriveFrameBinding } from "@/lib/widget-frame-auth";

const WIDGET_ORIGIN = process.env.PROBE_WIDGET_ORIGIN ?? "http://127.0.0.1:5591";
const INSTANCE_ID = process.env.PROBE_INSTANCE_ID ?? "s9f-r2-local-site";
const CLIENT = "wordpress";

describe("S9f r2 — the content-edit probe's widget provisioning", () => {
  it("writes this lane's instance and mints its connect-site through the shipped writers", () => {
    const org = process.env.LANE_ORG_ID;
    const admin = process.env.LANE_ADMIN_USER_ID;
    expect(org, "LANE_ORG_ID").toBeTruthy();
    expect(admin, "LANE_ADMIN_USER_ID").toBeTruthy();

    writeConnectorConfigToDatabase(CLIENT, {
      instances: [
        {
          id: INSTANCE_ID,
          siteUrl: WIDGET_ORIGIN,
          name: "S9f r2 content-edit probe site",
          username: "s9f-r2-probe",
          applicationPassword: "s9f r2 probe placeholder (no WordPress is called)",
        },
      ],
    });
    console.log(`instances[] now: 1 (id=${INSTANCE_ID}, siteUrl=${WIDGET_ORIGIN})`);

    const { site } = upsertConnectSiteAndMintCredential({
      client: CLIENT,
      widgetOrigin: WIDGET_ORIGIN,
      callbackOrigin: null,
      webhookSecretHash: null,
      adminUserId: admin as string,
      orgId: org as string,
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
    expect(site.client).toBe(CLIENT);
    expect(site.widgetOrigin).toBe(WIDGET_ORIGIN);
    expect(site.orgId).toBe(org);

    const binding = deriveFrameBinding({ assistant: CLIENT, instanceId: INSTANCE_ID });
    console.log(`deriveFrameBinding: ${JSON.stringify(binding)}`);
    expect(binding.ok, `frame binding did not close: ${JSON.stringify(binding)}`).toBe(true);
    console.log("PROVISION OK");
  });
});
