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
// decline as a decline. That Continue is held (`declaredHitlScreenReady`)
// until a declared choice is made and every required value holds text.
//
// What a stage holds (`declaredHitlStagedAnswer`): the WHOLE answer, every
// time. That is the carried run values, then every field's text or the one
// chosen answer, and `userResponse`, the JSON of exactly that answer. The
// running agent reads `userResponse` as its resume text, so a field's text or
// a choice reaches it, not only the approval flag. The entry declares
// `stagesWholeAnswer`, so every host replaces its buffer with each stage and
// never merges it into the one before: a choice made after another one sends
// only its own answer.
//
// Drawing (app-lifecycle-cards V.1, design#243): the card draws no frame of
// its own. The host draws the frame where V.1 asks for one (the chat thread
// and the site widget), and the run card and the page gate region place the
// same fields in their own detail region with no second outer box. Every
// declared label takes the small uppercase mono label (V.1 `nf-label`) on
// every host. A read-only value (a fact, the words that go out) is its
// declared label over the value as text, with no box, and is never a link.
// A field is the borderless input on a dashed hairline (V.1 `nf-input`). A
// decision is its declared label over one answer row per declared answer (a
// radio and the declared answer label), never a row of buttons, and the
// chosen row is marked.
//
// ONE SOURCE OF TRUTH: the card keeps no state of its own. Everything it
// shows, everything that holds the Continue and everything it stages is
// derived from two things the host holds (`HitlStageSplit`): the gate's
// ORIGINAL run values and the answer staged so far. The chosen row is the
// decision whose answer is exactly the staged answer's own keys; a field shows
// its staged text, or the run value's while nothing is staged; carried keys
// always come from the run values. A card whose fields arrive prefilled stages
// that prefill once on mount, so an untouched prefill is sent as shown. A
// remount (the conversation moving the card) therefore shows the same choice
// the host will send.

import { useEffect, useId, type ComponentType, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import type { FieldRendererProps, HitlStageSplit } from "./field-renderer-registry";
import {
  declaredHitlChosenDecision,
  declaredHitlFieldKeys,
  declaredHitlFieldText,
  declaredHitlRequiredRunValuesHeld,
  declaredHitlScreenReady,
  declaredHitlStage,
  declaredHitlStagedAnswer,
  type DeclaredHitlCard,
  type DeclaredHitlSection,
} from "./hitl-gate-submit";

type Section = DeclaredHitlSection;
export type { DeclaredHitlCard };
export { declaredHitlScreenReady, declaredHitlStagedAnswer, declaredHitlChosenDecision, declaredHitlFieldText };

/** The run value's OWN text under `key`; anything else reads as blank. */
function textOf(v: Record<string, unknown>, key: string): string {
  const x = Object.hasOwn(v, key) ? v[key] : undefined;
  return typeof x === "string" ? x : "";
}

/** V.1 `nf-label`: the small uppercase mono label on the muted ink. */
export const DECLARED_LABEL_CLASS = "font-mono text-badge-2xs uppercase text-muted-foreground";

/** V.1 `nf-input`: no box, no fill, a dashed hairline under the text. */
export const DECLARED_INPUT_CLASS =
  "h-auto rounded-none border-0 border-b border-dashed border-line bg-transparent px-0 pt-[5px] pb-[7px] text-xs md:text-xs text-muted-foreground shadow-none focus-visible:border-solid focus-visible:border-line focus-visible:ring-0 disabled:bg-transparent dark:bg-transparent dark:disabled:bg-transparent";

/** A read-only value: its declared label over the value as text, no box. */
function ReadOnlyValue({ label, text }: { label?: string; text: string }) {
  return (
    <div className="grid gap-[3px]">
      {label ? <span className={DECLARED_LABEL_CLASS}>{label}</span> : null}
      <span className="whitespace-pre-wrap text-xs leading-normal text-foreground">{text}</span>
    </div>
  );
}

function asRecord(x: unknown): Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
}

export function makeDeclaredHitlScreenRenderer(
  screen: DeclaredHitlCard,
): ComponentType<FieldRendererProps> {
  function DeclaredHitlScreenRenderer({
    value,
    onChange,
    disabled,
    hitlStage,
  }: FieldRendererProps & { hitlStage?: HitlStageSplit }) {
    // The two readings everything below derives from. A host that hands no
    // split (the read-only replay of a sent answer) shows its value as both:
    // there the value IS the answer that was sent.
    const runValue = hitlStage ? asRecord(hitlStage.runValue) : asRecord(value);
    const staged = hitlStage ? asRecord(hitlStage.staged) : asRecord(value);
    const idPrefix = useId();
    const fieldKeys = declaredHitlFieldKeys(screen);
    // A choice waits for the run values it requires. A field is never locked
    // by them: its own key may be required, and the person must type it.
    const choicesLocked = disabled === true || !declaredHitlRequiredRunValuesHeld(screen, runValue);
    // Every stage goes through THE ONE WRITER of a declared card's answer
    // (`declaredHitlStage`), as the assistant's fill and the server's do: the
    // whole answer, `userResponse` included, from the run values, what is
    // staged and this change.
    const stage = (change: Record<string, unknown>) =>
      onChange(declaredHitlStage(screen, runValue, staged, change));
    // STAGED ONCE, ON MOUNT: with nothing staged yet, a card whose answer is
    // already whole without a choice stages it as shown, so it is what the
    // Continue sends and what makes it ready: a field prefilled by the run
    // value, and a card with no controls, whose answer is its carried values.
    const decisionCount = (screen.decisions ?? []).length;
    const wholeOnMount =
      hitlStage !== undefined &&
      disabled !== true &&
      Object.keys(staged).length === 0 &&
      (fieldKeys.some((k) => textOf(runValue, k) !== "") || (fieldKeys.length === 0 && decisionCount === 0));
    useEffect(() => {
      if (wholeOnMount) stage({});
      // Once per mount: a later render reads the staged answer.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const picked = declaredHitlChosenDecision(screen, staged);

    const section = (s: Section, i: number): ReactNode => {
      if (s.type === "note") {
        return <p key={i} className="text-sm text-muted-foreground">{s.text}</p>;
      }
      if (s.type === "field") {
        const id = `${idPrefix}-field-${i}`;
        const control = {
          id,
          value: declaredHitlFieldText(runValue, staged, s.key),
          placeholder: s.placeholder,
          disabled: disabled === true,
          className: DECLARED_INPUT_CLASS,
        };
        // The whole answer: every field as drawn, this one as typed.
        const write = (text: string) => stage({ [s.key]: text });
        return (
          <div key={i} className="grid gap-[3px]">
            <label htmlFor={id} className={DECLARED_LABEL_CLASS}>
              {s.label}
            </label>
            {s.multiline === true ? (
              <Textarea {...control} onChange={(e) => write(e.target.value)} />
            ) : (
              <Input {...control} onChange={(e) => write(e.target.value)} />
            )}
          </div>
        );
      }
      const text = textOf(runValue, s.key);
      if (text.trim() === "") return null;
      if (s.type === "quote") {
        return <p key={i} className="whitespace-pre-wrap text-sm text-muted-foreground">{text}</p>;
      }
      if (s.type === "words") {
        // The words that go out are read-only: label over text, with no box.
        return <ReadOnlyValue key={i} label={s.label} text={text} />;
      }
      // A fact: the declared label over the value as text, with no box. A
      // value is text, never a link (V.1: "a fact is text").
      const qualifier = s.qualifierKey ? textOf(runValue, s.qualifierKey).trim() : "";
      return (
        <ReadOnlyValue key={i} label={qualifier ? `${s.label} (${qualifier})` : s.label} text={text} />
      );
    };

    const decisions = screen.decisions ?? [];
    const decisionLabelId = `${idPrefix}-decision`;
    // The decision: its declared label over one answer row per declared
    // answer, in the fields region.
    const answers =
      decisions.length > 0 ? (
        <div className="grid gap-1.5" data-conformance-id="hitl-declared-decision">
          {screen.decisionLabel ? (
            <span id={decisionLabelId} className={DECLARED_LABEL_CLASS}>
              {screen.decisionLabel}
            </span>
          ) : null}
          <RadioGroup
            className="grid gap-2"
            aria-labelledby={screen.decisionLabel ? decisionLabelId : undefined}
            value={picked === null ? "" : String(picked)}
            disabled={choicesLocked}
            onValueChange={(chosen) => {
              const i = Number(chosen);
              const d = decisions[i];
              if (!Number.isInteger(i) || d === undefined) return;
              stage({ ...d.answer });
            }}
          >
            {decisions.map((d, i) => {
              const id = `${idPrefix}-answer-${i}`;
              const chosen = picked === i;
              return (
                <label
                  key={i}
                  htmlFor={id}
                  className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 ${
                    chosen ? "border-primary bg-primary/5" : "border-line bg-surface-strong"
                  } ${choicesLocked ? "" : "cursor-pointer"}`}
                >
                  <RadioGroupItem id={id} value={String(i)} className="mt-0.5" />
                  <span className="font-sans text-row-title font-bold text-foreground">{d.label}</span>
                </label>
              );
            })}
          </RadioGroup>
        </div>
      ) : null;
    // No frame of its own: the host's card frame (conversation hosts) or the
    // host's detail region (run card, page gate region) holds these fields.
    return (
      <div className="flex min-w-0 flex-col gap-4" data-declared-hitl-screen="">
        <p className="text-sm font-semibold text-foreground">{screen.title}</p>
        {(screen.sections ?? []).map(section)}
        {answers}
      </div>
    );
  }
  DeclaredHitlScreenRenderer.displayName = "DeclaredHitlScreenRenderer";
  return DeclaredHitlScreenRenderer;
}
