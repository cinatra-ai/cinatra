/**
 * ExtensionCompatBadge — the 3-state in-instance ABI compatibility badge.
 * The critical invariant: the badge NEVER renders the green "success" variant
 * for an undeclared (unknown) range — it would over-promise "Compatible" for an
 * extension that made no ABI claim.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ExtensionCompatBadge } from "../extension-compat-badge";

function render(range: string | null | undefined): string {
  return renderToStaticMarkup(<ExtensionCompatBadge sdkAbiRange={range} />);
}

describe("ExtensionCompatBadge", () => {
  it("renders the green success Compatible badge for a satisfied declared range", () => {
    const html = render("^2");
    expect(html).toContain('data-compat-state="compatible"');
    expect(html).toContain('data-variant="success"');
    expect(html).toContain("Compatible");
  });

  it("renders the destructive Incompatible badge for an unsatisfied declared range", () => {
    const html = render("^1");
    expect(html).toContain('data-compat-state="incompatible"');
    expect(html).toContain('data-variant="destructive"');
    expect(html).toContain("Incompatible");
  });

  it("renders the neutral outline Unknown badge for an undeclared range", () => {
    const html = render(null);
    expect(html).toContain('data-compat-state="unknown"');
    expect(html).toContain('data-variant="outline"');
    expect(html).toContain("Unknown");
  });

  it.each([null, undefined, "", "   "])(
    "NEVER renders the green success variant for an undeclared range (%j)",
    (range) => {
      const html = render(range);
      expect(html).not.toContain('data-variant="success"');
      expect(html).not.toContain("Compatible");
    },
  );

  it("a malformed declared range is destructive (fail closed), never green or unknown", () => {
    const html = render("garbage-range");
    expect(html).toContain('data-variant="destructive"');
    expect(html).not.toContain('data-variant="success"');
    expect(html).not.toContain('data-compat-state="unknown"');
  });
});
