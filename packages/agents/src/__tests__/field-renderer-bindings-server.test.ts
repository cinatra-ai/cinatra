// Installed-package binding collector (cinatra#151 Stage 5 — SOURCE B) pins.
//
// The collector enumerates <agentInstallDir>/<scope>/<name>/package.json,
// applies the SHARED validator skip-warn, merges with first-declarer-wins,
// and feeds: the runtime server action, the A2UI translator resolver, and
// kind-based ID lookups. Fixture-driven — no real DB (agent-install-path is
// mocked to a temp tree).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let FIXTURE_DIR = "";

vi.mock("../agent-runtime-mount", () => ({
  resolveAgentRuntimeMountDir: () => {
    if (!FIXTURE_DIR) throw new Error("fixture dir unset");
    return FIXTURE_DIR;
  },
}));

// The run's current gate and the acting user's sending accounts, for the one
// answer guard (`currentParkedHitlStepRefusal`).
const guardReads = vi.hoisted(() => ({
  currentGate: vi.fn<(runId: string) => Promise<unknown>>(async () => null),
  senders: vi.fn<(userId?: string) => Promise<unknown[]>>(async () => []),
}));
vi.mock("../agent-run-hitl-prompts", () => ({ readCurrentDurableHitlGate: guardReads.currentGate }));
vi.mock("@/lib/register-host-connector-services", () => ({}));
vi.mock("@/lib/email-sender-identities", () => ({ listEmailSenderIdentities: guardReads.senders }));

import {
  collectInstalledFieldRendererBindings,
  getMergedFieldRendererBindings,
  resolveRendererIdForKind,
  buildA2UiMidRunTranslatorResolver,
  serverHitlRendererClaim,
  parkedHitlStepIsAnswerableOnServer,
  parkedHitlStepRefusalOnServer,
  currentParkedHitlStepRefusal,
  __clearInstalledFieldRendererBindingsCache,
} from "../field-renderer-bindings.server";
import {
  FIELD_RENDERER_KIND_CONTEXT_CONDITIONS,
  parkedHitlStepIsAnswerable,
  resolveHitlGateRenderer,
} from "../orchestrator-mid-run-hitl";
import {
  ARTIFACT_REVIEW_REDIRECT_RENDERER_ID,
  GROUPED_SETUP_FORM_RENDERER_ID,
  PERSONAL_SKILL_RENDERER_ID,
  SCHEMA_FIELD_FALLBACK_RENDERER_ID,
  SKILL_SELECTOR_RENDERER_ID,
} from "../agent-builder-ids";
import { fieldRendererRegistry } from "../field-renderer-registry";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";
import { GENERATED_FIELD_RENDERER_BINDINGS } from "@/lib/generated/agent-bindings";
import { A2UI_MID_RUN_TRANSLATOR_KINDS } from "@cinatra-ai/agent-ui-protocol/server";

function writePkg(scope: string, name: string, pkg: Record<string, unknown>) {
  const dir = join(FIXTURE_DIR, scope, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
}

beforeEach(() => {
  FIXTURE_DIR = mkdtempSync(join(tmpdir(), "frb-fixture-"));
  __clearInstalledFieldRendererBindingsCache();
});

afterEach(() => {
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
  FIXTURE_DIR = "";
  __clearInstalledFieldRendererBindingsCache();
});

describe("collectInstalledFieldRendererBindings", () => {
  it("collects validated declarations from materialized packages", () => {
    writePkg("custom-scope", "future-agent", {
      name: "@custom-scope/future-agent",
      cinatra: {
        fieldRenderers: [
          { id: "@custom-scope/future-agent:gate", kind: "cta", priority: 70 },
        ],
      },
    });
    const entries = collectInstalledFieldRendererBindings();
    expect(entries).toEqual([
      {
        id: "@custom-scope/future-agent:gate",
        kind: "cta",
        priority: 70,
        declaredBy: "@custom-scope/future-agent",
      },
    ]);
  });

  it("SKIP-WARNs invalid runtime declarations (hostile data cannot break the host)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writePkg("s", "bad-agent", {
      name: "@s/bad-agent",
      cinatra: {
        fieldRenderers: [
          { id: "not-namespaced", kind: "cta", priority: 70 },
          { id: "@s/bad-agent:ok", kind: "no-such-kind", priority: 70 },
          { id: "@s/bad-agent:fine", kind: "cta", priority: 70 },
        ],
      },
    });
    const entries = collectInstalledFieldRendererBindings();
    expect(entries.map((e) => e.id)).toEqual(["@s/bad-agent:fine"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("returns [] when the install dir is unreadable (normal degraded state)", () => {
    rmSync(FIXTURE_DIR, { recursive: true, force: true });
    expect(collectInstalledFieldRendererBindings()).toEqual([]);
  });

  it("first-declarer-wins among DIVERGENT runtime duplicates is ALPHABETICAL (sorted traversal), never filesystem-order", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Write the alphabetically-LATER package first so insertion order would
    // pick the wrong winner if traversal were unsorted.
    writePkg("s", "zz-agent", {
      name: "@s/zz-agent",
      cinatra: { fieldRenderers: [{ id: "@s/shared:gate", kind: "cta", priority: 10 }] },
    });
    writePkg("s", "aa-agent", {
      name: "@s/aa-agent",
      cinatra: { fieldRenderers: [{ id: "@s/shared:gate", kind: "cta", priority: 90 }] },
    });
    const entries = collectInstalledFieldRendererBindings();
    const hit = entries.filter((e) => e.id === "@s/shared:gate");
    expect(hit).toHaveLength(1);
    expect(hit[0].declaredBy).toBe("@s/aa-agent");
    expect(hit[0].priority).toBe(90);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("conflicting declarations"),
    );
    warn.mockRestore();
  });

  it("caches within the TTL and refreshes after the cache is cleared", () => {
    expect(collectInstalledFieldRendererBindings()).toEqual([]);
    writePkg("s", "late-agent", {
      name: "@s/late-agent",
      cinatra: { fieldRenderers: [{ id: "@s/late-agent:g", kind: "cta", priority: 70 }] },
    });
    expect(collectInstalledFieldRendererBindings()).toEqual([]); // cached
    __clearInstalledFieldRendererBindingsCache();
    expect(collectInstalledFieldRendererBindings()).toHaveLength(1);
  });
});

describe("getMergedFieldRendererBindings — generated precedence", () => {
  it("a runtime duplicate of a generated id never shadows the generated entry, and a DIVERGENT one is warned naming both declarers", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const generated = GENERATED_FIELD_RENDERER_BINDINGS[0];
    writePkg("s", "shadow-agent", {
      name: "@s/shadow-agent",
      cinatra: {
        fieldRenderers: [{ id: generated.id, kind: "cta", priority: 1 }],
      },
    });
    const merged = getMergedFieldRendererBindings();
    const hit = merged.filter((b) => b.id === generated.id);
    expect(hit).toHaveLength(1);
    expect(hit[0].kind).toBe(generated.kind);
    expect(hit[0].priority).toBe(generated.priority);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("@s/shadow-agent"),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(generated.declaredBy),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("the generated binding wins"),
    );
    warn.mockRestore();
  });
});

describe("resolveRendererIdForKind", () => {
  it("resolves a kind's gate id from the generated bindings", () => {
    expect(resolveRendererIdForKind("blog-idea-selection")).toBe(
      "@cinatra-ai/blog-pipeline-agent:idea-selection",
    );
  });

  it("returns undefined for a kind no present/installed package binds", () => {
    expect(resolveRendererIdForKind("kind-nobody-binds")).toBeUndefined();
  });

  it("cinatra#1796: the RETIRED reviewer-output kind resolves to nothing", () => {
    // The kind left KNOWN_FIELD_RENDERER_KINDS with the retirement teardown and
    // no package binds it any more, so the lookup must be empty rather than
    // silently resolving a stale id.
    expect(resolveRendererIdForKind("reviewer-output")).toBeUndefined();
  });
});

describe("buildA2UiMidRunTranslatorResolver", () => {
  it("maps the four email :output gates to their translator kinds", () => {
    const resolve = buildA2UiMidRunTranslatorResolver();
    expect(resolve("@cinatra-ai/email-recipient-selection-agent:output")).toBe(
      A2UI_MID_RUN_TRANSLATOR_KINDS["recipients-output"],
    );
    expect(resolve("@cinatra-ai/email-drafting-agent:output")).toBe(
      A2UI_MID_RUN_TRANSLATOR_KINDS["drafts-output"],
    );
    expect(resolve("@cinatra-ai/email-follow-up-agent:output")).toBe(
      A2UI_MID_RUN_TRANSLATOR_KINDS["followups-output"],
    );
    expect(resolve("@cinatra-ai/email-delivery-agent:output")).toBe(
      A2UI_MID_RUN_TRANSLATOR_KINDS["send-output"],
    );
  });

  it("returns undefined for ids without an a2uiTranslator binding", () => {
    const resolve = buildA2UiMidRunTranslatorResolver();
    expect(resolve("@cinatra-ai/agent-builder:grouped-setup-form")).toBeUndefined();
    expect(resolve("@cinatra-ai/blog-pipeline-agent:idea-selection")).toBeUndefined();
  });
});

// ONE RULE FOR "THIS RENDERER ID IS DRAWN". The server accepts an answer for a
// parked step only when a screen draws its renderer id, and the client draws
// what its registry resolves. Every form an id can take — the binding's full
// id, its bare name, its kind (which is also every declared bare alias) — gets
// the same answer from both.
describe("a renderer id is drawn by the same rule on the server and in the client", () => {
  const GMAIL_CONTEXT = { connectedApps: ["gmail"], gmailAliases: [{ sendAsEmail: "a@b.c" }] };

  // red-first-expect: serverHitlRendererClaim is not a function
  it("every id form of every generated binding gets one answer from both", () => {
    ensureDefaultFieldRenderersRegistered();
    const forms = new Set<string>();
    for (const b of GENERATED_FIELD_RENDERER_BINDINGS) {
      forms.add(b.id);
      forms.add(b.id.slice(b.id.indexOf(":") + 1));
      forms.add(b.kind);
    }
    for (const form of [...forms].sort()) {
      const claim = serverHitlRendererClaim(form);
      const drawn = fieldRendererRegistry.resolve("field", { "x-renderer": form }, GMAIL_CONTEXT as never);
      expect(`${form}: server ${claim !== null}, client ${drawn !== null}`).toBe(
        `${form}: server ${drawn !== null}, client ${drawn !== null}`,
      );
      if (claim !== null && GENERATED_FIELD_RENDERER_BINDINGS.some((b) => b.id === form)) {
        expect(claim.id).toBe(form);
        expect(drawn!.id).toBe(form);
      }
    }
  });
});

// …AND FOR EVERY ID FAMILY. The host's own ids (the grouped setup form, the
// plain form, the personal-skill and skill-selector fields with their bare
// ids, the display-only review redirect) and every generated binding id, each
// also in adversarial forms: an extra suffix, an `:output` variant, another
// case, surrounding space. The server's "may this step be answered" and the
// page's "is this step drawn with a Continue" (the entry the hosts resolve a
// gate with, read by `parkedHitlStepIsAnswerable`) give the same answer.
describe("a parked step is answerable on the server exactly when a page draws it", () => {
  const GMAIL_CONTEXT = { connectedApps: ["gmail"], gmailAliases: [{ sendAsEmail: "a@b.c" }] };
  const NO_CONTEXT = { connectedApps: [] };
  // Every state a context-reading condition tells apart: connected with an
  // alias, connected with none, not connected.
  const READER_CONTEXTS = [GMAIL_CONTEXT, { connectedApps: ["gmail"], gmailAliases: [] }, NO_CONTEXT];
  const HOST_IDS = [
    GROUPED_SETUP_FORM_RENDERER_ID,
    SCHEMA_FIELD_FALLBACK_RENDERER_ID,
    PERSONAL_SKILL_RENDERER_ID,
    SKILL_SELECTOR_RENDERER_ID,
    "personal-skill",
    "skill-selector",
    ARTIFACT_REVIEW_REDIRECT_RENDERER_ID,
  ];

  // red-first-expect: parkedHitlStepIsAnswerableOnServer is not a function
  it("every host id and every binding id, in every adversarial form", () => {
    ensureDefaultFieldRenderersRegistered();
    const bases = new Set<string>(HOST_IDS);
    for (const b of GENERATED_FIELD_RENDERER_BINDINGS) {
      bases.add(b.id);
      bases.add(b.kind);
    }
    const forms = new Set<string>();
    for (const id of bases) {
      for (const form of [id, `${id}:anything`, `${id}:output`, `${id}x`, id.toUpperCase(), ` ${id} `, `${id}\n`]) {
        forms.add(form);
      }
    }
    const disagreements: string[] = [];
    // With no values, and with values that carry a presentation hint (a step
    // the host draws through its own generic renderer).
    const VALUES = [{}, { presentation: { type: "choice" } }];
    for (const form of [...forms].sort()) {
      for (const values of VALUES) {
        // No reader known (the bound-card ref): the page of a reader with
        // nothing connected.
        const server = parkedHitlStepIsAnswerableOnServer({ xRenderer: form, values });
        const entry = resolveHitlGateRenderer("hitl-field", { "x-renderer": form, type: "string" }, NO_CONTEXT as never);
        const page = parkedHitlStepIsAnswerable(form, entry, values);
        if (server !== page) {
          disagreements.push(`${JSON.stringify(form)} ${JSON.stringify(values)}: server ${server}, page ${page}`);
        }
      }
    }
    expect(disagreements).toEqual([]);
  });

  // A CONDITION THAT READS THE READER'S CONTEXT is evaluated on the server with
  // the same context: every binding, every reader state, one answer.
  // red-first-expect: parkedHitlStepRefusalOnServer is not a function
  it("every binding id in every reader context: connected, connected without an alias, not connected", () => {
    ensureDefaultFieldRenderersRegistered();
    const forms = new Set<string>();
    for (const b of GENERATED_FIELD_RENDERER_BINDINGS) {
      forms.add(b.id);
      forms.add(b.id.slice(b.id.indexOf(":") + 1));
      forms.add(b.kind);
    }
    const disagreements: string[] = [];
    for (const context of READER_CONTEXTS) {
      for (const values of [{}, { presentation: { type: "choice" } }]) {
        for (const form of [...forms].sort()) {
          const server = parkedHitlStepRefusalOnServer({ xRenderer: form, values }, context as never) === null;
          const entry = resolveHitlGateRenderer("hitl-field", { "x-renderer": form, type: "string" }, context as never);
          const page = parkedHitlStepIsAnswerable(form, entry, values);
          if (server !== page) {
            disagreements.push(`${form} ${JSON.stringify(values)} ${JSON.stringify(context)}: server ${server}, page ${page}`);
          }
        }
      }
    }
    expect(disagreements).toEqual([]);
  });

  // Every binding whose page entry answers differently in two reader contexts
  // is one the server evaluates the context for.
  // red-first-expect: resolveHitlGateRenderer is not a function
  it("every binding whose drawing depends on the reader's context is listed for the server", () => {
    ensureDefaultFieldRenderersRegistered();
    const reads = new Set<string>();
    for (const b of GENERATED_FIELD_RENDERER_BINDINGS) {
      const drawnIn = READER_CONTEXTS.map(
        (context) => resolveHitlGateRenderer("hitl-field", { "x-renderer": b.id, type: "string" }, context as never)?.id ?? null,
      );
      if (new Set(drawnIn).size > 1) reads.add(b.kind);
    }
    expect([...reads].sort()).toEqual(Object.keys(FIELD_RENDERER_KIND_CONTEXT_CONDITIONS).sort());
    expect([...reads]).toEqual(["gmail-sender"]);
  });

});

// THE ONE ANSWER GUARD decides on the run's current gate, with the acting
// user's context read by the loader the page's context comes from.
describe("currentParkedHitlStepRefusal", () => {
  const GMAIL_GATE = {
    runId: "run-g",
    reviewTaskId: "wayflow-task-g",
    xRenderer: "@cinatra-ai/email-outreach-agent:gmail-sender",
    inputSchema: { type: "object" },
    values: {},
  };
  beforeEach(() => {
    guardReads.currentGate.mockReset().mockResolvedValue(GMAIL_GATE);
    guardReads.senders.mockReset().mockResolvedValue([]);
    ensureDefaultFieldRenderersRegistered();
  });

  // red-first-expect: currentParkedHitlStepRefusal is not a function
  it("a Gmail sender gate is answered for an acting user with Gmail connected", async () => {
    guardReads.senders.mockResolvedValue([{ app: "gmail", identities: [{ email: "a@b.c" }] }]);
    await expect(currentParkedHitlStepRefusal({ runId: "run-g", actingUserId: "user-1" })).resolves.toEqual({
      gate: GMAIL_GATE,
      refusal: null,
    });
    expect(guardReads.currentGate).toHaveBeenCalledWith("run-g");
    expect(guardReads.senders).toHaveBeenCalledWith("user-1");
  });

  // red-first-expect: currentParkedHitlStepRefusal is not a function
  it("a Gmail sender gate is refused for an acting user without Gmail, without an alias, with an unread context, or with none", async () => {
    const refusals: unknown[] = [];
    guardReads.senders.mockResolvedValue([]);
    refusals.push((await currentParkedHitlStepRefusal({ runId: "run-g", actingUserId: "user-1" })).refusal);
    guardReads.senders.mockResolvedValue([{ app: "gmail", identities: [] }]);
    refusals.push((await currentParkedHitlStepRefusal({ runId: "run-g", actingUserId: "user-1" })).refusal);
    guardReads.senders.mockRejectedValue(new Error("provider down"));
    refusals.push((await currentParkedHitlStepRefusal({ runId: "run-g", actingUserId: "user-1" })).refusal);
    guardReads.senders.mockResolvedValue([{ app: "gmail", identities: [{ email: "a@b.c" }] }]);
    refusals.push((await currentParkedHitlStepRefusal({ runId: "run-g", actingUserId: null })).refusal);
    expect(refusals).toEqual(["undrawn", "undrawn", "undrawn", "undrawn"]);
  });

  // red-first-expect: currentParkedHitlStepRefusal is not a function
  it("a named gate that is not the run's current gate is stale; a step that reads no context reads none", async () => {
    await expect(
      currentParkedHitlStepRefusal({ runId: "run-g", actingUserId: "user-1", namedReviewTaskId: "wayflow-task-old" }),
    ).resolves.toEqual({ gate: GMAIL_GATE, refusal: "stale" });
    guardReads.currentGate.mockResolvedValue({ ...GMAIL_GATE, xRenderer: SCHEMA_FIELD_FALLBACK_RENDERER_ID });
    await expect(
      currentParkedHitlStepRefusal({ runId: "run-g", actingUserId: "user-1", namedReviewTaskId: "wayflow-task-g" }),
    ).resolves.toMatchObject({ refusal: null });
    expect(guardReads.senders).not.toHaveBeenCalled();
    guardReads.currentGate.mockResolvedValue(null);
    await expect(currentParkedHitlStepRefusal({ runId: "run-g", actingUserId: "user-1" })).resolves.toEqual({
      gate: null,
      refusal: null,
    });
  });
});
