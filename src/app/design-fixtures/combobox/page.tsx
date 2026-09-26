// ---------------------------------------------------------------------------
// Design-conformance fixture route for the Combobox (cinatra#3142).
//
// Mounts the REAL `@/components/ui/combobox` beside the REAL `@/components/ui/
// input`, on a short option list so every row — including the one carrying the
// current value — is on screen at once. Static (no DB/auth) so Playwright can
// drive it on the production-equivalent boot, where the tokens actually
// resolve and the drawing's four colour claims about this component can be
// MEASURED rather than read off a class list. Kept off the pixel-diffed
// /design-fixtures index.
// ---------------------------------------------------------------------------

import type { Metadata } from "next";

import { ComboboxChromeFixture } from "./combobox-chrome-fixture";

export const metadata: Metadata = {
  title: "Design Fixtures — Combobox — Cinatra",
  description:
    "Internal route mounting the plain Combobox beside an Input for Playwright conformance of the drawing's trigger, popover, check and active-row claims.",
};

export const dynamic = "force-dynamic";

export default function ComboboxChromeFixturePage() {
  return <ComboboxChromeFixture />;
}
