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
});
