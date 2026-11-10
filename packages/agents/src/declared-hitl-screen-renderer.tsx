"use client";

// The host's card for an agent's DECLARED HITL screen (cinatra#3470).
//
// An agent package declares the screen of its mid-run gate as data
// (`cinatra.fieldRenderers[].screen`, allow-listed by
// scripts/extensions/agent-hitl-screen-schema.mjs); the host draws it here with
// its own components. Every word on the card is the declaration's or the run
// value's: this module carries no agent text and names no extension. The
// card draws no send control of its own. A decision or a field only STAGES
// its answer, and the host's one Continue beneath the card sends it, a
// decline as a decline.

import { useState, type ComponentType, type ReactNode } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { FieldRendererProps } from "./field-renderer-registry";

type Section =
  | { type: "note"; text: string }
  | { type: "fact"; label: string; key: string; qualifierKey?: string }
  | { type: "words"; key: string; label?: string }
  | { type: "quote"; key: string }
  | { type: "field"; key: string; label: string; multiline?: boolean; placeholder?: string };

export type DeclaredHitlCard = {
  layout: "card";
  title: string;
  sections?: Section[];
  decisions?: { label: string; answer: Record<string, unknown> }[];
  carry?: string[];
  requires?: string[];
};

/** The run value's OWN text under `key`; anything else reads as blank. */
function textOf(v: Record<string, unknown>, key: string): string {
  const x = Object.hasOwn(v, key) ? v[key] : undefined;
  return typeof x === "string" ? x : "";
}

/** Only an http(s) address is ever drawn as a link. */
function isWebAddress(text: string): boolean {
  try {
    const u = new URL(text);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

export function makeDeclaredHitlScreenRenderer(
  screen: DeclaredHitlCard,
): ComponentType<FieldRendererProps> {
  function DeclaredHitlScreenRenderer({ value, onChange, disabled }: FieldRendererProps) {
    const v: Record<string, unknown> =
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const [picked, setPicked] = useState<number | null>(null);
    const ready = (screen.requires ?? []).every((k) => textOf(v, k).trim() !== "");
    const locked = disabled === true || !ready;
    // The carried run values ride on every staged answer (own keys only).
    const carried = (): Record<string, unknown> =>
      Object.fromEntries(
        (screen.carry ?? []).filter((k) => Object.hasOwn(v, k)).map((k) => [k, v[k]]),
      );

    const section = (s: Section, i: number): ReactNode => {
      if (s.type === "note") {
        return <p key={i} className="text-sm text-muted-foreground">{s.text}</p>;
      }
      if (s.type === "field") {
        const id = `declared-hitl-field-${i}`;
        const control = {
          id,
          value: textOf(v, s.key),
          placeholder: s.placeholder,
          disabled: locked,
        };
        const write = (text: string) => onChange({ ...carried(), [s.key]: text });
        return (
          <div key={i} className="flex flex-col gap-1.5">
            <Label htmlFor={id}>{s.label}</Label>
            {s.multiline === true ? (
              <Textarea {...control} onChange={(e) => write(e.target.value)} />
            ) : (
              <Input {...control} onChange={(e) => write(e.target.value)} />
            )}
          </div>
        );
      }
      const text = textOf(v, s.key);
      if (text.trim() === "") return null;
      if (s.type === "quote") {
        return <p key={i} className="whitespace-pre-wrap text-sm text-muted-foreground">{text}</p>;
      }
      if (s.type === "words") {
        const id = `declared-hitl-words-${i}`;
        return (
          <div key={i} className="flex flex-col gap-1.5">
            {s.label ? <Label htmlFor={id}>{s.label}</Label> : null}
            <p id={id} className="whitespace-pre-wrap rounded-md border border-line bg-surface p-3 text-sm text-foreground">
              {text}
            </p>
          </div>
        );
      }
      const qualifier = s.qualifierKey ? textOf(v, s.qualifierKey).trim() : "";
      return (
        <p key={i} className="text-sm text-muted-foreground">
          <span className="text-foreground">
            {qualifier ? `${s.label} (${qualifier}):` : `${s.label}:`}
          </span>{" "}
          {isWebAddress(text) ? (
            <Link href={text} target="_blank" rel="noreferrer" className="underline underline-offset-4">
              {text}
            </Link>
          ) : (
            text
          )}
        </p>
      );
    };

    const decisions = screen.decisions ?? [];
    return (
      <Card className="border-line bg-surface backdrop-blur-none">
        <CardHeader>
          <CardTitle>{screen.title}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">{(screen.sections ?? []).map(section)}</CardContent>
        {decisions.length > 0 ? (
          <CardFooter className="flex justify-end gap-2">
            {decisions.map((d, i) => (
              <Button
                key={i}
                type="button"
                variant={i === decisions.length - 1 ? "default" : "outline"}
                aria-pressed={picked === i}
                className={picked === i ? "ring-2 ring-ring ring-offset-2" : undefined}
                disabled={locked}
                onClick={() => {
                  setPicked(i);
                  onChange({ ...carried(), ...d.answer });
                }}
              >
                {d.label}
              </Button>
            ))}
          </CardFooter>
        ) : null}
      </Card>
    );
  }
  DeclaredHitlScreenRenderer.displayName = "DeclaredHitlScreenRenderer";
  return DeclaredHitlScreenRenderer;
}
