// Inventory truth-up. The 9 surfaces the rollout gate
// tracked as PENDING are not real redirect-form writes: 6 email-outreach stage
// actions are archived stubs (no object mutation) and 3 lists actions are
// exported-but-unwired (no form/UI consumer). This pins those facts so the gate
// stays honest — if a stub becomes a real write, or a form wires one of the
// unwired actions, these source-pins fail and force reclassification.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), "utf8");

const inv = JSON.parse(
  read("src/lib/object-history/__generated__/write-surface-inventory.json"),
) as { tally: Record<string, number>; surfaces: Array<{ action: string; status: string }> };
const status = (a: string) => inv.surfaces.find((s) => s.action === a)?.status;

describe("email-outreach stage actions are archived stubs → EXCLUDED", () => {
  const stubs = [
    "confirmCampaignRecipients",
    "removeEmailOutreachRecipient",
    "removeEmailOutreachRecipients",
    "updateInitialDraft",
    "dismissReviewRecommendation",
    "applyReviewRecommendation",
  ];
  it("all six are EXCLUDED in the inventory", () => {
    for (const a of stubs) expect(status(a)).toBe("EXCLUDED");
  });
  it("the underlying primitive handlers are {ok:true} stubs (no object mutation)", () => {
    const src = read("packages/agents/src/email-outreach-stage-actions.ts");
    expect(src).toMatch(/primitive handlers are archived/);
    expect(src).toMatch(/email_outreach_recipients_confirm: async \(_req: unknown\) => \(\{ ok: true \}\)/);
    expect(src).toMatch(/email_outreach_recipients_clear: async \(_req: unknown\) => \(\{ ok: true \}\)/);
    expect(src).toMatch(/email_outreach_initial_drafts_update: async \(_req: unknown\) => \(\{ ok: true \}\)/);
    expect(src).toMatch(/email_outreach_review_recommendation_dismiss: async \(_req: unknown\) => \(\{ ok: true \}\)/);
    expect(src).toMatch(/email_outreach_review_recommendation_apply_start: async \(_req: unknown\) => \(\{ ok: true \}\)/);
  });
});

// The lists-actions block was removed: the @cinatra-ai/lists write surface
// (actions.ts + pages.tsx) was retired in the Twenty migration. CRM lists are
// Twenty Views now (no cinatra-side UI; curation flows through the
// list-curator-agent + the crm_list_* facade). The updateListAction /
// addListMembersAction / removeListMembersAction / createListAction /
// deleteListAction surfaces no longer exist, so they drop out of the
// write-surface inventory entirely.

describe("inventory tally after the CRM-surface retirement", () => {
  it("12 EXCLUDED / 1 MIGRATED / 0 PENDING — the retired account/contact/list write surfaces are gone; the surviving entries are email-outreach stubs + reads + restoreObjectToVersionAction", () => {
    expect(inv.tally).toEqual({ EXCLUDED: 12, MIGRATED: 1 });
  });
});
