// ---------------------------------------------------------------------------
// Design-conformance fixture route for the checkbox multi-select access picker
// (cinatra#1072, multi-scope W3). Static (no DB/auth) so Playwright can drive
// the real component. Kept off the pixel-diffed /design-fixtures index.
// ---------------------------------------------------------------------------

import type { Metadata } from "next";
import { AccessPickerFixture } from "./access-picker-fixture";

export const metadata: Metadata = {
  title: "Design Fixtures — Access picker (multi-scope W3) — Cinatra",
  description:
    "Internal route mounting the real multi-select AccessComboboxHierarchical against seeded scopes for Playwright conformance.",
};

export const dynamic = "force-dynamic";

export default function AccessPickerFixturePage() {
  return <AccessPickerFixture />;
}
