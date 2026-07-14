// ---------------------------------------------------------------------------
// Design-conformance fixture route for the access pickers: the checkbox
// multi-select AccessComboboxHierarchical (cinatra#1072, multi-scope W3) AND
// the flat AccessCombobox (cinatra#1508 / #1509 §4.1 — hierarchy, selection
// synthesis, disabled rows). Static (no DB/auth) so Playwright can drive the
// real components. Kept off the pixel-diffed /design-fixtures index.
// ---------------------------------------------------------------------------

import type { Metadata } from "next";
import { AccessPickerFixture } from "./access-picker-fixture";

export const metadata: Metadata = {
  title: "Design Fixtures — Access picker (multi-scope W3) — Cinatra",
  description:
    "Internal route mounting the real AccessComboboxHierarchical (multi-select) and flat AccessCombobox against seeded scopes for Playwright conformance.",
};

export const dynamic = "force-dynamic";

export default function AccessPickerFixturePage() {
  return <AccessPickerFixture />;
}
