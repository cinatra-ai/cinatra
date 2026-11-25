"use client";

// THE ONE GENERIC RENDERING of an agent's declared human-input step
// (cinatra#3470, app-lifecycle-cards V.1 "The agent's input card").
//
// A bundled agent declares the screen of a mid-run step as data
// (`cinatra.fieldRenderers[].screen`, allow-listed by
// scripts/extensions/agent-hitl-screen-schema.mjs). The host draws it here,
// with its own components and nothing written for one agent: every word on
// the card is the declaration's or the run value's.
//
// V.1: "The host supplies the frame and the control floor." So the card draws
// no frame and no send control of its own: the host's frame (the conversation
// card, or the run card's detail region) holds these fields, and the host's
// one Continue sends the answer, held by the entry's `continueReady` until
// every field holds text. A field only STAGES the whole answer
// (`declaredHitlStage`), so what is shown, what holds the Continue and what is
// sent are one reading.

import { useEffect, useId, type ComponentType, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { FieldRendererEntry, FieldRendererProps } from "./field-renderer-registry";
import {
  declaredHitlCardReady,
  declaredHitlStage,
  storedDeclaredCardOf,
  type DeclaredHitlCard,
  type DeclaredHitlSection,
} from "./hitl-gate-submit";

/** V.1 `nf-label` of a read-only value: the small uppercase mono label. */
const READ_ONLY_LABEL_CLASS = "font-mono text-badge-2xs uppercase text-muted-foreground";

function asRecord(x: unknown): Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
}

function textOf(v: Record<string, unknown>, key: string): string {
  const x = Object.hasOwn(v, key) ? v[key] : undefined;
  return typeof x === "string" ? x : "";
}

/** V.1 read-only facts: "its declared label over the value as text, with no box". */
function ReadOnlyValue({ label, text }: { label?: string; text: string }) {
  return (
    <div className="grid gap-[3px]">
      {label ? <span className={READ_ONLY_LABEL_CLASS}>{label}</span> : null}
      <span className="whitespace-pre-wrap text-xs leading-normal text-foreground">{text}</span>
    </div>
  );
}

export function makeDeclaredHitlScreenRenderer(card: DeclaredHitlCard): ComponentType<FieldRendererProps> {
  function DeclaredHitlScreenRenderer({ value, onChange, disabled, mode }: FieldRendererProps) {
    // The host hands the run value with the answer staged so far over it.
    const shown = asRecord(value);
    const idPrefix = useId();
    const editable = disabled !== true && mode !== "view";
    const stage = (change: Record<string, unknown>) => onChange(declaredHitlStage(card, shown, change));
    // STAGED ONCE, ON MOUNT: a field the run value prefilled is sent as shown,
    // and the Continue reads the same answer the card shows.
    useEffect(() => {
      if (editable) stage({});
      // Once per mount: later renders read the staged answer.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const readOnly = (s: Exclude<DeclaredHitlSection, { type: "note" } | { type: "field" }>, i: number) => {
      const text = textOf(shown, s.key);
      if (text.trim() === "") return null;
      if (s.type === "quote") return <ReadOnlyValue key={i} text={text} />;
      if (s.type === "words") return <ReadOnlyValue key={i} label={s.label} text={text} />;
      const qualifier = s.qualifierKey ? textOf(shown, s.qualifierKey).trim() : "";
      return <ReadOnlyValue key={i} label={qualifier ? `${s.label} (${qualifier})` : s.label} text={text} />;
    };

    // Consecutive read-only values form one facts group (V.1 `hitl-declared-facts`).
    const blocks: ReactNode[] = [];
    let facts: ReactNode[] = [];
    const closeFacts = () => {
      const drawn = facts.filter((f) => f !== null);
      if (drawn.length > 0) {
        blocks.push(
          <div key={`facts-${blocks.length}`} className="grid gap-2.5" data-conformance-id="hitl-declared-facts">
            {drawn}
          </div>,
        );
      }
      facts = [];
    };
    card.sections.forEach((s, i) => {
      if (s.type !== "note" && s.type !== "field") {
        facts.push(readOnly(s, i));
        return;
      }
      closeFacts();
      if (s.type === "note") {
        blocks.push(<p key={i} className="text-sm text-muted-foreground">{s.text}</p>);
        return;
      }
      const id = `${idPrefix}-field-${i}`;
      const control = {
        id,
        value: textOf(shown, s.key),
        placeholder: s.placeholder,
        disabled: !editable,
        onChange: (e: { target: { value: string } }) => stage({ [s.key]: e.target.value }),
      };
      blocks.push(
        <div key={i} className="grid gap-[3px]">
          <Label htmlFor={id}>{s.label}</Label>
          {s.multiline === true ? <Textarea {...control} /> : <Input type="text" {...control} />}
        </div>,
      );
    });
    closeFacts();
    return (
      <div className="flex min-w-0 flex-col gap-4" data-declared-hitl-screen="">
        {blocks}
      </div>
    );
  }
  DeclaredHitlScreenRenderer.displayName = "DeclaredHitlScreenRenderer";
  return DeclaredHitlScreenRenderer;
}

/** One entry per stored card, so a step keeps one component identity across renders. */
const CARD_ENTRIES = new Map<string, FieldRendererEntry>();

/**
 * WHICH RENDERER DRAWS A STEP, AND WHICH SUBMIT RULE APPLIES (cinatra#3470) —
 * the one decision every host asks first, before any older special case.
 *
 * (1) The step's schema carries the card it PAUSED WITH (`storedDeclaredCardOf`,
 *     written once when the pause was recorded): this returns the host's one
 *     generic card for it. The card draws the step and its rule alone governs
 *     readiness (`continueReady`), staging and the answer sent: no
 *     presentation-hint dispatch, no rule keyed on the id's suffix or on a kind
 *     (the list step, the grouped setup form, the context selector), and no
 *     approval-note lift. It needs no binding: a build that has since changed
 *     or dropped the renderer still draws the card the step asks with.
 * (2) Otherwise null (no card stored, or a stored value this host does not
 *     draw), and the host keeps today's order unchanged.
 */
export function declaredCardEntryOf(
  xRenderer: string | null | undefined,
  schema: unknown,
): FieldRendererEntry | null {
  if (!xRenderer) return null;
  const stored = storedDeclaredCardOf(schema, xRenderer);
  if (stored === null || stored === "invalid") return null;
  const key = `${xRenderer}\u0000${stored.digest}`;
  const known = CARD_ENTRIES.get(key);
  if (known) return known;
  const card = stored.card;
  const entry: FieldRendererEntry = {
    id: xRenderer,
    priority: 0,
    condition: () => false,
    renderer: makeDeclaredHitlScreenRenderer(card),
    // Pure host drawing: no server action, no registry lookup.
    credentialSafe: true,
    midRunHitl: true,
    continueReady: (staged) => declaredHitlCardReady(card, staged),
  };
  CARD_ENTRIES.set(key, entry);
  return entry;
}
