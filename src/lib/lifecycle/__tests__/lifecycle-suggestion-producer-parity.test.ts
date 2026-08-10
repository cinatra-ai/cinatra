/**
 * cinatra#2570 (epic #2564 S6a) — THE PARITY FIXTURE.
 *
 * The issue's cutover condition: the legacy `/api/auditor/run-skills` write path
 * retires only once the new producer covers the output classes that pipeline's
 * consumer ACCEPTED. "Accepted" is not a matter of opinion — it is two concrete
 * artifacts that both still exist:
 *
 *   `SuggestionPatchSchema` — the zod shape the legacy route validated its LLM's
 *      structured output against before persisting anything.
 *   `applyAuditorPatches`   — the deterministic RFC 6902-subset transform that
 *      turned an accepted patch into an actual document change.
 *
 * So parity is provable rather than asserted: run the new producer, feed its
 * output to BOTH, and show that every op class round-trips. If a future rule
 * emits something the old consumer would have rejected, this fixture fails.
 *
 * It also proves the reviewer-facing PREVIEW projection the legacy route built
 * (`{id, fieldPath, op, message}`, deliberately without `value`) is still
 * buildable — nothing the old surface showed is lost by the migration.
 *
 * Run: pnpm exec vitest run src/lib/lifecycle/__tests__/lifecycle-suggestion-producer-parity.test.ts
 */
import { describe, it, expect } from "vitest";

import { buildGateSuggestions } from "../lifecycle-suggestion-producer";
import {
  applyAuditorPatches,
  SuggestionPatchSchema,
  type SuggestionPatch,
} from "@cinatra-ai/agents/auditor-apply";

const TARGET = { artifactId: "art-parity", representationRevisionId: "rev-parity" };

/**
 * The projection convention every lifecycle projector uses (`flattenToFieldMap`
 * in `lifecycle-verification-store`): dotted paths, array members by index,
 * string leaves. Mirrored here rather than imported because that module is
 * server-only and would drag the DB layer into a pure fixture.
 */
function flatten(value: unknown, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (v: unknown, path: string) => {
    if (v === null || v === undefined) {
      if (path) out[path] = "";
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, path ? `${path}.${i}` : String(i)));
      return;
    }
    if (typeof v === "object") {
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
        walk(child, path ? `${path}.${k}` : k);
      }
      return;
    }
    out[path] = typeof v === "string" ? v : JSON.stringify(v);
  };
  walk(value, prefix);
  return out;
}

/** The fixture document: one field needing normalization, one list member
 * missing a key its sibling carries, one entirely empty list member. */
function fixtureDocument() {
  return {
    lead: "  A headline with slack  ",
    items: [
      { title: "First", subtitle: "with a subtitle" },
      { title: "Second" },
      { title: "   ", subtitle: "" },
    ],
  };
}

function produce(doc: unknown) {
  return buildGateSuggestions({
    target: TARGET,
    projection: { includedFields: flatten(doc), excludedFields: [] },
    authzDecision: "authorized",
  });
}

describe("parity with the retired pipeline's accepted output classes", () => {
  it("every produced suggestion validates against the LEGACY patch schema", () => {
    const { suggestions } = produce(fixtureDocument());
    expect(suggestions.length).toBeGreaterThan(0);
    for (const s of suggestions) {
      expect(() => SuggestionPatchSchema.parse(s)).not.toThrow();
    }
  });

  it("covers ALL THREE accepted op classes", () => {
    const { suggestions } = produce(fixtureDocument());
    expect(new Set(suggestions.map((s) => s.op))).toEqual(
      new Set(["replace", "add", "remove"]),
    );
  });

  it("applies cleanly through the LEGACY transform, in the order produced", () => {
    const doc = fixtureDocument();
    const { suggestions } = produce(doc);
    const patches = suggestions.map((s) => SuggestionPatchSchema.parse(s) as SuggestionPatch);
    const applied = applyAuditorPatches(
      doc,
      patches,
      patches.map((p) => p.id),
    );
    expect(applied).toEqual({
      lead: "A headline with slack",
      items: [
        { title: "First", subtitle: "with a subtitle" },
        { title: "Second", subtitle: "" },
      ],
    });
  });

  it("a PARTIAL acceptance applies exactly the accepted ids and nothing else", () => {
    const doc = fixtureDocument();
    const { suggestions } = produce(doc);
    const patches = suggestions.map((s) => SuggestionPatchSchema.parse(s) as SuggestionPatch);
    const onlyReplace = patches.filter((p) => p.op === "replace");
    const applied = applyAuditorPatches(
      doc,
      patches,
      onlyReplace.map((p) => p.id),
    ) as ReturnType<typeof fixtureDocument>;
    expect(applied.lead).toBe("A headline with slack");
    expect(applied.items).toHaveLength(3); // nothing removed
  });

  it("reaches a fixpoint through the REAL transform — a second pass proposes nothing", () => {
    const doc = fixtureDocument();
    const first = produce(doc);
    const patches = first.suggestions.map(
      (s) => SuggestionPatchSchema.parse(s) as SuggestionPatch,
    );
    const applied = applyAuditorPatches(
      doc,
      patches,
      patches.map((p) => p.id),
    );
    expect(produce(applied).suggestions).toEqual([]);
  });

  it("still builds the reviewer-facing preview projection the old route surfaced", () => {
    const { suggestions } = produce(fixtureDocument());
    // The legacy `preview.patches` view: no `value` on the wire — the accepted
    // value is sourced from the snapshot, never from the client.
    const preview = suggestions.map((s) => ({
      id: s.id,
      fieldPath: s.fieldPath,
      op: s.op,
      message: s.message ?? "",
    }));
    expect(preview.every((p) => p.id !== "" && p.fieldPath.startsWith("/"))).toBe(true);
    expect(preview.every((p) => p.message !== "")).toBe(true);
    expect(preview.every((p) => !("value" in p))).toBe(true);
  });

  it("emits stable ids, so a re-run over an unchanged document is the same set", () => {
    const a = produce(fixtureDocument()).suggestions.map((s) => s.id);
    const b = produce(fixtureDocument()).suggestions.map((s) => s.id);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length); // and no duplicate ids
  });
});
