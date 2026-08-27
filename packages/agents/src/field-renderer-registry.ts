import type { ComponentType } from "react";
import type {
  FieldRendererProps,
  FieldRendererContext,
} from "@cinatra-ai/sdk-ui/field-renderer-props";

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
};

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
