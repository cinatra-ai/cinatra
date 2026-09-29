import type { Metadata } from "next";

import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";

import { RunStepRailGeometryFixtures } from "./run-step-rail-fixtures";

export const metadata: Metadata = {
  title: "Design Fixtures — Run step rail row geometry — Cinatra",
  description:
    "Internal route rendering the run detail's step rail with wrapped lifecycle policy reasons, so the row-box geometry (cinatra#2840) is verifiable in a browser.",
};

/**
 * /design-fixtures/run-step-rail.
 *
 * Internal route. Not linked from navigation. Renders the real
 * `RunStepRailPanel` with wrapped lifecycle policy reasons so the row geometry
 * the report is about (cinatra#2840 — a wrapped reason must PUSH the following
 * rows down, never print over them) is assertion-verifiable in a browser
 * (tests/e2e/design/run-step-rail-geometry.spec.ts) without a run, a session or
 * a DB round-trip. Kept OFF the now-retired /design-fixtures catalog page which
 * cinatra#3189 removed; the Playwright coverage for this
 * route is assertion-based.
 */
export default function RunStepRailGeometryFixturesPage() {
  return (
    <Main className="min-h-screen">
      <PageHeader
        label="Design system"
        title="Run step rail — row geometry fixtures"
        description="Internal — the run detail's step rail: a lifecycle policy reason that wraps to several lines grows its own row and pushes the rows beneath it down; rows without a reason are unchanged."
      />
      <PageContent className="flex flex-col gap-8 pb-12">
        <RunStepRailGeometryFixtures />
      </PageContent>
    </Main>
  );
}
