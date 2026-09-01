"use client";

/**
 * The Combobox's four colour claims, side by side with the things they are
 * claimed to match.
 *
 * The drawing: "A Select crossed with the Command menu: an Input-chrome trigger
 * opens a type-to-filter list. The current value carries an indigo check; the
 * highlighted row uses the indigo soft-tint."
 *
 * So the fixture mounts the plain Combobox, a plain Input to compare its
 * trigger chrome against, and one probe per colour the claims name — each
 * resolved by the same palette the control is drawn in, so the spec beside
 * this file compares two MEASURED colours rather than a colour against a
 * literal. The five surface probes are the drawing's whole surface vocabulary
 * ("5 tokens · paper to white"), so the popover's ground can be tested for
 * membership of that set and not only against one expected token. The line and
 * ink probes below them serve the second pair of claims — the outline the
 * drawing draws around the joined trigger-and-list pair, and the ink its
 * type-to-filter row is drawn in.
 */

import { useState } from "react";

import { Combobox } from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Short enough that every row, and the check on the current one, is on screen. */
const OPTIONS = [
  { value: "gmail", label: "Gmail Connector" },
  { value: "slack", label: "Slack Connector" },
  { value: "salesforce", label: "Salesforce Connector" },
  { value: "hubspot", label: "HubSpot Connector" },
  { value: "notion", label: "Notion Connector" },
];

export function ComboboxChromeFixture() {
  // Deliberately NOT the first row: the drawing's own picture opens the list
  // with the CURRENT value's row highlighted and checked, and a list that opens
  // anywhere else hides the check the moment the option count grows.
  const [value, setValue] = useState("salesforce");

  return (
    <main className="flex flex-col gap-6 px-8 py-10">
      {/* Ink probes — the colours the drawing's claims are made in. */}
      <span data-testid="primary-ink" className="text-primary">
        primary
      </span>
      <span data-testid="foreground-ink" className="text-foreground">
        foreground
      </span>
      {/* The indigo soft-tint, drawn exactly as a highlighted row draws it. */}
      <span data-testid="soft-tint" className="bg-primary/[0.08]">
        soft tint
      </span>

      {/* The drawing's five surfaces — "5 tokens · paper to white". */}
      <span data-testid="surface-paper" className="bg-background">
        paper
      </span>
      <span data-testid="surface" className="bg-surface">
        surface
      </span>
      <span data-testid="surface-strong" className="bg-surface-strong">
        surface strong
      </span>
      <span data-testid="surface-muted" className="bg-surface-muted">
        surface muted
      </span>
      <span data-testid="surface-sidebar" className="bg-sidebar">
        sidebar
      </span>

      {/* The two line weights the drawing draws with. The joined
          trigger-and-list pair takes the CONTROL boundary — the drawing outlines
          both halves of its own picture in `1px solid var(--line-strong)`, which
          is the token this palette hands controls through `--input` — while the
          rule that closes the search row INSIDE the list takes the section
          hairline, `border-bottom: 1px solid var(--line)`. Two different weights
          in one picture, so the test needs both to tell them apart. */}
      <span data-testid="line-hairline" className="border border-line">
        hairline
      </span>
      <span data-testid="line-strong" className="border border-line-strong">
        strong line
      </span>
      <span data-testid="control-boundary" className="border border-input">
        control boundary
      </span>

      {/* The muted ink the drawing's search row draws BOTH its glyph and its
          placeholder in — `color: var(--muted)` on each. */}
      <span data-testid="muted-ink" className="text-muted-foreground">
        muted
      </span>

      <div className="flex flex-col gap-1">
        <Label htmlFor="combobox-chrome" className="font-normal">
          Connector
        </Label>
        <Combobox
          id="combobox-chrome"
          value={value}
          onValueChange={setValue}
          options={OPTIONS}
          // The drawing's own picture types this row's placeholder out in full,
          // so the fixture draws the list the drawing draws rather than the
          // component's generic default.
          searchPlaceholder="Search connectors…"
          className="w-64"
        />
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor="input-chrome" className="font-normal">
          Input the trigger is told to mirror
        </Label>
        <Input id="input-chrome" className="w-64" defaultValue="Salesforce Connector" />
      </div>
    </main>
  );
}
