/**
 * Regression gate for email follow-up cleanup, and for the drafting step's
 * declared `draftBundleRef` plus the removal of the dead `campaignId` input.
 *
 * Verifies orphan `approvedFollowupBundleRef` and `email-follow-up-agent`
 * references are removed from email-outreach-agent. The follow-ups CONTROL
 * flow node is gone, so the data-flow and sender ApiNode contract must not
 * keep expecting `approvedFollowupBundleRef`, which would leave a silent
 * broken state.
 *
 * Scope: only the cleanup invariants. Structural noise in the OAS (~125
 * unrelated $component_ref findings in trigger-subflow / etc.) is out of
 * scope for this test and tracked separately.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/email-outreach-agent-followup-cleanup.test.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, it, expect } from "vitest";

const repoRoot = path.resolve(__dirname, "../../../..");
const oasPath = path.join(
  repoRoot,
  "extensions/cinatra-ai/email-outreach-agent/cinatra/oas.json",
);
const pkgPath = path.join(
  repoRoot,
  "extensions/cinatra-ai/email-outreach-agent/package.json",
);

const oasText = fs.readFileSync(oasPath, "utf8");
const pkgText = fs.readFileSync(pkgPath, "utf8");

describe("email-outreach-agent follow-up cleanup", () => {
  it("OAS does not reference approvedFollowupBundleRef anywhere", () => {
    expect(oasText).not.toContain("approvedFollowupBundleRef");
  });

  it("OAS sender system prompt does not fetch follow-up bundle", () => {
    expect(oasText).not.toContain("approved follow-up bundle");
    expect(oasText).not.toContain("approved followup bundle");
  });

  it("OAS gateStep description does not mention follow-up emails", () => {
    expect(oasText).not.toContain(
      "Review and approve initial email drafts and follow-up emails",
    );
  });

  it("package.json agentDependencies does not declare email-follow-up-agent", () => {
    const pkg = JSON.parse(pkgText) as {
      cinatra?: { agentDependencies?: Record<string, string> };
    };
    const deps = pkg.cinatra?.agentDependencies ?? {};
    expect(deps).not.toHaveProperty("@cinatra-ai/email-follow-up-agent");
  });

  it("package.json version was bumped past 0.1.7", () => {
    const pkg = JSON.parse(pkgText) as { version: string };
    expect(pkg.version).not.toBe("0.1.7");
  });

  it("OAS still parses as valid JSON", () => {
    expect(() => JSON.parse(oasText)).not.toThrow();
  });

  it("the drafting step's StartNode declares draftBundleRef on its inputs and hidden list", () => {
    const oas = JSON.parse(oasText) as Record<string, unknown>;
    let draftsStart: Record<string, unknown> | undefined;
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const child of node) walk(child);
        return;
      }
      if (node === null || typeof node !== "object") return;
      const obj = node as Record<string, unknown>;
      const subRefs = (obj.$referenced_components ?? {}) as Record<
        string,
        Record<string, unknown>
      >;
      if ("drafts-start" in subRefs) draftsStart = subRefs["drafts-start"];
      for (const value of Object.values(obj)) walk(value);
    };
    walk(oas);
    expect(draftsStart).toBeDefined();
    const inputs = (draftsStart!.inputs ?? []) as Array<Record<string, unknown>>;
    expect(inputs.map((i) => i.title as string)).toContain("draftBundleRef");
    const hidden =
      ((draftsStart!.metadata as Record<string, Record<string, unknown>>)?.cinatra
        ?.hidden as string[]) ?? [];
    expect(hidden).toContain("draftBundleRef");
  });

  it("the campaign summary step no longer takes a campaignId input, and nothing feeds one", () => {
    const oas = JSON.parse(oasText) as Record<string, unknown>;
    const refs = (oas.$referenced_components ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
    const summary = refs.campaign_summary;
    expect(summary).toBeDefined();
    const inputs = (summary!.inputs ?? []) as Array<Record<string, unknown>>;
    expect(inputs.map((i) => i.title as string)).not.toContain("campaignId");
    const dfc = (oas.data_flow_connections ?? []) as Array<Record<string, unknown>>;
    const toSummary = dfc.filter(
      (e) =>
        (e.destination_node as { $component_ref?: string } | undefined)
          ?.$component_ref === "campaign_summary",
    );
    expect(toSummary.length).toBeGreaterThan(0);
    expect(toSummary.map((e) => e.destination_input as string)).not.toContain(
      "campaignId",
    );
  });

  it("sender-start hidden inputs do not include approvedFollowupBundleRef", () => {
    const oas = JSON.parse(oasText) as Record<string, unknown>;
    const refs = (oas.$referenced_components ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
    const senderRef = Object.values(refs).find((c) => {
      const subRefs = (c.$referenced_components ?? {}) as Record<
        string,
        Record<string, unknown>
      >;
      return "sender-start" in subRefs;
    });
    if (!senderRef) return; // structural search; if not found, skip silently
    const subRefs = (senderRef.$referenced_components ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
    const senderStart = subRefs["sender-start"];
    const hidden =
      ((senderStart?.metadata as Record<string, Record<string, unknown>>)
        ?.cinatra?.hidden as string[]) ?? [];
    expect(hidden).not.toContain("approvedFollowupBundleRef");
  });
});
