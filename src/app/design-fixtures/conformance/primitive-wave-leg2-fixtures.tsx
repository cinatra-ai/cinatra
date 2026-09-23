"use client";

/**
 * Live DOM seams for the shared-primitives conformance wave, leg 2
 * (cinatra#3189) — input OTP, scroll area, sidebar, switch, table, toggle, and
 * the two chrome clauses this leg absorbs on button and select.
 *
 * Same method as leg 1's file beside this one, for the same reason: every
 * clause of the components drawing that names a rendered VALUE — a box, a
 * corner, a track, a padding, a type step — is read here, in the browser, under
 * the app's own palette, by
 * tests/e2e/design/conformance/primitive-wave-leg2.spec.ts, and every reading
 * is taken twice, once in each palette the product ships. A value carried by a
 * token or a scale step resolves differently in the two palettes, so a reading
 * taken outside the palette the surface renders in is provisional at best.
 *
 * These mounts are the REAL primitives with no substitution — only their
 * content is fixture text. Each carries a stable `data-wave-seam` name so a
 * reading can be labelled by the clause it answers rather than by a selector.
 *
 * The badge seam the leg-2 cell matrix also names is NOT repeated here: leg 1
 * already mounts it (`data-wave-seam="badge"`, in primitive-wave-fixtures.tsx)
 * and grades the whole "Badge / Pill" section against it, including the one
 * clause that stays a recorded cross-repository departure.
 */
import * as React from "react";

import {
  InputOTP,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from "@/components/ui/input-otp";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/components/ui/sidebar";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

/** Enough rows that the scroll area's viewport genuinely overflows. */
const SCROLL_ROWS = [
  "Run #2,318 · Outreach",
  "Run #2,317 · Enricher",
  "Run #2,316 · Outreach",
  "Run #2,315 · Scorer",
  "Run #2,314 · Outreach",
  "Run #2,313 · Enricher",
  "Run #2,312 · Scorer",
  "Run #2,311 · Outreach",
];

const TABLE_ROWS = [
  { agent: "Outreach", run: "#2,318", started: "14:21" },
  { agent: "Enricher", run: "#2,317", started: "14:04" },
];

export function PrimitiveWaveLeg2ConformanceFixtures() {
  return (
    <div className="flex flex-col gap-6" data-wave-seam="leg2-root">
      {/* Input OTP — "40px white slots", "mono 18px digit", "active = indigo
          ring", "middle dash separator". Six slots split into two groups by the
          real separator, so the dash clause has the element it names. Three
          digits are filled so the mono face is read on a rendered glyph and not
          on an empty box. */}
      <div data-wave-seam="input-otp">
        <InputOTP maxLength={6} defaultValue="391">
          <InputOTPGroup>
            <InputOTPSlot index={0} />
            <InputOTPSlot index={1} />
            <InputOTPSlot index={2} />
          </InputOTPGroup>
          <InputOTPSeparator />
          <InputOTPGroup>
            <InputOTPSlot index={3} />
            <InputOTPSlot index={4} />
            <InputOTPSlot index={5} />
          </InputOTPGroup>
        </InputOTP>
      </div>

      {/* Scroll area — "6px overlay track", "low-alpha navy thumb", "fades when
          idle", "no native chrome". The primitive's own default type is used
          here rather than being forced: the idle cycle IS the clause, so the
          seam has to be the shipped behaviour. The suite scrolls it, reads the
          bar while it is up, then waits for the idle hide. */}
      <div data-wave-seam="scroll-area">
        <ScrollArea className="h-32 w-64 rounded-[7px] border border-line">
          <div className="p-2">
            {SCROLL_ROWS.map((row) => (
              <div key={row} className="border-b border-line py-1.5 text-row-title last:border-b-0">
                {row}
              </div>
            ))}
          </div>
        </ScrollArea>
      </div>

      {/* Sidebar — "active = indigo 6%", "labels: mono 10px", and the rail
          token "collapses to 56px rail".
          
          SidebarProvider is mounted for its CONTEXT and its token wrapper only,
          with no <Sidebar> shell: the shell is fixed-position and would take
          over the harness page. The rail's rendered width is therefore read on
          the real app sidebar; what is read HERE is the token that drives it,
          in both palettes, plus the two clauses that live on the group label
          and the active menu item. */}
      <div data-wave-seam="sidebar">
        <SidebarProvider className="min-h-0 bg-sidebar" data-wave-sidebar="provider">
          <div className="w-60">
            <SidebarGroupLabel data-wave-sidebar="group-label">
              Intelligence
            </SidebarGroupLabel>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton isActive data-wave-sidebar="item-active">
                  Chat
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton data-wave-sidebar="item-rest">
                  Agents
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </div>
        </SidebarProvider>
      </div>

      {/* Switch — "control 16–18px", "indigo when on", "surface-muted when
          off". Both states are mounted, so neither reading needs a click. */}
      <div className="flex items-center gap-3" data-wave-seam="switch">
        <Switch aria-label="Live, off" data-wave-state="off" />
        <Switch aria-label="Live, on" defaultChecked data-wave-state="on" />
      </div>

      {/* Table — "header mono 10px 700 uppercase", "body 13–14px ink",
          "IDs/times mono 11px slate", "cell padding 10–14px", and the prose's
          "right-align numerics and timestamps". The right alignment and the
          mono id/time treatment are CALL-SITE decisions the primitive cannot
          make for itself, so the seam states them the way the drawing's own
          example does.

          ONE HALF OF ONE CLAUSE IS RECORDED, NOT STATED HERE. "IDs/times mono
          11px slate" names three things; the face and the slate are set below
          and read live, and the 11px SIZE is not. The product has no named
          11px type-scale token — the scale runs 10px (--text-fact-line,
          text-badge-xs), 12.5px (--text-reading), 13px (--text-row-title) —
          and the type-scale gate bans a new bracket literal outside
          `components/ui/**`, where the product's own tables already spell it
          (`font-mono text-[11px] text-muted-foreground` in paginated-table.tsx
          and pagination.tsx). Writing 10px here to satisfy the linter would be
          a pixel off the drawing, which the gate's own note calls a departure,
          so the size is RECORDED instead, with its follow-up: a named
          mono-fact size token at 11px, the same shape --text-fact-line already
          has at 10px, after which both this seam and the two primitives above
          state the clause through a token. The size is read on the product's
          real listing in the proof round, where it IS stated. */}
      <div data-wave-seam="table">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Agent</TableHead>
              <TableHead>Run</TableHead>
              <TableHead className="text-right">Started</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {TABLE_ROWS.map((row) => (
              <TableRow key={row.run}>
                <TableCell data-wave-cell="body">{row.agent}</TableCell>
                <TableCell
                  className="text-right font-mono text-muted-foreground"
                  data-wave-cell="id"
                >
                  {row.run}
                </TableCell>
                <TableCell
                  className="text-right font-mono text-muted-foreground"
                  data-wave-cell="time"
                >
                  {row.started}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Toggle / Toggle group — "7px radius", "on = indigo tint + ink",
          "off = transparent + slate", and "the buttons share one outer border
          with hairlines between segments — no gaps". The segmented form is the
          drawing's own List / Board / Timeline view switcher, at `spacing={0}`
          and `variant="outline"`, which is the form that carries the shared
          outer border the clause names. The standalone toggle beside it is the
          same corner read without a group around it. */}
      <div className="flex flex-wrap items-center gap-4" data-wave-seam="toggle">
        <ToggleGroup
          type="single"
          defaultValue="board"
          spacing={0}
          variant="outline"
          data-wave-toggle="group"
        >
          <ToggleGroupItem value="list" data-wave-toggle="segment-rest">
            List
          </ToggleGroupItem>
          <ToggleGroupItem value="board" data-wave-toggle="segment-pressed">
            Board
          </ToggleGroupItem>
          <ToggleGroupItem value="timeline">Timeline</ToggleGroupItem>
        </ToggleGroup>
        <Toggle pressed data-wave-toggle="standalone-pressed" aria-label="Starred">
          Starred
        </Toggle>
      </div>

      {/* Select — "Trigger mirrors Input chrome.", the one chrome clause this
          leg absorbs from the sibling change. The mirror's reference, the live
          Input, is already mounted on leg 1's `input` seam on this same page,
          in the same palette and the same paint, which is what lets the reading
          be taken as a comparison rather than against a literal.

          The section's OTHER absorbed clause — the Button roster's missing
          "Primary" name — has no seam here, because it is not a rendered value:
          it is a name the recipe does not answer to, and it is recorded as a
          cross-repository departure in
          src/components/ui/__tests__/button-variant-set.test.tsx rather than
          fixed, because button.tsx is vendored into sixteen extension
          repositories behind the provenance gate. There is nothing on a page to
          measure until that cascade lands. */}
      <div data-wave-seam="select-trigger">
        <Select>
          <SelectTrigger aria-label="Most-used" className="w-60">
            <SelectValue placeholder="Most-used today" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="today">Most-used today</SelectItem>
            <SelectItem value="week">Most-used this week</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
