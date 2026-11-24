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
import { createHmac } from "node:crypto";

let FIXTURE_DIR = "";

/**
 * A file-system fault the collector meets (cinatra#3470): a read of a path
 * ending in `path` throws an error with `code`. Every other call is the real
 * one, so the collector's own error handling is what runs.
 */
// The host seals each pin it writes with a key derived from the app secret.
process.env.BETTER_AUTH_SECRET ??= "x3470-placeholder-not-a-credential";

const fsFault = vi.hoisted(() => ({
  readdir: null as { path: string; code: string } | null,
  readFile: null as { path: string; code: string } | null,
}));

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const faulted = (fault: { path: string; code: string } | null, target: unknown) => {
    if (fault === null || !String(target).endsWith(fault.path)) return;
    throw Object.assign(new Error(`${fault.code}: fixture fault, open '${String(target)}'`), {
      code: fault.code,
    });
  };
  const readdirSync = ((target: unknown, ...rest: unknown[]) => {
    faulted(fsFault.readdir, target);
    return (real.readdirSync as (...a: unknown[]) => unknown)(target, ...rest);
  }) as typeof real.readdirSync;
  const readFileSync = ((target: unknown, ...rest: unknown[]) => {
    faulted(fsFault.readFile, target);
    return (real.readFileSync as (...a: unknown[]) => unknown)(target, ...rest);
  }) as typeof real.readFileSync;
  return { ...real, default: { ...real, readdirSync, readFileSync }, readdirSync, readFileSync };
});

vi.mock("../agent-runtime-mount", () => ({
  resolveAgentRuntimeMountDir: () => {
    if (!FIXTURE_DIR) throw new Error("fixture dir unset");
    return FIXTURE_DIR;
  },
}));

import {
  collectInstalledFieldRendererBindings,
  getMergedFieldRendererBindings,
  resolveRendererIdForKind,
  buildA2UiMidRunTranslatorResolver,
  __clearInstalledFieldRendererBindingsCache,
} from "../field-renderer-bindings.server";
import * as installedBindings from "../field-renderer-bindings.server";
import { GENERATED_FIELD_RENDERER_BINDINGS } from "@/lib/generated/agent-bindings";
import { rendererStepOf } from "../field-renderer-registry";
import { A2UI_MID_RUN_TRANSLATOR_KINDS } from "@cinatra-ai/agent-ui-protocol/server";

function writePkg(scope: string, name: string, pkg: Record<string, unknown>) {
  const dir = join(FIXTURE_DIR, scope, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
}

/** The seal the host writes over a step's pin (an HMAC under the app secret's derived key). */
function hostSeal(xRenderer: string, pin: string): string {
  const key = createHmac("sha256", String(process.env.BETTER_AUTH_SECRET))
    .update("cinatra:declared-screen-pin-seal:v1")
    .digest();
  return `h1:${createHmac("sha256", key).update(`h1\n${xRenderer}\n${pin}`, "utf8").digest("hex")}`;
}

beforeEach(() => {
  FIXTURE_DIR = mkdtempSync(join(tmpdir(), "frb-fixture-"));
  __clearInstalledFieldRendererBindingsCache();
});

afterEach(() => {
  fsFault.readdir = null;
  fsFault.readFile = null;
  rmSync(FIXTURE_DIR, { recursive: true, force: true });
  FIXTURE_DIR = "";
  __clearInstalledFieldRendererBindingsCache();
});


/**
 * The declared card of a gate whose step opened under the declaration
 * installed now: its gate schema carries the pin the park writes
 * (`withDeclaredScreenPin`).
 */
function readOpenedUnderCurrent(id: string): unknown {
  const mod = installedBindings as unknown as {
    readDeclaredHitlCard?: (x: string, stepSchema: unknown) => unknown;
    withDeclaredScreenPin?: (schema: Record<string, unknown>, x: string) => Record<string, unknown>;
  };
  return mod.readDeclaredHitlCard?.(id, mod.withDeclaredScreenPin?.({}, id) ?? {}) ?? null;
}

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

describe("readDeclaredHitlCard — a refused declared screen is unavailable (cinatra#3470)", () => {
  it("answers unavailable for a screen the validator refused, and null for a gate with no screen", () => {
    // Read through the module, so a tree without the reader answers as "no card".
    const readDeclaredHitlCard = (id: string): unknown =>
      readOpenedUnderCurrent(id);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    writePkg("s", "screen-agent", {
      name: "@s/screen-agent",
      cinatra: {
        fieldRenderers: [
          // A card with no title: the validator refuses the whole entry.
          { id: "@s/screen-agent:refused", kind: "linkedin-draft-review", priority: 90, midRunHitl: true, screen: { layout: "card" } },
          { id: "@s/screen-agent:plain", kind: "cta", priority: 70 },
          {
            id: "@s/screen-agent:card",
            kind: "linkedin-draft-review",
            priority: 90,
            midRunHitl: true,
            screen: { layout: "card", title: "Fixture title", sections: [{ type: "field", key: "answer", label: "Fixture answer" }] },
          },
        ],
      },
    });
    // red-first-expect: expected null to be 'unavailable'
    expect(readDeclaredHitlCard("@s/screen-agent:refused")).toBe("unavailable");
    // An ordinary gate, declared without a screen or not declared at all, is unchanged.
    expect(readDeclaredHitlCard("@s/screen-agent:plain")).toBeNull();
    expect(readDeclaredHitlCard("@s/screen-agent:not-declared")).toBeNull();
    expect(readDeclaredHitlCard("@s/screen-agent:card")).toMatchObject({ layout: "card", title: "Fixture title" });
  });
});

describe("a 'kind' screen on a kind the host draws no component for is refused (cinatra#3470)", () => {
  const read = (id: string): unknown =>
    readOpenedUnderCurrent(id);
  const refused = (id: string): unknown =>
    (installedBindings as { isRefusedDeclaredScreen?: (x: string) => unknown }).isRefusedDeclaredScreen?.(id);

  it("an installed declaration naming linkedin-draft-review holds: unavailable, never the raw gate schema", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    writePkg("s", "kind-agent", {
      name: "@s/kind-agent",
      cinatra: {
        fieldRenderers: [
          { id: "@s/kind-agent:floor", kind: "linkedin-draft-review", priority: 90, midRunHitl: true, screen: { layout: "kind" } },
          { id: "@s/kind-agent:drawn", kind: "context-selector", priority: 80, midRunHitl: true, screen: { layout: "kind" } },
        ],
      },
    });
    // red-first-expect: expected null to be 'unavailable'
    expect(read("@s/kind-agent:floor")).toBe("unavailable");
    expect(refused("@s/kind-agent:floor")).toBe(true);
    // A kind the host draws is not refused.
    expect(refused("@s/kind-agent:drawn")).toBe(false);
  });

  it("a valid 'kind' screen reads as a kind screen, never as a gate that declares none", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    writePkg("s", "setup-agent", {
      name: "@s/setup-agent",
      cinatra: {
        fieldRenderers: [
          { id: "@s/setup-agent:details", kind: "wayflow-setup-form", priority: 80, midRunHitl: true, screen: { layout: "kind" } },
          { id: "@s/setup-agent:pick", kind: "context-selector", priority: 80, midRunHitl: true, screen: { layout: "kind" } },
        ],
      },
    });
    // The kind's own component draws it with its own submission logic (the
    // grouped setup form flushes and validates its fields): the server lends
    // no generic fill or submit for it, so it must not read as no screen.
    // red-first-expect: expected null to be 'kind-screen'
    expect(read("@s/setup-agent:details")).toBe("kind-screen");
    expect(read("@s/setup-agent:pick")).toBe("kind-screen");
    expect(refused("@s/setup-agent:details")).toBe(false);
  });

  it("a merged binding that names an unsupported kind is undrawable, whatever its source", () => {
    const undrawable = (installedBindings as {
      isUndrawableDeclaredScreen?: (b: { kind: string; screen?: unknown }) => boolean;
    }).isUndrawableDeclaredScreen;
    // red-first-expect: expected 'undefined' to be 'function'
    expect(typeof undrawable).toBe("function");
    expect(undrawable!({ kind: "linkedin-draft-review", screen: { layout: "kind" } })).toBe(true);
    expect(undrawable!({ kind: "cta", screen: { layout: "kind" } })).toBe(true);
    expect(undrawable!({ kind: "context-selector", screen: { layout: "kind" } })).toBe(false);
    expect(undrawable!({ kind: "linkedin-draft-review", screen: { layout: "card", title: "x" } })).toBe(false);
    expect(undrawable!({ kind: "linkedin-draft-review" })).toBe(false);
  });
});

describe("a declared screen installed after a scan was cached is never read as none (cinatra#3470)", () => {
  const read = (id: string): unknown =>
    readOpenedUnderCurrent(id);
  const refused = (id: string): unknown =>
    (installedBindings as { isRefusedDeclaredScreen?: (x: string) => unknown }).isRefusedDeclaredScreen?.(id);
  const CARD_SCREEN = {
    layout: "card",
    title: "Fixture title",
    sections: [{ type: "field", key: "answer", label: "Fixture answer" }],
  };

  it("a gate's own read rescans when the cached scan does not name its id", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // The scan is cached while nothing is installed …
    expect(collectInstalledFieldRendererBindings()).toEqual([]);
    // … and then the agent is installed.
    writePkg("s", "late-screen-agent", {
      name: "@s/late-screen-agent",
      cinatra: {
        fieldRenderers: [
          { id: "@s/late-screen-agent:card", kind: "linkedin-draft-review", priority: 90, midRunHitl: true, screen: CARD_SCREEN },
          { id: "@s/late-screen-agent:refused", kind: "linkedin-draft-review", priority: 90, midRunHitl: true, screen: { layout: "card" } },
        ],
      },
    });
    // The step opened under this declaration: its pin is the declaration's
    // own, made without a scan, so the read below is what rescans.
    const pinOf = (installedBindings as unknown as {
      declaredScreenPin?: (b: Record<string, unknown>) => string;
    }).declaredScreenPin;
    const pin = String(
      pinOf?.({
        id: "@s/late-screen-agent:card",
        kind: "linkedin-draft-review",
        midRunHitl: true,
        screen: CARD_SCREEN,
      }),
    );
    const opened = {
      "x-declared-screen": pin,
      "x-declared-screen-seal": hostSeal("@s/late-screen-agent:card", pin),
    };
    const readCard = (installedBindings as unknown as {
      readDeclaredHitlCard?: (x: string, stepSchema: unknown) => unknown;
    }).readDeclaredHitlCard;
    // red-first-expect: expected null to match object { layout: 'card'
    expect(readCard?.("@s/late-screen-agent:card", opened) ?? null).toMatchObject({
      layout: "card",
      title: "Fixture title",
    });
    expect(refused("@s/late-screen-agent:refused")).toBe(true);
    expect(read("@s/late-screen-agent:refused")).toBe("unavailable");
  });

  it("the run page's fresh read rescans past the cache", () => {
    // Read through the module, so a tree without the payload answers nothing.
    const payload = (opts?: { fresh?: boolean }): { bindings: Array<{ id: string }> } =>
      (installedBindings as {
        runtimeFieldRendererBindingsPayload?: (o?: { fresh?: boolean }) => { bindings: Array<{ id: string }> };
      }).runtimeFieldRendererBindingsPayload?.(opts) ?? { bindings: [] };
    expect(payload().bindings).toEqual([]);
    writePkg("s", "fresh-agent", {
      name: "@s/fresh-agent",
      cinatra: {
        fieldRenderers: [
          { id: "@s/fresh-agent:card", kind: "linkedin-draft-review", priority: 90, midRunHitl: true, screen: CARD_SCREEN },
        ],
      },
    });
    // The cached answer, as before.
    expect(payload().bindings).toEqual([]);
    const fresh = payload({ fresh: true });
    // red-first-expect: expected [] to deeply equal [ '@s/fresh-agent:card' ]
    expect(fresh.bindings.map((b) => b.id)).toEqual(["@s/fresh-agent:card"]);
  });
});


describe("a binding collection error is never read as 'no screen' (cinatra#3470)", () => {
  const read = (id: string): unknown =>
    readOpenedUnderCurrent(id);
  // Read through the module, so a tree without the payload answers nothing.
  const payload = (opts?: { fresh?: boolean }): { bindings?: Array<{ id: string }>; incomplete?: unknown } =>
    (installedBindings as {
      runtimeFieldRendererBindingsPayload?: (o?: { fresh?: boolean }) => {
        bindings: Array<{ id: string }>;
        incomplete?: unknown;
      };
    }).runtimeFieldRendererBindingsPayload?.(opts) ?? {};
  const CARD_SCREEN = {
    layout: "card",
    title: "Fixture title",
    sections: [{ type: "field", key: "answer", label: "Fixture answer" }],
  };

  function installReadable() {
    writePkg("s", "readable-agent", {
      name: "@s/readable-agent",
      cinatra: {
        fieldRenderers: [
          { id: "@s/readable-agent:card", kind: "linkedin-draft-review", priority: 90, midRunHitl: true, screen: CARD_SCREEN },
        ],
      },
    });
  }

  it("an unreadable package manifest (EACCES) makes the read incomplete, and an id it may declare unavailable", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    installReadable();
    writePkg("s", "locked-agent", {
      name: "@s/locked-agent",
      cinatra: {
        fieldRenderers: [
          { id: "@s/locked-agent:card", kind: "linkedin-draft-review", priority: 90, midRunHitl: true, screen: CARD_SCREEN },
        ],
      },
    });
    fsFault.readFile = { path: join("locked-agent", "package.json"), code: "EACCES" };
    const answer = payload({ fresh: true });
    // red-first-expect: expected undefined to be true
    expect(answer.incomplete).toBe(true);
    // What was read is still answered.
    expect(answer.bindings?.map((b) => b.id)).toEqual(["@s/readable-agent:card"]);
    // The id the unreadable manifest may declare holds: never "no screen".
    expect(read("@s/locked-agent:card")).toBe("unavailable");
    expect(read("@s/readable-agent:card")).toMatchObject({ layout: "card" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("EACCES"));
  });

  it("an unparsable package manifest makes the read incomplete", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    installReadable();
    const dir = join(FIXTURE_DIR, "s", "torn-agent");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), '{"name": "@s/torn-agent", "cinatra": {');
    // red-first-expect: expected undefined to be true
    expect(payload({ fresh: true }).incomplete).toBe(true);
    expect(read("@s/torn-agent:card")).toBe("unavailable");
  });

  it("an unreadable mount (EACCES) makes the read incomplete", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    installReadable();
    fsFault.readdir = { path: FIXTURE_DIR, code: "EACCES" };
    // red-first-expect: expected undefined to be true
    expect(payload({ fresh: true }).incomplete).toBe(true);
    expect(read("@s/readable-agent:card")).toBe("unavailable");
  });

  it("a missing mount directory is no agents installed: a complete, empty read", () => {
    rmSync(FIXTURE_DIR, { recursive: true, force: true });
    const answer = payload({ fresh: true });
    expect(answer.incomplete).toBeUndefined();
    expect(answer.bindings ?? []).toEqual([]);
    expect(read("@s/readable-agent:card")).toBeNull();
    // A package folder with no manifest is not a package: still complete.
    mkdirSync(join(FIXTURE_DIR, "s", "empty-folder"), { recursive: true });
    expect(payload({ fresh: true }).incomplete).toBeUndefined();
  });
});

describe("a bundled id whose owning package was not read cleanly is held, never matched (cinatra#3470)", () => {
  // A bundled (generated) id with no declared screen, and the mount folder of
  // the package that owns it.
  const BUNDLED = "@cinatra-ai/blog-wordpress-publish-agent:draft-confirm";
  const OWNER = ["cinatra-ai", "blog-wordpress-publish-agent"] as const;
  const mod = installedBindings as unknown as {
    stepDeclarationStanding?: (x: string, schema: unknown, o?: { fresh?: boolean }) => string;
    isRefusedDeclaredScreen?: (x: string) => boolean;
    runtimeFieldRendererBindingsPayload?: (o?: { fresh?: boolean }) => { unreadOwnerIds?: string[] };
  };
  // A step opened under the generated binding: it declared no screen, so the
  // park wrote no pin.
  const standing = () => mod.stepDeclarationStanding?.(BUNDLED, { type: "object" }, { fresh: true });

  it("a torn manifest of the owning package holds the bundled id as could not be loaded", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = join(FIXTURE_DIR, ...OWNER);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), '{"name": "@cinatra-ai/blog-wordpress-publish-agent", "cinatra": {');
    // red-first-expect: expected undefined to be 'unknown'
    expect(standing()).toBe("unknown");
    expect(mod.isRefusedDeclaredScreen?.(BUNDLED)).toBe(true);
    expect(mod.runtimeFieldRendererBindingsPayload?.({ fresh: true }).unreadOwnerIds).toContain(BUNDLED);
  });

  it("an unreadable manifest (EACCES) or scope of the owning package holds the bundled id too", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    writePkg(OWNER[0], OWNER[1], { name: "@cinatra-ai/blog-wordpress-publish-agent" });
    fsFault.readFile = { path: join(OWNER[1], "package.json"), code: "EACCES" };
    // red-first-expect: expected undefined to be 'unknown'
    expect(standing()).toBe("unknown");
    fsFault.readFile = null;
    fsFault.readdir = { path: join(FIXTURE_DIR, OWNER[0]), code: "EACCES" };
    expect(standing()).toBe("unknown");
    fsFault.readdir = null;
    // Once the owner reads cleanly (it declares nothing for the id), the step matches.
    expect(standing()).toBe("matches");
  });

  it("a bundled id whose owner reads cleanly, or is not installed, matches beside an unreadable other package", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const dir = join(FIXTURE_DIR, "s", "torn-agent");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), '{"name": "@s/torn-agent", "cinatra": {');
    // red-first-expect: expected undefined to be 'matches'
    expect(standing()).toBe("matches");
    writePkg(OWNER[0], OWNER[1], { name: "@cinatra-ai/blog-wordpress-publish-agent" });
    expect(standing()).toBe("matches");
    expect(mod.runtimeFieldRendererBindingsPayload?.({ fresh: true }).unreadOwnerIds).toBeUndefined();
  });
});

describe("a pin the host did not seal is never read as a pin (cinatra#3470)", () => {
  const ID = "@s/legacy-agent:card";
  const CARD_SCREEN = {
    layout: "card",
    title: "Fixture title",
    sections: [{ type: "field", key: "answer", label: "Fixture answer" }],
  };
  const mod = installedBindings as unknown as {
    stepDeclarationStanding?: (x: string, schema: unknown, o?: { fresh?: boolean }) => string;
    currentDeclaredScreenPin?: (x: string, o?: { fresh?: boolean }) => string | null;
    readDeclaredHitlCard?: (x: string, schema: unknown) => unknown;
  };
  function install(screen: boolean) {
    writePkg("s", "legacy-agent", {
      name: "@s/legacy-agent",
      cinatra: {
        fieldRenderers: [
          {
            id: ID,
            kind: "linkedin-draft-review",
            priority: 90,
            midRunHitl: true,
            ...(screen ? { screen: CARD_SCREEN } : {}),
          },
        ],
      },
    });
    __clearInstalledFieldRendererBindingsCache();
  }

  it("an agent-authored 'unknown' pin of a step parked before the upgrade admits no declared screen", () => {
    install(true);
    // The step's own schema named the pin: no seal, so it opened with no screen.
    const legacy = { type: "object", "x-declared-screen": "unknown" };
    // red-first-expect: expected undefined to be 'changed'
    expect(mod.stepDeclarationStanding?.(ID, legacy, { fresh: true })).toBe("changed");
    expect(mod.readDeclaredHitlCard?.(ID, legacy)).toBe("unavailable");
    // The browser reads it as no screen too.
    expect(rendererStepOf("task-legacy", legacy).pin).toBe("none");
    // While its renderer declares no screen, it is answered as before the upgrade.
    install(false);
    expect(mod.stepDeclarationStanding?.(ID, legacy, { fresh: true })).toBe("matches");
  });

  it("a forged pin of the current declaration, unsealed or with a seal the host did not make, is never matched", () => {
    install(true);
    const current = String(mod.currentDeclaredScreenPin?.(ID, { fresh: true }));
    const forged = [
      { "x-declared-screen": current },
      { "x-declared-screen": current, "x-declared-screen-seal": `h1:${"0".repeat(64)}` },
      // A seal the host made for another renderer id.
      { "x-declared-screen": current, "x-declared-screen-seal": hostSeal("@s/other-agent:card", current) },
      { "x-declared-screen": "unknown", "x-declared-screen-seal": hostSeal("@s/other-agent:card", "unknown") },
    ];
    for (const schema of forged) {
      // red-first-expect: expected undefined to be 'changed'
      expect(mod.stepDeclarationStanding?.(ID, schema, { fresh: true })).toBe("changed");
    }
    // The seal the host makes for this id is read.
    expect(
      mod.stepDeclarationStanding?.(
        ID,
        { "x-declared-screen": current, "x-declared-screen-seal": hostSeal(ID, current) },
        { fresh: true },
      ),
    ).toBe("matches");
  });
});
