// THE SECOND DISCLOSED LANE PROVISIONING WRITE — the connector instance row the
// third-party application's widget is looked up by.
//
// `deriveFrameBinding` (`src/lib/widget-frame-auth.ts:145`) resolves the frame
// in two halves: the INSTANCE -> its registered origin (this row), and the
// origin -> exactly one active connect site (minted in the next step through the
// product's OWN consent screen). On a real deployment the instance row is
// written by the CMS connector's own registration; no CMS exists on this lane,
// so it is written here through the SHIPPED writer
// `writeConnectorConfigToDatabase` — the same function the connector's own
// dev-setup hook and the CMS exchange call — exactly as
// `evidence/2754-island-wire/` and `evidence/2790-s9f-host-parity/` recorded it.
//
// It writes ONE key: `connector_config:wordpress`. No run, gate, park, record,
// review task or status is written by this file. The two credential fields are
// present-but-inert placeholders: no CMS exists on this lane and none is called.
import { describe, it, expect } from "vitest";

import { writeConnectorConfigToDatabase, readConnectorConfigFromDatabase } from "@/lib/database";
import { deriveFrameBinding } from "@/lib/widget-frame-auth";

const WIDGET_ORIGIN = process.env.WIDGET_ORIGIN!;
const INSTANCE_ID = process.env.WIDGET_INSTANCE_ID!;
const CLIENT = "wordpress";

describe("the third-party application's widget instance", () => {
  it("registers the instance through the shipped writer and reads it back", () => {
    expect(WIDGET_ORIGIN, "WIDGET_ORIGIN").toBeTruthy();
    expect(INSTANCE_ID, "WIDGET_INSTANCE_ID").toBeTruthy();
    writeConnectorConfigToDatabase(CLIENT, {
      instances: [
        {
          id: INSTANCE_ID,
          siteUrl: WIDGET_ORIGIN,
          name: "The third-party application this round photographs",
          username: "w6b3-capture",
          applicationPassword: "w6b3 placeholder (no CMS is called on this lane)",
        },
      ],
    });
    const back = readConnectorConfigFromDatabase<{ instances?: Array<{ id?: string; siteUrl?: string }> }>(
      CLIENT,
      {},
    );
    const ids = (back?.instances ?? []).map((i) => ({ id: i.id, siteUrl: i.siteUrl }));
    console.log(`INSTANCES ${JSON.stringify(ids)}`);
    expect(ids).toEqual([{ id: INSTANCE_ID, siteUrl: WIDGET_ORIGIN }]);
  });

  it("reports what the frame binding says at this point", () => {
    const binding = deriveFrameBinding({ assistant: CLIENT, instanceId: INSTANCE_ID });
    console.log(`FRAME BINDING ${JSON.stringify(binding)}`);
    expect(binding).toBeTruthy();
  });
});
