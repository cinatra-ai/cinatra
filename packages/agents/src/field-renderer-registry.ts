import type { ComponentType } from "react";
import type {
  FieldRendererProps,
  FieldRendererContext,
} from "@cinatra-ai/sdk-ui/field-renderer-props";
import type { DeclaredHitlCard } from "./hitl-gate-submit";
import type { FieldRendererBindingInput } from "./register-default-renderers";

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

  /**
   * Remove exactly this entry object (cinatra#3470). An entry registered
   * since under the same id, by another source, stays.
   */
  unregisterEntry(entry: FieldRendererEntry): void {
    this.entries = this.entries.filter((e) => e !== entry);
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

// ---------------------------------------------------------------------------
// WHERE THE GATE'S RENDERER BINDING STANDS (cinatra#3470)
// ---------------------------------------------------------------------------

/**
 * Where a host's renderer bindings stand. `status` is `loading` until the
 * host's source of bindings answered, `loaded` once it did, and `failed` when
 * it could not. `announcedIds` names every binding the source said declares a
 * screen: one of them that is still not registered failed to register.
 */
export type RendererBindingsLoad = {
  status: "loading" | "loaded" | "failed";
  announcedIds: ReadonlySet<string>;
  /**
   * The ids whose declared screen the source refused. Each is held as a
   * screen that could not be loaded, even over a binding an earlier read
   * registered under the same id.
   */
  refusedIds?: ReadonlySet<string>;
  /**
   * The source's last answer could not read every installed agent: an id it
   * names nothing for may still declare a screen, so a gate with no binding
   * registered is held as could not be loaded, never read as no screen.
   */
  incomplete?: boolean;
  /**
   * The ids a FRESH read of the source answered for. A loaded answer may be a
   * scan cached before the gate's agent was installed, so an id it does not
   * announce reads as declaring nothing only once a fresh read answered for
   * it. `"every"`: the source reads each gate's own binding fresh (the
   * conversation card's read), so every id it answered for is.
   */
  freshlyReadIds: ReadonlySet<string> | "every";
};

/** Is a binding registered under exactly this id? */
export function isRendererBound(xRenderer: string): boolean {
  return fieldRendererRegistry.list().some((e) => e.id === xRenderer);
}

let runtimeBindingsLoad: RendererBindingsLoad = {
  status: "loading",
  announcedIds: new Set(),
  freshlyReadIds: new Set(),
  refusedIds: new Set(),
  incomplete: false,
};
const runtimeBindingsListeners = new Set<() => void>();

/**
 * The run page's runtime bindings (`useRuntimeFieldRendererBindings`): where
 * the fetch of the installed agents' bindings stands. It starts `loading`, so a
 * screen drawn before the fetch answered is never taken for one with no
 * binding. A later failure never undoes an earlier `loaded`.
 */
export function runtimeRendererBindingsLoad(): RendererBindingsLoad {
  return runtimeBindingsLoad;
}

/**
 * Record what the runtime bindings fetch answered. `freshFor` names the gate
 * ids a fresh read was asked for: its answer is theirs. A fresh read that
 * failed leaves each of them a screen that could not be loaded (held, never
 * read as declaring nothing).
 *
 * AN ANSWER IS THE WHOLE INSTALLED SET (cinatra#3470): what it announces and
 * refuses REPLACES what an earlier answer did, so a screen uninstalled or
 * refused since is no longer read as declared. A failed read changes neither.
 */
export function settleRuntimeRendererBindings(
  outcome:
    | {
        ok: true;
        screenIds: ReadonlyArray<string>;
        refusedIds?: ReadonlyArray<string>;
        incomplete?: boolean;
        freshFor?: ReadonlyArray<string>;
      }
    | { ok: false; freshFor?: ReadonlyArray<string> },
): void {
  const freshFor = outcome.freshFor ?? [];
  const announcedIds = outcome.ok
    ? new Set(outcome.screenIds)
    : new Set([...runtimeBindingsLoad.announcedIds, ...freshFor]);
  const read = runtimeBindingsLoad.freshlyReadIds;
  const freshlyReadIds =
    read === "every" || !outcome.ok ? read : new Set([...read, ...freshFor]);
  const status = outcome.ok || runtimeBindingsLoad.status === "loaded" ? "loaded" : "failed";
  const refusedIds = outcome.ok
    ? new Set(outcome.refusedIds ?? [])
    : (runtimeBindingsLoad.refusedIds ?? new Set<string>());
  const incomplete = outcome.ok
    ? outcome.incomplete === true
    : runtimeBindingsLoad.incomplete === true;
  // A gate whose fresh read failed may ask again once a later answer leaves it
  // unannounced (`requestFreshRendererBindingRead`).
  if (!outcome.ok) for (const id of freshFor) freshReadsAsked.delete(id);
  runtimeBindingsLoad = { status, announcedIds, freshlyReadIds, refusedIds, incomplete };
  for (const listener of runtimeBindingsListeners) listener();
}

/**
 * Does the gate drawn by `xRenderer` wait for a fresh read of its bindings
 * (cinatra#3470)? Only a gate with no binding registered, on an answer that
 * loaded, did not announce it, and was not read fresh for it.
 */
export function awaitsFreshRendererBindingRead(
  xRenderer: string,
  bindings: RendererBindingsLoad,
): boolean {
  if (xRenderer === "" || isRendererBound(xRenderer)) return false;
  if (bindings.status !== "loaded" || bindings.announcedIds.has(xRenderer)) return false;
  if (bindings.refusedIds?.has(xRenderer)) return false;
  const read = bindings.freshlyReadIds;
  return read !== "every" && !read.has(xRenderer);
}

// ---------------------------------------------------------------------------
// THE RUN PAGE'S READ OF THE INSTALLED AGENTS' BINDINGS (cinatra#151 Stage 5,
// cinatra#3470). One read registers what the server answered and records it
// (`settleRuntimeRendererBindings`). The page reads once on mount
// (`useRuntimeFieldRendererBindings`), and once more, FRESH, for a gate that
// answer does not name (`requestFreshRendererBindingRead`): the server caches
// its scan for a few seconds, and an agent installed within them is missing
// from it. Until that fresh read answered, the gate is held, never read as
// declaring no screen. Both imports stay lazy, as the mount read's always were.
// ---------------------------------------------------------------------------

/** The action module, imported on the first read and kept for every later one. */
let serverActionsModule: Promise<typeof import("./server-actions")> | null = null;
function serverActions(): Promise<typeof import("./server-actions")> {
  // A failed import is not kept: the next read imports again.
  serverActionsModule ??= import("./server-actions").catch((err: unknown) => {
    serverActionsModule = null;
    throw err;
  });
  return serverActionsModule;
}

/**
 * The entries THIS read road registered, by id (cinatra#3470). A runtime answer
 * is authoritative for exactly these: an id a complete answer no longer names,
 * or names as refused, is unregistered. Static and first-party registrations
 * (the generated bindings, the host's own entries, a conversation card's
 * registration) are never in it, so a runtime answer never touches them.
 */
const runtimeRegisteredEntries = new Map<string, FieldRendererEntry>();

/**
 * Make the registry hold what a runtime answer says (cinatra#3470). Every entry
 * this road registered before is dropped when the answer names its id again
 * (it is registered anew, or not at all when the registration refuses it),
 * names it refused, or, being complete, names it not at all. An incomplete
 * answer is no proof that an id is gone, so an entry it does not name stays.
 */
function reconcileRuntimeRegistrations(
  register: (bindings: ReadonlyArray<FieldRendererBindingInput>) => void,
  bindings: ReadonlyArray<FieldRendererBindingInput>,
  refusedIds: ReadonlyArray<string>,
  incomplete: boolean,
): void {
  const named = new Set(bindings.map((b) => b.id));
  const refused = new Set(refusedIds);
  for (const [id, entry] of runtimeRegisteredEntries) {
    if (named.has(id) || refused.has(id) || !incomplete) {
      fieldRendererRegistry.unregisterEntry(entry);
      runtimeRegisteredEntries.delete(id);
    }
  }
  if (bindings.length === 0) return;
  const entryOf = (id: string) => fieldRendererRegistry.list().find((e) => e.id === id);
  const before = new Map(bindings.map((b) => [b.id, entryOf(b.id)]));
  register(bindings);
  for (const b of bindings) {
    // Only an entry this registration made: one it refused leaves another
    // source's entry in place, and that entry is not this road's to remove.
    const entry = entryOf(b.id);
    if (entry !== undefined && entry !== before.get(b.id)) runtimeRegisteredEntries.set(b.id, entry);
  }
}

/**
 * Read the installed agents' bindings, register them and record the answer.
 * `freshFor` names a gate id the read is asked for: the server scans past its
 * cache, and the answer is recorded as that id's fresh read. True when the
 * read answered.
 */
export async function readRuntimeRendererBindings(freshFor?: string): Promise<boolean> {
  const readFor = freshFor === undefined ? undefined : [freshFor];
  try {
    const { getRuntimeFieldRendererBindingsAction } = await serverActions();
    const answer = await (freshFor === undefined
      ? getRuntimeFieldRendererBindingsAction()
      : getRuntimeFieldRendererBindingsAction({ fresh: true }));
    const bindings = answer?.bindings;
    const refusedScreenIds = answer?.refusedScreenIds;
    if (!Array.isArray(bindings) || !Array.isArray(refusedScreenIds)) {
      settleRuntimeRendererBindings({ ok: false, freshFor: readFor });
      return false;
    }
    const refusedIds = refusedScreenIds.filter((id): id is string => typeof id === "string");
    const incomplete = answer?.incomplete === true;
    if (bindings.length > 0 || runtimeRegisteredEntries.size > 0) {
      const { registerFieldRendererBindings } = await import(
        "./register-default-renderers"
      );
      reconcileRuntimeRegistrations(registerFieldRendererBindings, bindings, refusedIds, incomplete);
    }
    // The bindings that declare a screen, and the declared screens the
    // server's validator refused: one of them that is still unregistered
    // after this is a declared screen the host cannot draw, and its gate
    // stays held (never read as a gate with no screen). A refused id is held
    // even over a binding registered under it some other way.
    settleRuntimeRendererBindings({
      ok: true,
      screenIds: [
        ...bindings.filter((b) => b.screen !== undefined).map((b) => b.id),
        ...refusedIds,
      ],
      refusedIds,
      incomplete,
      freshFor: readFor,
    });
    return true;
  } catch {
    settleRuntimeRendererBindings({ ok: false, freshFor: readFor });
    return false;
  }
}

/** The gate ids this page has asked a fresh read for: each is asked once. */
const freshReadsAsked = new Set<string>();

/**
 * Ask for THE GATE'S FRESH READ (cinatra#3470), once per id, when the gate
 * drawn by `xRenderer` waits for one (`awaitsFreshRendererBindingRead`). A
 * host calls it from an effect. A read that fails leaves the gate held as a
 * screen that could not be loaded.
 */
export function requestFreshRendererBindingRead(xRenderer: string | null | undefined): void {
  if (typeof xRenderer !== "string") return;
  if (!awaitsFreshRendererBindingRead(xRenderer, runtimeBindingsLoad)) return;
  if (freshReadsAsked.has(xRenderer)) return;
  freshReadsAsked.add(xRenderer);
  void readRuntimeRendererBindings(xRenderer);
}

/**
 * Is `xRenderer` a MID-RUN binding of `kind` (cinatra#3470)? Read from the
 * registered entry alone, never the id: a declared card is never one.
 */
export function midRunBindingReadsAsKind(xRenderer: string, kind: string): boolean {
  const entry = fieldRendererRegistry.list().find((e) => e.id === xRenderer);
  return (
    entry?.midRunHitl === true &&
    entry.declaredScreen === undefined &&
    entry.stagesWholeAnswer !== true &&
    entry.kind === kind
  );
}

/** Subscribe to `runtimeRendererBindingsLoad` (for `useSyncExternalStore`). */
export function subscribeRuntimeRendererBindings(listener: () => void): () => void {
  runtimeBindingsListeners.add(listener);
  return () => {
    runtimeBindingsListeners.delete(listener);
  };
}
