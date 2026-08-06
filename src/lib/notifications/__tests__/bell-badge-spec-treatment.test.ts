import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Bell badge — spec §IV treatment contract (cinatra#2460).
//
// The ratified notifications spec (cinatra-ai/design
// specs/app-notifications.html §IV "The bell — badge + link, no flyout",
// `.bell .badge`) pins the bell count badge to ONE treatment: a solid red pill
// (`background: var(--red)`) with light text (`color: var(--surface-strong)`),
// mono bold digits, 16px min geometry, and a 2px page-background ring
// (`box-shadow: 0 0 0 2px var(--paper)`). In app tokens that is
// `bg-destructive` (--destructive = --cinatra-red = the spec's --red #a6384f)
// with `text-destructive-foreground` (light in BOTH themes — the app's own
// --surface-strong flips dark in dark mode, so it is NOT the right text
// token) and `ring-background` (--background = the spec's --paper).
//
// Same source-contract style as scope-badge.test.tsx: these assertions pin the
// class treatment at the source seam, where a jsdom render would only re-serialize
// the identical strings.
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

describe("Badge `attention` variant (design system seam)", () => {
  it("defines a SOLID red variant with light foreground (not a tint)", () => {
    expect(badgeSrc).toMatch(
      /attention:\s*\n?\s*"bg-destructive text-destructive-foreground/,
    );
  });

  it("keeps the tinted `destructive` status variant unchanged (distinct treatment)", () => {
    expect(badgeSrc).toMatch(/destructive:\s*\n?\s*"bg-destructive\/10 text-destructive/);
  });

  it("dims within links via the solid-variant hover pattern, never the primary hover", () => {
    expect(badgeSrc).toMatch(/attention:[\s\S]{0,200}\[a\]:hover:bg-destructive\/80/);
  });
});

describe("NotificationsBellTrigger badge — steady-state count (spec §IV)", () => {
  it("renders the count with the solid-red `attention` variant, not `default`/bg-primary", () => {
    expect(providerSrc).toMatch(/variant="attention"/);
  });

  it("carries the §IV geometry + type: 16px pill, mono bold digits, 4px x-padding", () => {
    const badgeCall = providerSrc.match(
      /<Badge\s+variant="attention"\s+className="([^"]+)"/,
    );
    expect(badgeCall).not.toBeNull();
    const classes = badgeCall![1];
    expect(classes).toContain("h-4");
    expect(classes).toContain("min-w-4");
    expect(classes).toContain("px-1");
    expect(classes).toContain("font-mono");
    expect(classes).toContain("font-bold");
    expect(classes).toContain("text-badge-xs");
  });

  it("carries the §IV ring: box-shadow 0 0 0 2px var(--paper) → ring-2 ring-background", () => {
    expect(providerSrc).toMatch(
      /variant="attention"[\s\S]{0,200}ring-2 ring-background/,
    );
  });

  it("stays anchored top-right of the bell and keeps the 99+ clamp", () => {
    expect(providerSrc).toMatch(
      /variant="attention"[\s\S]{0,200}absolute -right-1 -top-1/,
    );
    expect(providerSrc).toMatch(/totalForBadge > 99 \? "99\+" : totalForBadge/);
  });
});

describe("NotificationsBellTrigger badge — error state is retired (spec §IV)", () => {
  it("no longer branches the variant on error-kind unread rows (§IV defines ONE treatment)", () => {
    // The pre-#2460 bell flipped to the TINTED `destructive` variant when any
    // unread row was kind === "error" — a per-kind bell variant §IV does not
    // define, and (post-fix) a WEAKER treatment than the steady state. Error
    // semantics live on the /notifications rows, not on the bell.
    expect(providerSrc).not.toContain("unreadHasError");
    expect(providerSrc).not.toMatch(/variant=\{[^}]*\?/);
    expect(providerSrc).not.toMatch(/variant="destructive"/);
    expect(providerSrc).not.toMatch(/variant="default"/);
  });
});

describe("§IV conformance fixture parity (notifications-bell)", () => {
  it("the harness bell example renders the SAME Badge treatment as the live trigger", () => {
    const live = providerSrc.match(
      /<Badge\s+variant="attention"\s+className="([^"]+)"/,
    );
    const fixture = fixtureSrc.match(
      /<Badge\s+variant="attention"\s+className="([^"]+)"/,
    );
    expect(live).not.toBeNull();
    expect(fixture).not.toBeNull();
    expect(fixture![1]).toBe(live![1]);
  });
});
