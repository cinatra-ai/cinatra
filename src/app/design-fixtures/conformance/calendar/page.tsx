import type { Metadata } from "next";
import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { CalendarConformanceFixtures } from "./calendar-fixtures";

export const metadata: Metadata = { title: "Calendar conformance harness — Cinatra" };

/**
 * Static, dataless Calendar family fixture. Exact development-only admission
 * follows the existing upload fixture road in auth-route-guard.ts; ordinary
 * production stays session-protected. No auth setup, storage, or server data.
 * Kept off the shared conformance/index routes and their pixel baselines.
 */
export default function CalendarConformancePage() {
  return <Main className="min-h-screen">
    <PageHeader label="Design system" title="Calendar conformance harness" description="Internal — the real host Calendar and DatePicker with local day keys." />
    <PageContent className="pb-12"><CalendarConformanceFixtures /></PageContent>
  </Main>;
}
