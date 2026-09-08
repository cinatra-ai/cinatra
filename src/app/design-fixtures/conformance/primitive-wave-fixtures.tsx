"use client";

/**
 * Live DOM seams for the shared-primitives conformance wave, leg 1
 * (cinatra#3189).
 *
 * Every clause of the components drawing that names a rendered VALUE — a
 * ground, a stroke, a corner, a box, a type step, an animation step — is read
 * here, in the browser, under the app's own palette, by
 * tests/e2e/design/conformance/primitive-wave-leg1.spec.ts. The wave's own
 * method note (2026-09-01) is why: a value carried by a token or a scale step
 * resolves differently in the two palettes, and a reading taken outside the
 * palette the surface renders in is provisional at best and wrong at worst.
 *
 * These mounts are the REAL primitives with no substitution — only their
 * content is fixture text. Each carries a stable `data-wave-seam` name so a
 * reading can be labelled by the clause it answers rather than by a selector.
 */
import * as React from "react";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Checkbox } from "@/components/ui/checkbox";
import { StatusPill } from "@/components/ui/status-pill";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { buttonVariants } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const STATUS_VARIANTS = ["destructive", "warning", "success", "info"] as const;

export function PrimitiveWaveConformanceFixtures() {
  return (
    <div className="flex flex-col gap-6" data-wave-seam="root">
      {/* Accordion — "navy hairline rows", "rotating chevron", "200ms ease". */}
      <div data-wave-seam="accordion">
        <Accordion type="single" collapsible defaultValue="details">
          <AccordionItem value="details">
            <AccordionTrigger>Run details</AccordionTrigger>
            <AccordionContent>Step 3 of 7 · 12 drafts pending review.</AccordionContent>
          </AccordionItem>
          <AccordionItem value="tools">
            <AccordionTrigger>Tool calls</AccordionTrigger>
            <AccordionContent>Two tool calls.</AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>

      {/* Alert — "tinted bg + border", "12–14px text", "icon-led",
          "destructive = red", and the mustard/indigo roles. */}
      <div className="flex flex-col gap-2" data-wave-seam="alert">
        {STATUS_VARIANTS.map((variant) => (
          <Alert key={variant} variant={variant} data-wave-variant={variant}>
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="9" fill="currentColor" />
            </svg>
            <AlertTitle>Approval expired.</AlertTitle>
            <AlertDescription>The hold window closed at 15:30.</AlertDescription>
          </Alert>
        ))}
        <Alert data-wave-variant="default">
          <AlertTitle>Approval expired.</AlertTitle>
          <AlertDescription>The hold window closed at 15:30.</AlertDescription>
        </Alert>
      </div>

      {/* Avatar — "36–40px square", "random accent ground", "italic 800
          initial". Three sizes, and one accent ground. */}
      <div className="flex items-center gap-3" data-wave-seam="avatar">
        <Avatar data-wave-size="default">
          <AvatarFallback accent="plum">O</AvatarFallback>
        </Avatar>
        <Avatar size="lg" data-wave-size="lg">
          <AvatarFallback accent="green">E</AvatarFallback>
        </Avatar>
        <Avatar size="sm" data-wave-size="sm">
          <AvatarFallback accent="rust">R</AvatarFallback>
        </Avatar>
      </div>

      {/* Badge — "surface-muted bg", "line border", "9999px radius",
          "icon-led". The status-pill clause of the same section is NOT read
          here: it describes the StatusPill primitive, which is mounted on its
          own seam below. */}
      <div className="flex flex-wrap items-center gap-2" data-wave-seam="badge">
        <Badge data-wave-variant="default">Running</Badge>
        <Badge variant="secondary" data-wave-variant="secondary">
          Neutral
        </Badge>
        {STATUS_VARIANTS.map((variant) => (
          <Badge key={variant} variant={variant} data-wave-variant={variant}>
            <svg data-icon="inline-start" viewBox="0 0 24 24">
              <polygon points="6 3 20 12 6 21 6 3" fill="currentColor" />
            </svg>
            Approved
          </Badge>
        ))}
      </div>

      {/* Status pill — the "Badge / Pill" section's own status-pill sentence:
          "bg tinted from the status colour, text in the same colour, border at
          higher alpha. Use icon-led pills; never just dots." This is the seam
          that clause is read at; the badge above is the generic chip. */}
      <div className="flex flex-wrap items-center gap-2" data-wave-seam="status-pill">
        {(["running", "approved", "hold", "needs-review", "scheduled"] as const).map(
          (status) => (
            <StatusPill key={status} status={status} data-wave-status={status}>
              {status}
            </StatusPill>
          ),
        )}
      </div>

      {/* Breadcrumb — "chevron 12px 50% opacity", "slate links · ink current". */}
      <div data-wave-seam="breadcrumb">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="/agents">Agents</BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>Blog Draft Writer Agent (1)</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </div>

      {/* Checkbox — "control 16–18px", "indigo when on", "surface-muted when
          off". Both states are mounted, so neither reading needs a click. */}
      <div className="flex items-center gap-3" data-wave-seam="checkbox">
        <Checkbox aria-label="Email me, off" data-wave-state="off" />
        <Checkbox aria-label="Email me, on" defaultChecked data-wave-state="on" />
      </div>

      {/* Collapsible — the behaviour seam; no chrome of its own. */}
      <div data-wave-seam="collapsible">
        <Collapsible defaultOpen>
          <CollapsibleTrigger>Tool calls</CollapsibleTrigger>
          <CollapsibleContent>Two tool calls.</CollapsibleContent>
        </Collapsible>
      </div>

      {/* The live Input, mounted so the "Trigger mirrors Input chrome" reading
          has the control it is a mirror OF, in the same palette and the same
          paint. */}
      <div data-wave-seam="input">
        <Input aria-label="Mirror reference" placeholder="Most-used today" />
      </div>
    </div>
  );
}

/**
 * The overlay seams of the same leg. They are split out because each has to be
 * OPENED before it paints, so the suite clicks the trigger and then reads the
 * panel — a closed overlay renders nothing to measure.
 */
export function PrimitiveWaveOverlayFixtures() {
  return (
    <div className="flex flex-wrap items-center gap-3" data-wave-seam="overlays">
      {/* Dialog — "--paper (= pages)", "starts below 4rem navbar",
          "dim overlay", "etched header rule". */}
      <Dialog>
        <DialogTrigger data-wave-open="dialog" className={buttonVariants({ variant: "outline" })}>
          Open dialog
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve drafts.</DialogTitle>
            <DialogDescription>Twelve drafts pending your read.</DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>

      {/* AlertDialog — the same chrome clauses, plus "AlertDialog for
          destructive confirmations". */}
      <AlertDialog>
        <AlertDialogTrigger
          data-wave-open="alert-dialog"
          className={buttonVariants({ variant: "outline" })}
        >
          Open confirmation
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this run?</AlertDialogTitle>
            <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* DropdownMenu — "popover token", "surface-strong", "same hairline
          border", "slightly higher shadow", "scrollbar-thin". */}
      <DropdownMenu>
        <DropdownMenuTrigger
          data-wave-open="dropdown-menu"
          className={buttonVariants({ variant: "outline" })}
        >
          Most-used today
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Run details</DropdownMenuItem>
          <DropdownMenuItem>Tool calls</DropdownMenuItem>
          <DropdownMenuItem>Artifacts</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
