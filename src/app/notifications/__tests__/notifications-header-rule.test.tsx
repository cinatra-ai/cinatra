/** @vitest-environment jsdom */

// ---------------------------------------------------------------------------
// /notifications v2 — single-etched-rule regression (S3 hardening).
//
// The notifications design spec's §I ("no closing rule of its own — the
// toolbar below replaces it") and the shared Toolbar component's own contract
// ("REPLACES the section rule for that view; pair with <PageHeader
// divider={false}>") both forbid stacking the PageHeader's etched
// `.divider-etched` rule on top of the toolbar's own hairline chrome.
// `page.tsx` opts out via `divider={false}` — this test proves that flag
// actually suppresses `<PageHeaderRule>` (regression guard against a future
// PageHeader/PageHeaderRule refactor silently reintroducing it) and proves
// the page source still passes it.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PageHeader } from "@/components/page-header";

describe("notifications PageHeader — single etched rule (S3 hardening)", () => {
  it("divider={false} renders no .divider-etched separator", () => {
    const html = renderToString(
      PageHeader({
        title: "Notifications",
        description:
          "Everything that needs your attention — updates and pending approvals, newest first.",
        divider: false,
        className: "max-w-3xl",
      }),
    );
    expect(html).not.toContain("divider-etched");
  });

  it("the notifications page source pins divider={false} on its PageHeader (no double rule against the toolbar)", () => {
    const source = readFileSync(join(__dirname, "..", "page.tsx"), "utf8");
    // [^>]* keeps the match inside the single opening tag — the prop must sit
    // on the PageHeader element itself, not merely somewhere later in the file.
    expect(source).toMatch(/<PageHeader\b[^>]*divider=\{false\}/);
  });
});
