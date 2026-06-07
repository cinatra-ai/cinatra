/**
 * Regression gate for email follow-up cleanup.
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
