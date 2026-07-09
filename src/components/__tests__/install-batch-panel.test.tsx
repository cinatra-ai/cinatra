/**
 * InstallBatchPanel — per-member install progress (surface 2) + batch
 * compensation outcomes (surface 3), cinatra #209 item 2. Driven with REAL
 * ledger batch shapes; asserts the rendered progress rows, the outcome
 * headline, and the rolled-back / incomplete-rollback compensation detail.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { InstallBatchPanel } from "../extensions/install-batch-panel";
import type {
  InstallBatch,
  InstallBatchMember,
} from "@/lib/extension-install-batch-ops";

function member(over: Partial<InstallBatchMember> & { packageName: string }): InstallBatchMember {
  return {
    version: "1.0.0",
    typeId: "agent",
    status: "planned",
    preState: { present: false },
    ...over,
  };
}

function batch(over: Partial<InstallBatch> & { rootPackage: string; members: InstallBatchMember[] }): InstallBatch {
  return {
    batchId: "b-1",
    orgId: null,
    phase: "installing",
    createdAt: "2026-06-15T00:00:00.000Z",
    updatedAt: "2026-06-15T00:01:00.000Z",
    ...over,
  };
}

describe("InstallBatchPanel", () => {
  it("renders nothing when there are no batches", () => {
    expect(renderToStaticMarkup(<InstallBatchPanel batches={[]} />)).toBe("");
  });

  it("renders per-member progress rows for a successful batch", () => {
    const html = renderToStaticMarkup(
      <InstallBatchPanel
        batches={[
          batch({
            rootPackage: "@scope/root",
            phase: "finalized",
            members: [
              member({ packageName: "@scope/dep", status: "installed" }),
              member({ packageName: "@scope/root", status: "installed" }),
            ],
          }),
        ]}
      />,
    );
    expect(html).toContain("install-batch-panel");
    expect(html).toContain("Recent dependency installs");
    expect(html).toContain("@scope/dep");
    expect(html).toContain("@scope/root");
    expect(html).toContain("Installed @scope/root");
    expect(html).toContain('data-phase="finalized"');
    expect(html).toContain('data-status="installed"');
    // root flagged
    expect(html).toContain("root");
  });

  it("surfaces compensation outcomes for a rolled-back batch", () => {
    const html = renderToStaticMarkup(
      <InstallBatchPanel
        batches={[
          batch({
            rootPackage: "@scope/root",
            phase: "compensated",
            members: [
              member({ packageName: "@scope/dep", status: "compensated" }),
              member({ packageName: "@scope/root", status: "failed", detail: "gate refused" }),
            ],
          }),
        ]}
      />,
    );
    expect(html).toContain("batch-compensation");
    expect(html).toContain("Rolled back:");
    expect(html).toContain("@scope/dep");
    expect(html).toContain("rolled back cleanly");
  });

  it("flags an incomplete rollback (manual cleanup) loudly", () => {
    const html = renderToStaticMarkup(
      <InstallBatchPanel
        batches={[
          batch({
            rootPackage: "@scope/root",
            phase: "failed",
            members: [
              member({ packageName: "@scope/dep", status: "compensation-failed", detail: "uninstall threw" }),
              member({ packageName: "@scope/root", status: "failed" }),
            ],
          }),
        ]}
      />,
    );
    expect(html).toContain("Rollback incomplete");
    expect(html).toContain("manual cleanup");
    expect(html).toContain("@scope/dep");
  });

  // cinatra #1057 — post-install "needs configuration" affordance.
  it("renders deep-linked Configure affordances for unconfigured connectors", () => {
    const html = renderToStaticMarkup(
      <InstallBatchPanel
        batches={[
          batch({
            batchId: "b-cfg",
            rootPackage: "@cinatra-ai/list-curator-agent",
            phase: "finalized",
            members: [
              member({ packageName: "@cinatra-ai/linkedin-oauth-connector", status: "installed" }),
              member({ packageName: "@cinatra-ai/list-curator-agent", status: "installed" }),
            ],
          }),
        ]}
        configurationNeedsByBatch={{
          "b-cfg": {
            needs: [
              {
                packageName: "@cinatra-ai/linkedin-oauth-connector",
                displayName: "LinkedIn",
                slug: "linkedin-oauth-connector",
                settingsHref: "/connectors/cinatra-ai/linkedin-oauth-connector/setup",
                isRoot: false,
              },
            ],
            hasConnectors: true,
            allConfigured: false,
          },
        }}
      />,
    );
    expect(html).toContain("Finish setting up these connectors");
    // The HUMAN-READABLE manifest displayName is the primary label (owner
    // review #1234) — never only the package name.
    expect(html).toContain("LinkedIn");
    // The package name still renders, but only as muted secondary text.
    expect(html).toContain("@cinatra-ai/linkedin-oauth-connector");
    expect(html).toContain('href="/connectors/cinatra-ai/linkedin-oauth-connector/setup"');
    expect(html).toContain("batch-configuration-needs");
  });

  it("renders no configuration affordance when everything is configured", () => {
    const html = renderToStaticMarkup(
      <InstallBatchPanel
        batches={[
          batch({
            batchId: "b-ok",
            rootPackage: "@cinatra-ai/root",
            phase: "finalized",
            members: [member({ packageName: "@cinatra-ai/root", status: "installed" })],
          }),
        ]}
        configurationNeedsByBatch={{ "b-ok": { needs: [], hasConnectors: true, allConfigured: true } }}
      />,
    );
    expect(html).not.toContain("Finish setting up these connectors");
    expect(html).not.toContain("batch-configuration-needs");
  });
});
