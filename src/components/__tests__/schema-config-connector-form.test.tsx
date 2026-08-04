/**
 * SchemaConfigConnectorForm — source-text contract test.
 *
 * This repo's component tests use source-file assertions (@testing-library/react
 * isn't available; the root vitest env is "node"). This locks the shadcn-compliant
 * composition the schema-driven connector renderer depends on: it renders the
 * declared vocabulary via shadcn primitives (Field/Input/Button/StatusPill), never
 * raw HTML form controls, and dispatches named actions through the host action
 * endpoint (never a connector-defined Server Action).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const SRC = readFileSync(join(process.cwd(), "src/components/extensions/schema-config-connector-form.tsx"), "utf8");

describe("SchemaConfigConnectorForm composition (shadcn contract)", () => {
  it("is a client component", () => {
    expect(SRC.startsWith('"use client"')).toBe(true);
  });

  it("renders via shadcn primitives, not raw HTML controls", () => {
    expect(SRC).toContain('from "@/components/ui/field"');
    expect(SRC).toContain('from "@/components/ui/input"');
    expect(SRC).toContain('from "@/components/ui/button"');
    expect(SRC).toContain('from "@/components/ui/status-pill"');
    // No raw form controls (shadcn rule — use the ui primitives).
    expect(SRC).not.toMatch(/<input[\s>]/);
    expect(SRC).not.toMatch(/<button[\s>]/);
    expect(SRC).not.toMatch(/<select[\s>]/);
  });

  it("uses gap-based layout, not space-y (shadcn rule)", () => {
    expect(SRC).not.toMatch(/space-y-/);
    expect(SRC).not.toMatch(/space-x-/);
  });

  it("uses semantic color tokens via shadcn primitives, not raw palette classes", () => {
    // Secondary/muted text is delegated to the shadcn typography primitives
    // (FieldDescription/FieldLabel own text-muted-foreground), so the renderer
    // hand-applies no color utilities at all — the strongest form of the
    // semantic-token rule. Guard that no raw palette class leaks in.
    expect(SRC).toMatch(/FieldDescription|FieldLabel/);
    expect(SRC).not.toMatch(/text-(?:gray|slate|blue|red|green|emerald|zinc|neutral)-\d/);
    expect(SRC).not.toMatch(/bg-(?:white|gray|slate|black)-?\d?/);
  });

  it("dispatches actions through the host action endpoint (not a connector Server Action)", () => {
    expect(SRC).toContain("/api/extensions/");
    expect(SRC).toContain("/actions/");
    expect(SRC).not.toContain('"use server"');
  });

  it("handles every vocabulary field kind", () => {
    for (const kind of ['case "text"', 'case "secret"', 'case "copyable-credential"', 'case "nango-connect"', 'case "status-probe"', 'case "named-action"', 'case "repeatable-list"']) {
      expect(SRC).toContain(kind);
    }
  });

  it("status probes render through StatusPill (not a hand-rolled status indicator)", () => {
    expect(SRC).toContain("<StatusPill");
  });

  describe("cinatra#2356 — the connection actions speak the §II status-glyph language", () => {
    // design/specs/app-connectors.html §II (version 0.7.0, pinned at design@3d33cc800):
    // "an icon-led Connect (indigo primary, THE JOINED PLUG FROM THE CONNECTED
    // BADGE) and Disconnect (destructive, red-on-tint, THE UNPLUG FROM THE
    // DISCONNECTED BADGE) … its confirm the same unplug icon". So the Connect
    // action must draw the SAME first-party glyph the §I card badge and the
    // status badge draw — which is only structurally guaranteed by importing
    // the single sdk-ui definition rather than picking a similar lucide icon
    // (the `PlugZap` this replaces was exactly that mistake).
    it("imports the joined plug from the ONE sdk-ui definition (no lucide look-alike, no local redraw)", () => {
      expect(SRC).toMatch(
        /import \{ PlugConnected \} from "@cinatra-ai\/sdk-ui\/icons"/,
      );
      expect(SRC).not.toContain("<PlugZap");
      expect(SRC).not.toMatch(/from "lucide-react"[\s\S]{0,200}PlugZap/);
      // No hand-drawn twin: the glyph is never re-declared as raw SVG here.
      expect(SRC).not.toMatch(/<svg[\s>]/);
    });

    it("leads the Connect action with PlugConnected", () => {
      expect(SRC).toMatch(
        /data-testid="connector-connect"[\s\S]*?<PlugConnected \/>/,
      );
    });

    it("keeps Unplug on BOTH the Disconnect button and its AlertDialog confirm", () => {
      // #2356 scope 2 explicitly excludes the disconnect sites — the
      // destructive action and its confirm keep the disconnected mark.
      expect(SRC).toMatch(
        /data-testid="connector-disconnect"[\s\S]*?<Unplug \/>/,
      );
      // Two rendered <Unplug /> elements: the trigger and the confirm action.
      expect(SRC.match(/<Unplug \/>/g)?.length).toBe(2);
      expect(SRC).toMatch(/AlertDialogAction[\s\S]*?<Unplug \/>/);
    });
  });
});

describe("collectFormInputs origin is REQUIRED (cinatra#2357, closing the #2382 review)", () => {
  // #2382 scoped the input scan to the triggering button's own form because a
  // document-wide `querySelector` submits the FIRST form on the page — a
  // different connector's field values. It left the parameter OPTIONAL, with
  // that same document-wide scan surviving as the `undefined` branch. No
  // caller ever took it, so the branch was unreachable code whose only
  // behaviour was the leak the fix exists to prevent. These assertions are the
  // only ones that can fail on its return: the behavioural cross-form test in
  // src/components/extensions/__tests__ was green before the branch was
  // deleted and stays green after.
  it("declares a non-optional origin parameter", () => {
    expect(SRC).toMatch(
      /function collectFormInputs\(origin: Element \| null\): Record<string, string>/,
    );
    expect(SRC).not.toMatch(/function collectFormInputs\(origin\?/);
  });

  it("has no document-wide form lookup left to fall back to", () => {
    expect(SRC).not.toMatch(
      /document\.querySelector<HTMLElement>\('\[data-testid="schema-config-form"\]'\)/,
    );
    expect(SRC).not.toMatch(/origin === undefined/);
    // The ONE resolution path is the triggering element's own form, failing
    // closed to {} when it resolves to none.
    expect(SRC).toMatch(
      /const form = origin\?\.closest<HTMLElement>\('\[data-testid="schema-config-form"\]'\) \?\? null;/,
    );
  });

  it("passes an origin at every call site", () => {
    // The three dispatching sites, named exactly: the generic named action and
    // the Connect action pass the clicked button; the disconnect confirm lives
    // in a portal OUTSIDE the form, so it anchors to its in-form trigger ref.
    expect(SRC.match(/collectFormInputs\(origin\)/g)).toHaveLength(2);
    expect(SRC).toContain("collectFormInputs(triggerRef.current)");
  });
});
