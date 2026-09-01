"use client";

/**
 * Shared-primitive chrome fixture (cinatra#3189, audit leg 1 — Button, Select,
 * Card).
 *
 * Mounts the REAL primitives, unstyled by the call site, so their chrome can be
 * measured in a browser rather than asserted from source. A source-level class
 * assertion provably cannot see the class of defect this leg fixed: the card
 * drew a `ring-1`, whose computed `border-width` is 0 even though the element
 * plainly shows a 1px stroke, and the select trigger's height lived behind a
 * `data-[size=…]` modifier that a plain utility does not override. Only a
 * rendered measurement closes that gap.
 *
 * `Input` is mounted beside `SelectTrigger` on purpose: the drawing's Select
 * section says the trigger MIRRORS Input chrome, so the assertion is a
 * comparison between two live elements, not a restatement of pinned numbers.
 *
 * Every element is addressed by its own `data-slot` / `data-variant` /
 * `data-interactive` attribute inside this surface, so the fixture adds no
 * test-id contract entries.
 */
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function PrimitiveChromeFixtures() {
  return (
    <div data-surface-id="primitive-chrome" className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start gap-4">
        <Input aria-label="Agent name" defaultValue="Marketing Strategy" />
        <Select>
          <SelectTrigger aria-label="Cadence">
            <SelectValue placeholder="Most-used today" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="today">Most-used today</SelectItem>
            <SelectItem value="week">Most-used this week</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary">Primary</Button>
        <Button variant="default">Default</Button>
        <Button variant="destructive">Decline</Button>
      </div>

      <div className="flex flex-wrap items-start gap-4">
        <Card className="w-56">
          <CardContent>
            <CardTitle>Presentation card.</CardTitle>
            <div className="text-muted-foreground mt-0.5 text-xs">
              Nothing to touch here.
            </div>
          </CardContent>
        </Card>
        <Card interactive className="w-56">
          <CardContent>
            <CardTitle>Clickable card.</CardTitle>
            <div className="text-muted-foreground mt-0.5 text-xs">
              Hover lifts it 1px.
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
