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
  /** The decision's declared label, drawn above its answer rows. */
  decisionLabel?: string;
  decisions?: { label: string; answer: Record<string, unknown> }[];
  carry?: string[];
  requires?: string[];
};

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

function fieldKeysOf(screen: Pick<DeclaredHitlCard, "sections">): string[] {
  return (screen.sections ?? []).flatMap((s) => (s.type === "field" ? [s.key] : []));
}

/**
 * The text a field shows: the staged text once the field is staged, the run
 * value's (a prefill) while it is not.
 */
export function declaredHitlFieldText(
  runValue: Record<string, unknown>,
  staged: Record<string, unknown>,
  key: string,
): string {
  return Object.hasOwn(staged, key) ? textOf(staged, key) : textOf(runValue, key);
}

/**
 * The chosen row: the index of the decision whose answer is EXACTLY the
 * staged answer's own keys (every staged key except the carried ones and
 * `userResponse`), or null. The run value never chooses for the person.
 */
export function declaredHitlChosenDecision(
  screen: Pick<DeclaredHitlCard, "decisions" | "carry">,
  staged: Record<string, unknown>,
): number | null {
  const carried = new Set(screen.carry ?? []);
  const own = Object.keys(staged).filter((k) => k !== "userResponse" && !carried.has(k));
  const i = (screen.decisions ?? []).findIndex((d) => {
    const keys = Object.keys(d.answer);
    return (
      keys.length === own.length &&
      keys.every((k) => Object.hasOwn(staged, k) && Object.is(staged[k], d.answer[k]))
    );
  });
  return i === -1 ? null : i;
}

/** Every `requires` key that is not a field holds non-blank run-value text. */
function requiredRunValuesHeld(screen: DeclaredHitlCard, runValue: Record<string, unknown>): boolean {
  const fieldKeys = new Set(fieldKeysOf(screen));
  return (screen.requires ?? []).every((k) => fieldKeys.has(k) || textOf(runValue, k).trim() !== "");
}

/**
 * May the host's Continue send this card's answer yet? It reads what the
 * Continue SENDS (the staged answer), never only what is drawn:
 *
 *   - every `requires` key that is a run value holds non-blank text;
 *   - every field holds non-blank STAGED text: a declared field is a required
 *     value, and a prefill counts once it is staged (the card stages it on
 *     mount);
 *   - a card with decisions has one chosen (`declaredHitlChosenDecision`).
 *     Nothing is chosen for the person, not even by the run value.
 */
export function declaredHitlScreenReady(
  screen: DeclaredHitlCard,
  runValue: Record<string, unknown>,
  staged: Record<string, unknown>,
): boolean {
  if (!requiredRunValuesHeld(screen, runValue)) return false;
  for (const k of fieldKeysOf(screen)) {
    if (textOf(staged, k).trim() === "") return false;
  }
  if ((screen.decisions ?? []).length === 0) return true;
  return declaredHitlChosenDecision(screen, staged) !== null;
}

/**
 * The whole answer a declared card stages (cinatra#3470): the carried run
 * values (own keys only, from the gate's ORIGINAL run values, never from a
 * staged answer), then `answer` (every field's text, or the chosen declared
 * answer), and `userResponse`, the JSON of exactly those keys. The server
 * resumes the agent with `userResponse` and records the parsed JSON, so what
 * the agent reads and what is recorded are this one answer.
 */
export function declaredHitlStagedAnswer(
  screen: Pick<DeclaredHitlCard, "carry">,
  runValue: Record<string, unknown>,
  answer: Record<string, unknown>,
): Record<string, unknown> {
  const whole: Record<string, unknown> = {
    ...Object.fromEntries(
      (screen.carry ?? []).filter((k) => Object.hasOwn(runValue, k)).map((k) => [k, runValue[k]]),
    ),
    ...answer,
  };
  return { ...whole, userResponse: JSON.stringify(whole) };
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
    const fieldKeys = fieldKeysOf(screen);
    // A choice waits for the run values it requires. A field is never locked
    // by them: its own key may be required, and the person must type it.
    const choicesLocked = disabled === true || !requiredRunValuesHeld(screen, runValue);
    // Every stage is the whole answer (`declaredHitlStagedAnswer`), its
    // carried keys from the ORIGINAL run values.
    const stage = (answer: Record<string, unknown>) =>
      onChange(declaredHitlStagedAnswer(screen, runValue, answer));
    const fieldsAsShown = () =>
      Object.fromEntries(fieldKeys.map((k) => [k, declaredHitlFieldText(runValue, staged, k)]));
    // A PREFILL IS STAGED ONCE, ON MOUNT: with nothing staged yet and a field
    // prefilled by the run value, the answer as shown is staged, so an
    // untouched prefill is what the Continue sends and what makes it ready.
    const prefilled =
      hitlStage !== undefined &&
      disabled !== true &&
      Object.keys(staged).length === 0 &&
      fieldKeys.some((k) => textOf(runValue, k) !== "");
    useEffect(() => {
      if (prefilled) stage(fieldsAsShown());
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
        const write = (text: string) => stage({ ...fieldsAsShown(), [s.key]: text });
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
