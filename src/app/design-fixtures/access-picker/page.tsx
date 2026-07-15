// ---------------------------------------------------------------------------
// Design-conformance fixture route for the unified access picker (cinatra#1607):
// the ONE AccessCombobox driven in both modes — selectionMode="multiple" (the
// checkbox multi-select, cinatra#1072) AND the default single-select
// (cinatra#1508 / #1509 §4.1 — hierarchy, selection synthesis, disabled rows).
// Static (no DB/auth) so Playwright can drive the real component. Kept off the
// pixel-diffed /design-fixtures index.
// ---------------------------------------------------------------------------

import type { Metadata } from "next";
import { AccessPickerFixture } from "./access-picker-fixture";

export const metadata: Metadata = {
  title: "Design Fixtures — Access picker (selectionMode) — Cinatra",
  description:
    "Internal route mounting the real unified AccessCombobox in both selection modes against seeded scopes for Playwright conformance.",
};

export const dynamic = "force-dynamic";

export default function AccessPickerFixturePage() {
  return <AccessPickerFixture />;
}
