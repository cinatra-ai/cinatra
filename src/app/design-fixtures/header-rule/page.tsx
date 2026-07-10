import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import {
  Tabs,
  TabsListRow,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";

export const metadata: Metadata = {
  title: "Design Fixtures — Page-header section rule — Cinatra",
  description:
    "Internal route mounting the REAL connector-setup page chrome (PageHeader divider + TabsListRow) so the header-rule conformance gate can assert the etched paired-line rule matches design/specs/app.html byte-for-byte.",
};

/**
 * /design-fixtures/header-rule.
 *
 * Internal, unlinked route. The functional-acceptance harness for the
 * PAGE-HEADER SECTION RULE — the etched paired-line divider that closes every
 * page header and every under-header tab row (design/specs/app.html, "Page
 * header" + §Dividers: "Full navy, 1px each, 5px gap … Never use a neutral grey
 * on a divider").
 *
 * Connector setup pages repeatedly shipped the WRONG rule here (a grey UA <hr>
 * fallback, a single grey hairline, or a two-tone bevel), because the rule was
 * only ever eyeballed. This fixture mounts the REAL shared chrome the setup
 * pages compose —
 *
 *   • `PageHeader` (divider on) → `<Separator major>` → `.divider-etched`
 *   • `TabsListRow`             → `<Separator major>` → `.divider-etched`
 *
 * — beside a copy of the app.html reference rule (the exact inline markup from
 * the spec's "Page header" example, spec line 1051). The paired
 * tests/e2e/design/conformance/header-rule.spec.ts asserts, on the
 * production-equivalent boot, that BOTH rendered rules paint the spec's two
 * full-navy (`--line-strong` #15213A) 1px lines with a 5px gap — and that
 * neither degrades to grey / a single line / an invisible rule. A wrong rule
 * fails CI here, mechanically, before it can reach a review.
 *
 * Kept OFF the pixel-diffed /design-fixtures index (same convention as the
 * conformance route) so the committed pixel baselines stay untouched; coverage
 * here is computed-style assertion, not snapshot.
 */
export default function HeaderRuleFixturePage() {
  return (
    <main className="min-h-screen bg-paper px-8 py-10">
      {/* 1 — page-header rule: PageHeader's own etched divider (divider on). */}
      <section
        data-testid="fixture-page-header"
        className="mx-auto mb-16 w-full max-w-3xl"
      >
        <PageHeader
          label="Management"
          title="Agents"
          description="Build, monitor and manage the agents in this workspace."
        />
      </section>

      {/* 2 — under-header tab-row rule: TabsListRow's etched divider (the
          tabbed connector setup surface — header divider off, rule owned by
          the tab row so the two never stack). */}
      <section
        data-testid="fixture-tabs-row"
        className="mx-auto mb-16 w-full max-w-3xl"
      >
        <PageHeader
          title="WordPress Widget"
          description="Connector setup"
          divider={false}
        />
        <Tabs defaultValue="credentials">
          <TabsListRow aria-label="Connector setup">
            <TabsTrigger value="credentials">Credentials</TabsTrigger>
            <TabsTrigger value="help">Help</TabsTrigger>
          </TabsListRow>
          <TabsContent value="credentials" className="mt-6">
            <p className="text-sm text-muted-foreground">Credentials form…</p>
          </TabsContent>
          <TabsContent value="help" className="mt-6">
            <p className="text-sm text-muted-foreground">Help…</p>
          </TabsContent>
        </Tabs>
      </section>

      {/*
        3 — SPEC REFERENCE rule: the exact inline markup from
        design/specs/app.html, "Page header" example (spec line 1051):
          <div style="height:5px;border-top:1px solid var(--line-strong);
                      border-bottom:1px solid var(--line-strong);margin-top:14px">
        The spec's own etched rule, reproduced verbatim, so the gate can assert
        the rendered chrome above paints the SAME navy the canonical spec does —
        not just a hardcoded literal. `--line-strong` resolves from the host
        token layer to #15213A === rgb(21,33,58).
      */}
      <section
        data-testid="fixture-spec-reference"
        className="mx-auto w-full max-w-3xl"
      >
        <div
          data-testid="spec-reference-rule"
          style={{
            height: "5px",
            borderTop: "1px solid var(--line-strong)",
            borderBottom: "1px solid var(--line-strong)",
            marginTop: "14px",
          }}
        />
      </section>
    </main>
  );
}
