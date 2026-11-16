/**
 * THE RUN PAGE READS "Not published" (cinatra#4150 part 7a-2; the approved drawing, section XV: "Do not publish ends
 * the run: ... the run's status is stopped, the run page reads Not published"; an expired request is a decline).
 *
 * The run page's one status reading is the status pill in the run panel's header. For a STOPPED run whose publish
 * decision was declined or expired, its label reads "Not published"; the pill keeps the colour every stopped run has.
 * Every other status and every other decision keeps its label. The panel reads the decision through the publish card's
 * own authorized read, only for a stopped run on the run page (not inside a conversation host, where no pill is drawn
 * for the run page).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { classifyRunWaitInterrupt, runStatusBadgeLabel, runStatusPillStatus } from "../run-surface-status";

describe("the run status label of a run that was not published", () => {
  it.each(["declined", "expired"])("a stopped run whose publish decision is %s reads Not published", (decision) => {
    expect(runStatusBadgeLabel("stopped", null, decision)).toBe("Not published");
    // The pill keeps the stopped colour family: only the words change.
    expect(runStatusPillStatus("stopped")).toBe("failed");
  });

  it("an approved or open decision, or none, keeps the stopped label", () => {
    for (const decision of ["approved", "pending", "none", null, undefined]) {
      expect(runStatusBadgeLabel("stopped", null, decision)).toBe("stopped");
    }
  });

  it("a run that is not stopped keeps its own label whatever the decision says", () => {
    expect(runStatusBadgeLabel("completed", null, "declined")).toBe("completed");
    expect(runStatusBadgeLabel("pending_approval", null, "expired")).toBe("pending approval");
    expect(runStatusBadgeLabel("failed", null, "declined")).toBe("failed");
  });
});

describe("a run waiting at the publish moment", () => {
  it("reads as an approval, never an input, whatever else the interrupt carries", () => {
    expect(classifyRunWaitInterrupt({ lifecycleMoment: "publish", fieldName: "x" })).toBe("approval");
    expect(runStatusBadgeLabel("pending_approval", { lifecycleMoment: "publish", fieldName: "x" })).toBe("pending approval");
  });
});

describe("the run panel's header reads the publish decision of a stopped run", () => {
  const source = readFileSync(join(__dirname, "..", "agentic-run-panel.tsx"), "utf8");

  it("reads it through the publish card's own authorized read, only for a stopped run outside a conversation host", () => {
    const read = /const publishReading = usePublishDecisionCardState\(\{\s*runId: panelMountsHitlScreenCard && status === "stopped" \? runId : "",\s*auth: null,\s*reloadToken: 0,\s*\}\);/;
    expect(source).toMatch(read);
    expect(source).toMatch(/import \{ PublishDecisionCard, usePublishDecisionCardState \} from "\.\/publish-decision-card-view";/);
  });

  it("the header pill's label takes that reading, and its colour still comes from the status alone", () => {
    expect(source).toContain("{runStatusBadgeLabel(status, statedWaitDescriptor, publishReading?.state)}");
    expect(source).toContain("<StatusPill status={runStatusPillStatus(status)} glyph=\"dot\">");
  });
});
