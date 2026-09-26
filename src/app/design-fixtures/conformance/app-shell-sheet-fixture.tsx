"use client";

/**
 * Side-sheet mount for the app-shell conformance guard (cinatra#833, moved
 * here by cinatra#3189).
 *
 * The #833 guard measures a right-side sheet's top offset against the live
 * app bar, so it needs a real `Sheet` on a route the real AppShell wraps. That
 * trigger used to live on the retired `/design-fixtures` primitives catalog;
 * the catalog is gone, so the guard's one mount moves onto this harness route.
 * This is NOT a second drawing of the design system: it renders a single real
 * component so a shipped geometry rule can be measured in a browser, and it
 * asserts nothing about how a sheet should look — the drawings do that.
 *
 * The trigger id and the sheet title are the guard's contract; renaming either
 * here breaks tests/e2e/design/app-shell-conformance.spec.ts.
 */
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

export function AppShellSheetFixture() {
  return (
    <div data-surface-id="app-shell-sheet" className="flex flex-wrap items-center gap-2">
      <Sheet>
        <SheetTrigger asChild>
          <Button variant="outline" data-testid="sheet-fixture-open">
            Open sheet
          </Button>
        </SheetTrigger>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>Run inspector</SheetTitle>
          </SheetHeader>
          Side-loaded inspection panel.
        </SheetContent>
      </Sheet>
    </div>
  );
}
