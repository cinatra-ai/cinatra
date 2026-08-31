// ---------------------------------------------------------------------------
// Design-conformance fixture route for the schedule step's Timezone control
// (cinatra#3142 §1). Mounts the REAL `TimezoneField` — the one render both
// Timezone controls on the schedule step go through — driven by the REAL
// `resolveTimezoneField`, in the three conditions the issue names: the
// ordinary case, a zone list the platform refused, and a bound value of the
// empty string. Static (no DB/auth) so Playwright can drive it on the
// production-equivalent boot, where the tokens actually resolve and the check's
// ink can be MEASURED rather than read off a class list. Kept off the
// pixel-diffed /design-fixtures index.
// ---------------------------------------------------------------------------

import type { Metadata } from "next";

import { TimezoneControlFixture } from "./timezone-control-fixture";

export const metadata: Metadata = {
  title: "Design Fixtures — Timezone control — Cinatra",
  description:
    "Internal route mounting the real schedule-step Timezone control in its ordinary, degraded and blank-bound conditions for Playwright conformance.",
};

export const dynamic = "force-dynamic";

export default async function TimezoneControlFixturePage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const q = (await searchParams) ?? {};
  const raw = q.condition;
  const condition = Array.isArray(raw) ? raw[0] : raw;
  return (
    <TimezoneControlFixture
      condition={
        condition === "degraded" || condition === "blank" ? condition : "ordinary"
      }
    />
  );
}
