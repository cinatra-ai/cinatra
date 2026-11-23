import type { ComponentType } from "react";
import type {
  FieldRendererProps,
  FieldRendererContext,
} from "@cinatra-ai/sdk-ui/field-renderer-props";
import type { DeclaredHitlCard } from "./hitl-gate-submit";

// ---------------------------------------------------------------------------
// Public props contract (cinatra#1625, epic #1620 S8 — M3)
// ---------------------------------------------------------------------------
//
// The normalized props every field renderer receives — `FieldRendererProps` and
// its `FieldRendererContext` / `RendererMode` / `GmailSendAsAliasOption`
// supporting types — now live in the design package as the stable PUBLIC MIRROR
// (`@cinatra-ai/sdk-ui/field-renderer-props`), so a claiming extension can import
// its renderer's props type through a first-party dep it is actually allowed to
// resolve (an extension may import ONLY `@cinatra-ai/sdk-extensions` +
// `@cinatra-ai/sdk-ui`; the host-internal `@cinatra-ai/agents` is not
// resolvable from an extension). This module RE-EXPORTS them verbatim so the
// in-core importers of `@cinatra-ai/agents` keep resolving unchanged — the SDK
// leaf is the single source of truth, this is the host mirror.
export type {
  FieldRendererProps,
  FieldRendererContext,
  RendererMode,
  GmailSendAsAliasOption,
} from "@cinatra-ai/sdk-ui/field-renderer-props";

// ---------------------------------------------------------------------------
// Namespace validation
// ---------------------------------------------------------------------------

/**
 * Validates that a renderer ID is in `@scope/package:local-id` format.
 * Exported so DB migrations can reuse the namespace validator.
 */
export const RENDERER_NAMESPACE_RE = /^@[\w-]+\/[\w-]+:[\w-]+$/;

export type FieldRendererCondition = (
  fieldName: string,
  schema: Record<string, unknown>,
  context: FieldRendererContext,
) => boolean;

export type FieldRendererEntry = {
  id: string;                                 // unique, e.g. "gmail-sender"
  priority: number;                           // higher priority wins on ties
  condition: FieldRendererCondition;
  renderer: ComponentType<FieldRendererProps>;
  /**
   * Manifest-declared mid-run HITL classification (cinatra#151 Stage 5).
   * `true` when the binding's `cinatra.fieldRenderers` entry sets
   * `midRunHitl: true` — the HITL panel surfaces consult this (via
   * orchestrator-mid-run-hitl.ts) to buffer values for an outer Continue
   * instead of submitting per interaction. Absent for host-internal entries
   * and bindings without the flag.
   */
  midRunHitl?: boolean;
  /**
   * MAY THIS RENDERER BE MOUNTED WHERE THE READER HAS NO COOKIE SESSION?
   * (cinatra#2930, lifecycle-b W3; convergence.)
   *
   * A lifecycle card can be drawn on a surface whose reader is proven by a
   * CREDENTIAL rather than by a session — the site widget, whose frame is
   * same-origin to the Cinatra app. The card's own requests carry that
   * credential with `credentials: "omit"`. A renderer mounted INSIDE the card
   * does not: one that calls its own `"use server"` action, or that resolves
   * further renderers out of this registry, reaches the server on whatever
   * ambient Cinatra cookie the browser happens to hold — which can belong to a
   * DIFFERENT person.
   *
   * ABSENT MEANS UNSAFE, deliberately, and that is the whole value of putting
   * the answer HERE rather than in a list of renderer ids. A wire id does not
   * determine which component is mounted: manifest bindings map an arbitrary id
   * (`@…/email-drafting-agent:output`) onto a host kind
   * (`email-drafts-review`), and an extension binding loads a component this
   * repository has never seen. Any predicate over the id is therefore guessing.
   * The flag travels with the ENTRY, so every binding of a kind inherits its
   * kind's answer and anything unrecognized stays unsafe by construction.
   *
   * A repository test (`hitl-screen-credential-safety.test.ts`) pins every
   * `true` against the component's own source.
   */
  credentialSafe?: boolean;
  /**
   * DOES THE COMPONENT THIS ENTRY MOUNTS DRAW A SUBMIT CONTROL OF ITS OWN?
   * (cinatra#3532.)
   *
   * `true` is a DECLARATION, read off the component's own source: this entry's
   * renderer draws the control that passes the field, so a setup surface leaves
   * the send to it and draws none of its own — which is what the run page has
   * always done for the schema floor and for the grouped setup form.
   *
   * ABSENT MEANS THE ENTRY DECLARES NONE, and the setup surfaces read it that
   * way: the product's own Continue is drawn beside the field and the renderer
   * is told through the shared props contract (`hideSubmit`) not to draw one,
   * so there is exactly one control. That is already what every conversation
   * host does for every setup renderer (`cardOwnsTheSetupSend`); the reason it
   * cannot default the other way is the failure that opened #3532 — a pack's
   * field renderer that draws no control left the Run wizard with no way to
   * pass the field at all, and "nothing is declared" must never be the reason a
   * person cannot go on.
   *
   * It travels with the ENTRY, never with a predicate over the id, for the same
   * reason `credentialSafe` does: a binding id says nothing about which
   * component is mounted.
   */
  drawsOwnSubmit?: boolean;
  /**
   * MAY THE HOST'S CONTINUE SEND YET? (cinatra#3470.)
   *
   * Asked by every mid-run Continue with the gate's run value and the answer
   * staged so far. `false` holds the Continue (drawn, disabled). ABSENT MEANS
   * NO HOLD: every entry that does not declare one continues as before. A
   * declared HITL card sets it, so its Continue waits for an explicit choice
   * and for every required value.
   */
  continueReady?: (input: {
    runValue: Record<string, unknown>;
    staged: Record<string, unknown>;
  }) => boolean;
  /**
   * EACH onChange IS THE WHOLE STAGED ANSWER (cinatra#3470).
   *
   * A mid-run host REPLACES its buffer with what this renderer stages instead
   * of merging it into the buffer before (`stageRendererAnswer`). ABSENT MEANS
   * MERGE, as every other renderer stages. A declared HITL card sets it: its
   * answers may have different keys, and a merge would send a choice together
   * with the keys of a choice made before it.
   */
  stagesWholeAnswer?: boolean;
  /** cinatra#3035: this kind's component commits a pick as `userResponse`, and a gate drawn by it holds the card's Continue until a pick is made. */
  holdsContinueUntilPicked?: boolean;
  /**
   * THE BINDING'S DECLARED KIND (cinatra#3470), as its manifest names it.
   * What the gate's answer needs (the list step's pick snapshot) is read from
   * it, never from the id: an id is free text. ABSENT for host-internal
   * entries, which keep the id-suffix reading (`isListPickerRenderer`).
   */
  kind?: string;
  /**
   * THE DECLARED HITL CARD this entry draws (cinatra#3470). Every road that
   * writes the gate's staged answer reads it (`declaredHitlStage`), and every
   * reading of the gate's id checks it before the id's suffix
   * (`rendererReadsAsKind`). ABSENT for every other entry.
   */
  declaredScreen?: DeclaredHitlCard;
};

/**
 * What a host holds for a renderer that stages its whole answer
 * (`stagesWholeAnswer`, cinatra#3470): the gate's ORIGINAL run values and the
 * answer staged so far, apart. The renderer derives everything it shows from
 * these two, so what is shown, what holds the Continue and what is sent are
 * one reading. `value` alone cannot carry it: it is the two merged.
 */
export type HitlStageSplit = {
  runValue: Record<string, unknown>;
  staged: Record<string, unknown>;
};

/** The props a host adds for a whole-answer renderer; none for any other. */
export function wholeAnswerStageProps(
  entry: FieldRendererEntry | null | undefined,
  runValue: Record<string, unknown> | null | undefined,
  staged: Record<string, unknown>,
): { hitlStage?: HitlStageSplit } {
  return entry?.stagesWholeAnswer === true ? { hitlStage: { runValue: runValue ?? {}, staged } } : {};
}

class FieldRendererRegistryImpl {
  private entries: FieldRendererEntry[] = [];

  register(entry: FieldRendererEntry): void {
    // Warn in development when the ID is not in @scope/package:local-id format.
    if (process.env.NODE_ENV !== "production" && !RENDERER_NAMESPACE_RE.test(entry.id)) {
      console.warn(
        `Field renderer ID '${entry.id}' is not namespaced. Use '@scope/package:local-id' format.`,
      );
    }
    // Idempotent: replace-by-id so ensureDefaultFieldRenderersRegistered()
    // can be called multiple times safely (hot reload, multiple entry points).
    this.entries = this.entries.filter((e) => e.id !== entry.id);
    this.entries.push(entry);
    this.entries.sort((a, b) => b.priority - a.priority);
  }

  resolve(
    fieldName: string,
    schema: Record<string, unknown>,
    context: FieldRendererContext,
  ): FieldRendererEntry | null {
    for (const entry of this.entries) {
      if (entry.condition(fieldName, schema, context)) return entry;
    }
    return null;
  }

  list(): readonly FieldRendererEntry[] {
    return this.entries;
  }

  clear(): void {
    this.entries = [];
  }
}

export const fieldRendererRegistry = new FieldRendererRegistryImpl();

/**
 * Is `xRenderer` a list step (cinatra#3470)? The registered binding's
 * DECLARED kind decides, so `{ kind: "list-picker", id: "@scope/pkg:pick-list" }`
 * is one. A declared card is drawn by the host's card whatever its kind, so it
 * is never one. Only an id with no registered kind falls back to the
 * `:list-picker` suffix.
 */
export function isListPickerRenderer(xRenderer: string): boolean {
  return rendererReadsAsKind(xRenderer, "list-picker", ":list-picker");
}

/**
 * The declared HITL card registered under EXACTLY this id (cinatra#3470), or
 * undefined. A binding that declares its card is that card whatever its id
 * says.
 */
export function declaredHitlCardOf(xRenderer: string): DeclaredHitlCard | undefined {
  return fieldRendererRegistry.list().find((e) => e.id === xRenderer)?.declaredScreen;
}

/**
 * Does `xRenderer` read as a renderer of `kind` (cinatra#3470)? The registered
 * binding decides first: a declared card is never one (it is the host's card
 * whatever its suffix, never a setup form, list step or grouped setup), and a
 * binding with a declared kind is one exactly when that kind is `kind`. Only an
 * id with no registered kind falls back to its `suffix`: an id is free text.
 */
export function rendererReadsAsKind(xRenderer: string, kind: string, suffix: string): boolean {
  const entry = fieldRendererRegistry.list().find((e) => e.id === xRenderer);
  if (entry?.declaredScreen !== undefined || entry?.stagesWholeAnswer === true) return false;
  if (entry?.kind !== undefined) return entry.kind === kind;
  return xRenderer.endsWith(suffix);
}

/** Whether a gate's Continue still waits for a pick: its entry declares the hold and the buffered `userResponse` is not a non-empty string (cinatra#3035). */
export function continueAwaitsAPick(
  entry: FieldRendererEntry | null | undefined,
  buffered: Record<string, unknown>,
): boolean {
  if (entry?.holdsContinueUntilPicked !== true) return false;
  const pick = buffered.userResponse;
  return !(typeof pick === "string" && pick.length > 0);
}
