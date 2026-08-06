import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Bell badge — spec §IV treatment contract (cinatra#2460).
//
// The ratified notifications design spec (app-notifications.html §IV "The
// bell — badge + link, no flyout", `.bell .badge`) pins the bell count badge
// to ONE treatment: a solid red pill (`background: var(--red)`) with light
// text (`color: var(--surface-strong)`), mono bold digits, 16px min geometry,
// and a 2px page-background ring (`box-shadow: 0 0 0 2px var(--paper)`). In
// app tokens that is `bg-destructive` (--destructive = --cinatra-red = the
// spec's --red #a6384f, theme-invariant) with `text-attention-foreground`
// (the :root-only ALWAYS-WHITE invariant — deliberately NOT the theme-varying
// --destructive-foreground, and NOT --surface-strong which flips dark in dark
// mode) and `ring-background` (--background = the spec's --paper).
//
// The treatment lives at the CALL SITE, not as a Badge variant: badge.tsx is
// a design-registry primitive vendored byte-for-byte into companion extension
// repos (vendor-extension-primitives provenance gate), so changing it
// obligates the multi-repo re-vendor choreography. This suite pins both the
// call-site treatment AND badge.tsx staying variant-free of it.
//
// Same source-contract style as scope-badge.test.tsx: these assertions pin
// the class treatment at the source seam, where a jsdom render would only
// re-serialize the identical strings.
// ---------------------------------------------------------------------------

const providerSrc = readFileSync(
  path.join(
    __dirname,
    "../../../../packages/notifications/src/notifications-provider.tsx",
  ),
  "utf8",
);

const badgeSrc = readFileSync(
  path.join(__dirname, "../../../components/ui/badge.tsx"),
  "utf8",
);

const fixtureSrc = readFileSync(
  path.join(
    __dirname,
    "../../../app/design-fixtures/conformance/notifications-conformance-fixtures.tsx",
  ),
  "utf8",
);

const globalsSrc = readFileSync(
  path.join(__dirname, "../../../app/globals.css"),
  "utf8",
);

const BELL_BADGE_CALL = /<Badge className="([^"]+)">/;

describe("NotificationsBellTrigger badge — steady-state count (spec §IV)", () => {
  const classes = providerSrc.match(BELL_BADGE_CALL)?.[1];

  it("renders the count as the SOLID red pill with the invariant always-white text", () => {
    expect(classes).toBeDefined();
    expect(classes).toContain("bg-destructive");
    expect(classes).toContain("text-attention-foreground");
    // The solid fill, never the tinted status treatment.
    expect(classes).not.toContain("bg-destructive/10");
    // Never the primary (navy) fill this fix removes.
    expect(classes).not.toContain("bg-primary");
  });

  it("carries the §IV geometry + type: 16px pill, mono bold digits, 4px x-padding", () => {
    expect(classes).toContain("h-4");
    expect(classes).toContain("min-w-4");
    expect(classes).toContain("px-1");
    expect(classes).toContain("font-mono");
    expect(classes).toContain("font-bold");
    expect(classes).toContain("text-badge-xs");
  });

  it("carries the §IV ring: box-shadow 0 0 0 2px var(--paper) → ring-2 ring-background", () => {
    expect(classes).toContain("ring-2 ring-background");
  });

  it("overrides the default variant's primary hover inside the bell link", () => {
    // The badge sits inside the bell <a>; without this the default variant's
    // `[a]:hover:bg-primary/80` survives tailwind-merge and flashes blue.
    expect(classes).toContain("[a]:hover:bg-destructive/80");
  });

  it("stays anchored top-right of the bell and keeps the 99+ clamp", () => {
    expect(classes).toContain("absolute -right-1 -top-1");
    expect(providerSrc).toMatch(/totalForBadge > 99 \? "99\+" : totalForBadge/);
  });
});

describe("`--attention-foreground` token — always white in BOTH themes (PR #2472 review)", () => {
  it("is defined exactly once (:root only — no .cinatra/.dark theme override may exist)", () => {
    // The digit on the solid red pill must NEVER flip with the theme. The
    // token is theme-invariant by CONSTRUCTION: a single :root definition and
    // zero per-theme overrides. A second definition anywhere in globals.css
    // (e.g. inside `.dark`) would reintroduce the flip this pins against.
    const definitions = globalsSrc.match(/^\s*--attention-foreground:/gm) ?? [];
    expect(definitions).toHaveLength(1);
  });

  it("is white", () => {
    expect(globalsSrc).toMatch(/--attention-foreground:\s*#ffffff;/);
  });

  it("is bound to the text-attention-foreground utility via @theme", () => {
    expect(globalsSrc).toMatch(
      /--color-attention-foreground:\s*var\(--attention-foreground\);/,
    );
  });

  it("the red fill it sits on is itself theme-invariant (--destructive = --cinatra-red in every theme block)", () => {
    // Every block that defines --destructive must map it to the invariant
    // brand red — never a per-theme red variant.
    const fills = globalsSrc.match(/^\s*--destructive:\s*(.+);/gm) ?? [];
    expect(fills.length).toBeGreaterThan(0);
    for (const line of fills) {
      expect(line).toContain("var(--cinatra-red)");
    }
    const reds = globalsSrc.match(/^\s*--cinatra-red:\s*(.+);/gm) ?? [];
    expect(reds.length).toBeGreaterThan(0);
    for (const line of reds) {
      expect(line).toContain("#a6384f");
    }
  });
});

describe("badge.tsx stays a vendored primitive without the attention treatment", () => {
  it("carries NO attention variant (vendored byte-for-byte into companion repos — provenance-gated)", () => {
    // Re-adding the treatment as a Badge variant would re-trip the
    // vendor-extension-primitives provenance gate across every companion
    // extension repo that vendors badge.tsx. The treatment lives at the bell
    // call site instead.
    expect(badgeSrc).not.toContain("attention");
  });

  it("keeps the tinted `destructive` status variant unchanged (distinct treatment)", () => {
    expect(badgeSrc).toMatch(/destructive:\s*\n?\s*"bg-destructive\/10 text-destructive/);
  });
});

describe("NotificationsBellTrigger badge — error state is retired (spec §IV)", () => {
  it("no longer branches the treatment on error-kind unread rows (§IV defines ONE treatment)", () => {
    // The pre-#2460 bell flipped to the TINTED `destructive` variant when any
    // unread row was kind === "error" — a per-kind bell variant §IV does not
    // define, and (post-fix) a WEAKER treatment than the steady state. Error
    // semantics live on the /notifications rows, not on the bell.
    expect(providerSrc).not.toContain("unreadHasError");
    expect(providerSrc).not.toMatch(/variant=\{[^}]*\?/);
    expect(providerSrc).not.toMatch(/variant="destructive"/);
  });
});

describe("§IV conformance fixture parity (notifications-bell)", () => {
  it("the harness bell example renders the SAME Badge treatment as the live trigger", () => {
    const live = providerSrc.match(BELL_BADGE_CALL);
    const fixture = fixtureSrc.match(BELL_BADGE_CALL);
    expect(live).not.toBeNull();
    expect(fixture).not.toBeNull();
    expect(fixture![1]).toBe(live![1]);
  });
});
