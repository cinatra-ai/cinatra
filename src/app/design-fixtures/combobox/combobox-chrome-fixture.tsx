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
 * membership of that set and not only against one expected token.
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

      <div className="flex flex-col gap-1">
        <Label htmlFor="combobox-chrome" className="font-normal">
          Connector
        </Label>
        <Combobox
          id="combobox-chrome"
          value={value}
          onValueChange={setValue}
          options={OPTIONS}
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
