// A run whose ledger count stands at its template's cap, and one a single send below it.
// Data only: it imports nothing, and the tests that read it supply the count per run.

export const W9_ORG_ID = "org-w9-td";
export const W9_OWNER_ID = "owner-w9-td";

const W9_TEMPLATE_ID = "tpl-w9-td-1";

/** A run of the organisation whose performed-send count (see W9_PERFORMED_SENDS) equals the stamped cap of 3. */
export const W9_RUN_AT_CAP = {
  id: "run-w9-td-at-cap",
  templateId: W9_TEMPLATE_ID,
  runBy: W9_OWNER_ID,
  orgId: W9_ORG_ID,
  status: "pending_approval",
  inputParams: { campaignId: "camp-w9-td" },
  dependentInstallId: null,
  authPolicy: null,
  oboCeiling: null,
};

/** A second run of the same organisation, one send below the stamped cap of 3. */
export const W9_RUN_BELOW_CAP = {
  id: "run-w9-td-below-cap",
  templateId: W9_TEMPLATE_ID,
  runBy: W9_OWNER_ID,
  orgId: W9_ORG_ID,
  status: "pending_approval",
  inputParams: { campaignId: "camp-w9-td" },
  dependentInstallId: null,
  authPolicy: null,
  oboCeiling: null,
};

/** A template whose one step stamps a cap of 3. */
export const W9_TEMPLATE_STAMPED_CAP_3 = {
  id: W9_TEMPLATE_ID,
  approvalPolicy: { steps: [{ metadata: { cinatra: { maxGateVisits: 3 } } }] },
};

/** A template that stamps no cap at all. */
export const W9_TEMPLATE_UNSTAMPED = {
  id: W9_TEMPLATE_ID,
  approvalPolicy: { steps: [] },
};

/** A template whose one step stamps a cap of 500, above the ceiling of 100. */
export const W9_TEMPLATE_STAMPED_ABOVE_CEILING = {
  id: W9_TEMPLATE_ID,
  approvalPolicy: { steps: [{ metadata: { cinatra: { maxGateVisits: 500 } } }] },
};

/** The ledger count each run stands at, by run id. */
export const W9_PERFORMED_SENDS: Record<string, number> = {
  "run-w9-td-at-cap": 3,
  "run-w9-td-below-cap": 2,
};

/** The gate answer that asks for one more send. */
export const W9_SEND_ENVELOPE = JSON.stringify({
  action: "send",
  recipientEmail: "to@example.com",
  selectionMode: "random_initial",
});

/** The gate answer that asks to continue. */
export const W9_CONTINUE_ENVELOPE = JSON.stringify({ action: "continue" });
