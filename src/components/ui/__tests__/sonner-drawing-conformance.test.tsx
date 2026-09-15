// Sonner (Toaster) — the graded checklist for the components drawing's
// "Toast / Sonner" section (cinatra#3189, shared-primitives wave, leg 1).
//
//   pnpm exec vitest run src/components/ui/__tests__/sonner-drawing-conformance.test.tsx
//
// The section's clauses, quoted verbatim:
//
//   "popover bg"
//   "status-coloured text + border"
//   "5 variants"
//   "icon led"
//   "close + optional copy"
//   "Five variants — default · success · warning · error · info — each on the
//    popover surface with a status-coloured border and matching text; an icon
//    on the left identifies the type. Every toast carries a Copy action and a
//    Close (X) on the right, so the user can grab the message text or dismiss
//    the toast. Never block on a toast; use Dialog when the user must
//    acknowledge. Stack vertically, newest on top."
//
// NO DEPARTURE FOUND.
//
// HOW THIS ONE IS GRADED, and why it differs from its siblings. This primitive
// owns no markup: it configures the `sonner` library, and the clauses it is
// answerable for are carried by the custom properties it hands that library.
// Rendering it proves nothing — with no toast raised, the library emits only a
// bare, unstyled <section>, and the styled container that carries those
// properties never mounts. The properties are therefore read where they are
// declared, which is the form this clause actually makes; this is the same
// source-level grading the `packages/connectors` suites already use in this
// repository for design decisions that live in configuration rather than DOM.
// The two clauses the library's own toast DOM carries (the per-type icon, the
// Copy/Close pair) are marked below with where they really live.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(join(__dirname, "..", "sonner.tsx"), "utf8");

const VARIANTS = ["normal", "success", "warning", "error", "info"] as const;

function declared(variant: string, part: "bg" | "text" | "border") {
  const match = SRC.match(
    new RegExp(`'--${variant}-${part}':\\s*'([^']+)'`),
  );
  return match?.[1] ?? "";
}

describe('clause: "5 variants" / "Five variants — default · success · warning · error · info"', () => {
  it("routes all five variants", () => {
    for (const variant of VARIANTS) {
      expect(
        declared(variant, "bg"),
        `the ${variant} variant is not routed`,
      ).not.toBe("");
    }
  });

  it("routes each of the five with a ground, a text colour and a border", () => {
    for (const variant of VARIANTS) {
      for (const part of ["bg", "text", "border"] as const) {
        expect(
          declared(variant, part),
          `${variant} has no ${part}`,
        ).not.toBe("");
      }
    }
  });
});

describe('clause: "popover bg" / "each on the popover surface"', () => {
  it.each(VARIANTS)("grounds the '%s' toast on the popover surface", (variant) => {
    // Every variant takes the SAME ground — the drawing tints the text and the
    // border, never the surface. A variant whose ground drifted to a status
    // tint would read as an alert, not a toast.
    expect(declared(variant, "bg")).toBe("var(--popover)");
  });
});

describe('clause: "status-coloured text + border" / "a status-coloured border and matching text"', () => {
  it.each(["success", "warning", "error", "info"] as const)(
    "sets '%s' text and border to the SAME status token, which is what 'matching' states",
    (variant) => {
      const text = declared(variant, "text");
      const border = declared(variant, "border");
      expect(text).not.toBe("");
      expect(border).toBe(text);
      expect(text).toMatch(/^var\(--[a-z-]+\)$/);
    },
  );

  it("keeps the default toast on the neutral ink and the row hairline", () => {
    // "default" is one of the five but is not status-coloured; it takes the
    // popover's own foreground and the neutral border.
    expect(declared("normal", "text")).toBe("var(--popover-foreground)");
    expect(declared("normal", "border")).toBe("var(--border)");
  });

  it("draws every status from a design token rather than a literal colour", () => {
    // A hard-coded hex here would not follow the palette into dark mode, which
    // is the failure this routing exists to prevent.
    for (const variant of VARIANTS) {
      for (const part of ["bg", "text", "border"] as const) {
        expect(declared(variant, part)).toMatch(/^var\(--/);
      }
    }
  });

  it("maps error to the brand red and info to the indigo, as the section states", () => {
    expect(declared("error", "text")).toBe("var(--destructive)");
    expect(declared("info", "text")).toBe("var(--info)");
    expect(declared("success", "text")).toBe("var(--success)");
    expect(declared("warning", "text")).toBe("var(--warning)");
  });
});

describe("the palette the toasts render in", () => {
  it("hands the library a theme it actually understands", () => {
    // The product's palette is named "cinatra", which is not one of the three
    // themes the library knows; passing it through leaves every variant's
    // ground undefined and therefore transparent. The component maps it.
    expect(SRC).toContain("resolveSonnerTheme");
    expect(SRC).toMatch(/theme=\{resolveSonnerTheme\(theme\)\}/);
  });
});

describe('clause: "icon led" / "an icon on the left identifies the type"', () => {
  // GRADED IN THE LIBRARY'S OWN DOM, with the reason: the per-type icon is
  // rendered by `sonner` inside each toast when one is raised, not by this
  // component. It is read on the live boot, where a real toast exists to look
  // at ("toast icon", tests/e2e/design/conformance/primitive-wave-leg1.spec.ts).
  it.skip(
    "graded on the boot instead: the per-type icon is drawn by the library inside a raised toast — see primitive-wave-leg1.spec.ts",
    () => {},
  );
});

describe('clause: "close + optional copy" / "Every toast carries a Copy action and a Close (X) on the right"', () => {
  // NOT APPLICABLE at this primitive, with the reason recorded in the
  // component's own source: Copy and Close are injected by the
  // `cinatraToast(...)` wrapper through the library's action and cancel slots,
  // and their PLACEMENT is a rule in src/app/globals.css because the library
  // pins its close control by absolute position and its custom properties can
  // only choose a corner. This component owns the toast's colours.
  it.skip(
    "not applicable at this primitive: Copy and Close are injected by the cinatraToast wrapper and placed by a globals.css rule; this component owns the toast's colours",
    () => {},
  );

  it("leaves the content slot full-width so an action pair has somewhere to sit", () => {
    expect(SRC).toContain("[&_div[data-content]]:w-full");
  });
});

describe('clauses: "Never block on a toast" / "Stack vertically, newest on top"', () => {
  // NOT APPLICABLE at this primitive, with the reason: non-blocking behaviour
  // and stack order are the library's own defaults, and this component
  // overrides neither. "Never block on a toast; use Dialog when the user must
  // acknowledge" is in addition a call-site rule about which primitive to reach
  // for.
  it.skip(
    "not applicable at this primitive: stacking and non-blocking behaviour are the library's defaults, unmodified here; the Dialog-instead rule binds the call site",
    () => {},
  );
});
