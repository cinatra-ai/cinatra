// cinatra#4390 — every record, driver and contract follows the schedule card's
// Confirm to the value §VI draws.
//
// `specs/app-lifecycle-cards.html` §VI (design@06230d4e8de397e86e3216199342d15c0b4fc5a6)
// draws the card's one decision control as
// `data-action="confirm-schedule -> scheduled"` on the live and the expired
// Confirm floor. The product now emits that value on its Confirm button
// (packages/agents/src/__tests__/schedule-confirm-drawn-action-4390.test.tsx
// pins the DOM). This suite pins the readers that name the control: the capture
// contract's decision control, the capture requirements recomputed from it, the
// anchor contract's unresolved list, the conformance driver's literal set, the
// S9d walk plan's one press, and that no product file, test or driver still
// names the old value.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CARD_KINDS } from "../../ci/lib/capture-record-contract.mjs";
import { captureAnchorExpectations, loadAnchorContract } from "../lib/anchor-contract.mjs";
import { captureRequirementsFor } from "../lib/chat-hitl-capture-recorder.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const DRAWN = "confirm-schedule -> scheduled";
const DRAWN_SELECTOR = `[data-action="${DRAWN}"]`;
// The name the product shipped before #4390, spelled in parts so this file is
// not itself a reference to it.
const RETIRED = ["confirm", "schedule", "proposal"].join("-");
const RETIRED_SELECTOR = `[data-action="${RETIRED}"]`;

const readJson = (rel) => JSON.parse(readFileSync(join(REPO_ROOT, rel), "utf8"));

describe("cinatra#4390: the capture contract names the drawn Confirm", () => {
  it("CARD_KINDS.trigger_schedule_proposal.decisionControls is the drawn selector alone", () => {
    expect(CARD_KINDS.trigger_schedule_proposal.decisionControls).toEqual([DRAWN_SELECTOR]);
  });

  it("a pending chat capture owes the drawn control inside the card root, never the old one", () => {
    const required = captureRequirementsFor("chat_thread", "trigger_schedule_proposal", "pending");
    const selectors = required.map((r) => (typeof r === "string" ? r : r.selector));
    expect(selectors).toContain(DRAWN_SELECTOR);
    expect(selectors).not.toContain(RETIRED_SELECTOR);
  });

  it("the recomputed capture anchors (the digest's third input) carry the drawn value and not the old one", () => {
    const text = JSON.stringify(captureAnchorExpectations());
    expect(text).toContain(JSON.stringify(DRAWN_SELECTOR).slice(1, -1));
    expect(text).not.toContain(RETIRED);
  });
});

describe("cinatra#4390: the anchor contract re-ratified for the rename", () => {
  it("anchorsUnresolvedAtPin lists neither the old nor the drawn selector", () => {
    const { anchorsUnresolvedAtPin } = loadAnchorContract();
    expect(anchorsUnresolvedAtPin).not.toContain(RETIRED_SELECTOR);
    expect(anchorsUnresolvedAtPin).not.toContain(DRAWN_SELECTOR);
    expect(anchorsUnresolvedAtPin).toEqual([
      '[data-skill-action="adjust"]',
      '[data-skill-action="confirm"]',
      '[data-skill-action="skip"]',
    ]);
  });
});

describe("cinatra#4390: the conformance driver and the walk press the drawn control", () => {
  it("testid-contract.json requires the drawn literal of the card file and not the old one", () => {
    const contract = readJson("tests/e2e/design/conformance/testid-contract.json");
    const literals = [];
    const visit = (node) => {
      if (Array.isArray(node)) node.forEach(visit);
      else if (node && typeof node === "object") {
        if (node.file === "packages/agents/src/schedule-proposal-card.tsx" && Array.isArray(node.literals)) {
          literals.push(...node.literals);
        }
        Object.values(node).forEach(visit);
      }
    };
    visit(contract);
    expect(literals).toContain(`data-action="${DRAWN}"`);
    expect(literals).not.toContain(`data-action="${RETIRED}"`);
  });

  it("the S9d walk plan's one press names the drawn control", () => {
    const plan = readJson("scripts/audit/__fixtures__/capture-walk/s9d-rework-walk-plan.json");
    const confirm = plan.steps.find((s) => s.id === "confirm");
    expect(confirm).toBeDefined();
    const clicks = confirm.actions.filter((a) => a.action === "click");
    expect(clicks.map((a) => a.selector)).toEqual([DRAWN_SELECTOR]);
  });
});

describe("cinatra#4390: the capture index holds no observation of the old value", () => {
  it("no committed record counted the old selector", () => {
    // A record that counted the old selector never looked for the drawn one,
    // and the contract now requires the drawn one; such a record is not
    // evidence for the card that ships. The ten S9d-rework records were that
    // case and are withdrawn rather than edited by hand.
    const index = readJson("scripts/ci/chat-hitl-capture-index.json");
    const counted = index.records
      .filter((r) => (r.assertions ?? []).some((a) => a.selector === RETIRED_SELECTOR))
      .map((r) => r.cell);
    expect(counted).toEqual([]);
    expect(JSON.stringify(index.records)).not.toContain(RETIRED);
  });
});

describe("cinatra#4390: no product file, test or conformance driver names the old value", () => {
  it("git grep finds the old value in none of them", () => {
    const pathspecs = [
      "packages/",
      "src/",
      "tests/e2e/design/",
      "scripts/ci/lib/",
      "scripts/ci/__tests__/",
      "scripts/audit/lib/",
      "scripts/audit/__tests__/",
      "scripts/audit/__fixtures__/",
    ];
    const res = spawnSync("git", ["grep", "-l", "-F", RETIRED, "--", ...pathspecs], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    // git grep exits 1 when nothing matches; 0 means a file still names it, and
    // anything else means the search did not run, which is no answer.
    expect(res.error).toBeUndefined();
    expect({ status: res.status, files: res.stdout.trim().split("\n").filter(Boolean) }).toEqual({
      status: 1,
      files: [],
    });
  });
});
