// ---------------------------------------------------------------------------
// §I INPUT HIERARCHY — `PromptField`'s PRIMARY variant is OPT-IN (#2865).
// ---------------------------------------------------------------------------
// Design: `specs/app-lifecycle-cards.html` §I at
// 60b27dfbb8a2a1594e6e88333cc5c048c244e640 — `.composer.primary { border-color:
// var(--line-strong); }`.
//
// `PromptField` backs TWO surfaces: the conversation's chat box, which §I makes
// the one primary input, and the run panel's field-assist input, which §I does
// not promote. So the variant is opt-in, and a field that says nothing keeps the
// ordinary `line` edge byte-for-byte. This file pins that asymmetry at the
// source, which is the only place it can be pinned in this package: the sdk-ui
// tier runs in the ROOT vitest project under the `node` environment (no DOM), so
// its tests are source-text contracts by construction — the rendered halves are
// asserted where a DOM exists (packages/chat's DOM-shape suite for the promoted
// composer, packages/agents' HITL suite for the unpromoted one).
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(
  path.join(__dirname, "..", "prompt-field.tsx"),
  "utf8",
);

describe("PromptField §I primary variant (#2865)", () => {
  it("declares the variant as an optional boolean, defaulted OFF", () => {
    expect(SOURCE).toMatch(/\n\s*primary\?: boolean;/);
    expect(SOURCE).toMatch(/\n\s*primary = false,/);
  });

  it("applies `border-line-strong` only when promoted, and `border-line` otherwise", () => {
    expect(SOURCE).toContain(
      '${primary ? "border-line-strong" : "border-line"}',
    );
    // The one place the field container's edge is decided — no second,
    // unconditional `border-line-strong` that would promote every consumer.
    expect(SOURCE.match(/border-line-strong/g)).toHaveLength(1);
  });

  it("keeps the box, the raised ground and the send affordance the promoted input needs", () => {
    // §I: the chat box keeps all three and takes the line-strong edge.
    expect(SOURCE).toMatch(
      /relative flex items-end gap-1 rounded-control border \$\{primary [^}]*\} bg-surface-strong shadow-sm/,
    );
    expect(SOURCE).toContain("aria-label={pending ? stopAriaLabel : submitAriaLabel}");
  });

  it("emits a conformance id only when the host asks for one", () => {
    expect(SOURCE).toMatch(/\n\s*conformanceId\?: string;/);
    expect(SOURCE).toContain(
      '{...(conformanceId ? { "data-conformance-id": conformanceId } : {})}',
    );
  });
});
