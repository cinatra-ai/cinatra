// blog-pipeline-agent deterministic seam shapers.
//
// Dependency-light module (no `server-only`, no MCP/handler graph) so it is
// unit-testable in isolation — its ONE import is the dependency-free namespace
// leaf that owns the tombstoned-prefix set. `route.ts` imports the dispatcher
// and chains it ahead of the base `objects_save` shaper.
//
// The blog-pipeline-agent orchestrator bridges two OAS shape gaps via
// /api/agents/passthrough (mirrors the email-outreach context_setup
// string-gate -> passthrough -> typed-output pattern):
//   - `blog_pipeline_selected_idea`  : idea-array -> draft `idea` object
//   - `blog_pipeline_draft_projection`: draft object -> linkedin strings
// Each persists a thin transient record via objects_save (same infra as
// email's context_setup) and the route's `result_input_passthrough`
// echoes `rawData` (the typed output fields) into the OAS node outputs.

import { TOMBSTONED_OBJECT_TYPE_ID_PREFIXES } from "@cinatra-ai/objects/namespace";

export type BlogPipelineShaped = {
  typeHint: string;
  rawData: Record<string, unknown>;
};

/**
 * The two seam records' object types (cinatra#2960).
 *
 * These name the HOST-registered types the objects package declares
 * (`packages/objects/src/integration/register-types.ts`) — the same shape the
 * email-outreach `context_setup` seam uses with `@cinatra-ai/campaigns:context`.
 * They deliberately do NOT name a `@dynamic/types:*` id: that namespace is a
 * PERMANENT tombstone (`@cinatra-ai/objects/namespace`), so a save under it is
 * refused at the fail-closed write boundary and the pipeline could never
 * persist its selection.
 */
export const BLOG_PIPELINE_SELECTED_IDEA_TYPE_ID =
  "@cinatra-ai/blog-pipeline:selected-idea";
export const BLOG_PIPELINE_DRAFT_PROJECTION_TYPE_ID =
  "@cinatra-ai/blog-pipeline:draft-projection";

/**
 * The passthrough save path's DECLARED resolution rule for a shaped
 * `objects_save` type hint (cinatra#2960, AC2).
 *
 * `objects_save` persists only a type that an installed artifact extension
 * DECLARES (its `cinatra.artifact.objectTypes[]` manifest entry) or that a host
 * registrar registers. A `@dynamic/types:*` / `@cinatra-ai/dynamic:*` id names
 * NO definer — the namespaces are permanently tombstoned as write targets — so
 * a shaper that emits one can only ever produce the opaque
 * "no installed artifact extension defines ..." refusal one frame later. This
 * guard converts that into an immediate, self-explaining shaper throw (the
 * route surfaces a shaper throw as HTTP 400) that names what must define the
 * type instead.
 *
 * It stays NARROW on purpose: an ordinary namespaced id whose definer is simply
 * not installed passes through here and is still refused fail-closed by the
 * write boundary, which is the behaviour that must not regress.
 */
export function assertPassthroughSaveTypeHint(typeHint: string): void {
  const tombstoned = TOMBSTONED_OBJECT_TYPE_ID_PREFIXES.some((prefix) =>
    typeHint.startsWith(prefix),
  );
  if (!tombstoned) return;
  throw new Error(
    `objects_save passthrough: type hint ${JSON.stringify(typeHint)} is under a ` +
      "permanently retired dynamic namespace " +
      `(${TOMBSTONED_OBJECT_TYPE_ID_PREFIXES.join(", ")}) and can never be saved. ` +
      "A save must name a type an installed artifact extension declares in its " +
      "`cinatra.artifact.objectTypes[]` manifest entry, or a host-registered type " +
      "(packages/objects/src/integration/register-types.ts).",
  );
}

function resolveRunId(
  raw: Record<string, unknown>,
  agentRunId: string,
): string {
  if (typeof raw.cinatra_agent_run_id === "string") return raw.cinatra_agent_run_id;
  if (typeof raw.cinatra_run_id === "string") return raw.cinatra_run_id;
  return agentRunId;
}

/**
 * Returns the shaped `{typeHint, rawData}` for the two blog `_shape`s,
 * or `null` when `raw` is not a blog-pipeline shape (the caller falls
 * back to the base objects_save shaper).
 *
 * `blog_pipeline_selected_idea` FAILS CLOSED: when `selectedIdeaJson`
 * does not parse to a plain object, or does not match one of the offered
 * ideas (by title), it THROWS instead of silently defaulting to
 * `ideas[0]` / an empty idea — a silent default let a placeholder
 * `userResponse` flow into the draft writer and produce an empty draft.
 * The route surfaces the throw as an HTTP 400.
 */
export function shapeBlogPipelineObjectsSave(
  raw: Record<string, unknown>,
  agentRunId: string,
): BlogPipelineShaped | null {
  const runId = resolveRunId(raw, agentRunId);

  if (raw._shape === "blog_pipeline_selected_idea") {
    const selectedIdeaJson =
      typeof raw.selectedIdeaJson === "string" ? raw.selectedIdeaJson : "";
    const ideas = Array.isArray(raw.ideas)
      ? (raw.ideas as Array<Record<string, unknown>>)
      : [];
    let selected: Record<string, unknown> | null = null;
    if (selectedIdeaJson) {
      try {
        const p = JSON.parse(selectedIdeaJson) as Record<string, unknown>;
        if (p && typeof p === "object" && !Array.isArray(p)) selected = p;
      } catch {
        // selected stays null -> throw below (fail closed, no ideas[0] default)
      }
    }
    if (!selected || Object.keys(selected).length === 0) {
      throw new Error(
        "blog_pipeline_selected_idea: `selectedIdeaJson` is not a parseable BlogIdea object " +
          `(got ${JSON.stringify(selectedIdeaJson).slice(0, 200)}). ` +
          "Select one of the generated ideas at the idea-selection gate.",
      );
    }
    // Validate against the offered ideas (match by title) — the gate
    // contract is "pick one of these". Only enforceable when the offered
    // list arrived; with no offered list we accept the parsed object.
    const title = typeof selected.title === "string" ? selected.title : "";
    const matched = ideas.find(
      (i) => typeof i?.title === "string" && i.title === title,
    );
    if (ideas.length > 0 && !matched) {
      throw new Error(
        "blog_pipeline_selected_idea: selected idea " +
          `(title ${JSON.stringify(title).slice(0, 200)}) does not match any of the ` +
          `${ideas.length} offered ideas. Select one of the generated ideas at the idea-selection gate.`,
      );
    }
    return {
      typeHint: BLOG_PIPELINE_SELECTED_IDEA_TYPE_ID,
      rawData: { cinatra_agent_run_id: runId, idea: matched ?? selected },
    };
  }

  if (raw._shape === "blog_pipeline_draft_projection") {
    const draft =
      raw.draft && typeof raw.draft === "object" && !Array.isArray(raw.draft)
        ? (raw.draft as Record<string, unknown>)
        : {};
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    return {
      typeHint: BLOG_PIPELINE_DRAFT_PROJECTION_TYPE_ID,
      rawData: {
        cinatra_agent_run_id: runId,
        postTitle: str(draft.title),
        postExcerpt: str(draft.excerpt),
        blogPostContent: str(draft.content),
      },
    };
  }

  return null;
}
