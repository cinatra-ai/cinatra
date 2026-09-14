// @vitest-environment jsdom
//
// Alert — the graded checklist for the components drawing's
// "Alert / Alert dialog" section (cinatra#3189, shared-primitives wave, leg 1).
//
//   pnpm exec vitest run src/components/ui/__tests__/alert-drawing-conformance.test.tsx
//
// The section's clauses, quoted verbatim:
//
//   "tinted bg + border"
//   "12–14px text"
//   "icon-led"
//   "destructive = red"
//   "Inline alerts for warnings and errors; AlertDialog for destructive
//    confirmations. Use the destructive variant (red) for terminal failures,
//    warning (mustard) for cautions, info (indigo) for neutral notices."
//
// Structure and the variant set are asserted here; the colour and type-scale
// values the clauses name are read as computed styles on the live boot in
// tests/e2e/design/conformance/primitive-wave-leg1.spec.ts, under the app's own
// palette (this wave's method note of 2026-09-01).
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

afterEach(cleanup);

type Variant = "default" | "destructive" | "warning" | "success" | "info";

function renderAlert(variant?: Variant, withIcon = true) {
  const { container } = render(
    <Alert variant={variant}>
      {withIcon ? (
        <svg aria-hidden="true" data-testid="alert-icon" viewBox="0 0 24 24" />
      ) : null}
      <AlertTitle>Approval expired.</AlertTitle>
      <AlertDescription>The hold window closed at 15:30.</AlertDescription>
    </Alert>,
  );
  const alert = container.querySelector('[data-slot="alert"]') as HTMLElement;
  return { container, alert };
}

describe('clause: "tinted bg + border"', () => {
  it.each(["destructive", "warning", "success", "info"] as const)(
    "draws the %s alert on a tint of its own colour with a border at a higher alpha",
    (variant) => {
      const { alert } = renderAlert(variant);
      const cls = alert.className;
      // The ground is the status colour at 10%, the stroke the same colour at
      // 30% — a tint plus a border, never a solid fill. The computed rgba pair
      // is read on the boot ("alert tint", primitive-wave-leg1.spec.ts).
      expect(cls).toContain(`bg-${variant}/10`);
      expect(cls).toContain(`border-${variant}/30`);
    },
  );

  it("draws the neutral alert on the card surface with the shared hairline", () => {
    const { alert } = renderAlert("default");
    expect(alert.className).toContain("bg-card");
    // The base recipe carries a plain `border`, so the stroke is the default
    // border token rather than a status tint.
    expect(alert.className).toContain("border");
  });
});

describe('clause: "12–14px text"', () => {
  it("sets the alert body at the 14px step, the top of the stated band", () => {
    const { alert } = renderAlert();
    expect(alert.className).toContain("text-sm");
  });

  it("keeps the description on the same step rather than stepping it down", () => {
    const { container } = renderAlert();
    const description = container.querySelector(
      '[data-slot="alert-description"]',
    ) as HTMLElement;
    expect(description.className).toContain("text-sm");
  });

  it("leaves the title on the inherited step so it cannot leave the band", () => {
    const { container } = renderAlert();
    const title = container.querySelector(
      '[data-slot="alert-title"]',
    ) as HTMLElement;
    // No `text-*` step of its own — the title inherits the root's 14px. The
    // measured px value is read on the boot.
    expect(/(^|\s)text-(xs|sm|base|lg|xl)(\s|$)/.test(title.className)).toBe(false);
  });
});

describe('clause: "icon-led"', () => {
  it("opens an icon column the moment an icon is present", () => {
    const { alert } = renderAlert("info", true);
    expect(alert.querySelector('[data-testid="alert-icon"]')).not.toBeNull();
    expect(alert.className).toContain(
      "has-[>svg]:grid-cols-[calc(var(--spacing)*4)_1fr]",
    );
  });

  it("collapses the icon column to zero when the caller leads with text", () => {
    const { alert } = renderAlert("info", false);
    expect(alert.querySelector("svg")).toBeNull();
    expect(alert.className).toContain("grid-cols-[0_1fr]");
  });

  it("puts the title and the description in the text column, beside the icon", () => {
    const { container } = renderAlert();
    const title = container.querySelector('[data-slot="alert-title"]') as HTMLElement;
    const description = container.querySelector(
      '[data-slot="alert-description"]',
    ) as HTMLElement;
    expect(title.className).toContain("col-start-2");
    expect(description.className).toContain("col-start-2");
  });
});

describe('clause: "destructive = red"', () => {
  it("colours the destructive alert's type, icon and stroke from the destructive token", () => {
    const { alert } = renderAlert("destructive");
    const cls = alert.className;
    expect(cls).toContain("text-destructive");
    expect(cls).toContain("[&>svg]:text-destructive");
    expect(cls).toContain("border-destructive/30");
  });
});

describe('clause: "the destructive variant (red) for terminal failures, warning (mustard) for cautions, info (indigo) for neutral notices."', () => {
  it("names all three roles the sentence asks for, each on its own colour", () => {
    for (const variant of ["destructive", "warning", "info"] as const) {
      const { alert } = renderAlert(variant);
      expect(alert.className).toContain(`text-${variant}`);
    }
  });

  it("announces itself to assistive technology as an alert", () => {
    const { alert } = renderAlert("warning");
    expect(alert.getAttribute("role")).toBe("alert");
  });
});
