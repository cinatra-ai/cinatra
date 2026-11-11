// @vitest-environment jsdom
//
// The Extensions lifecycle states are marked text, not Badges (cinatra#4296).
// The Extensions drawing's "Example — lifecycle status" draws Active, Locked
// and Archived as mono uppercase text with a mark: "A green check marks an
// Active extension; a green lock marks a Locked system extension …; a grey
// cross marks an Archived one." The application drawing's marketplace approval
// states block hands these chips to Extensions: "they stay drawn on
// Extensions, which owns that surface."
//
// The Extensions card already draws that chip (InstalledStatusIndicator).
// LifecycleBadges, the Extensions package's chip row, must draw the same chip
// for its lifecycle entries. The chips that are not lifecycle states
// (Required, source, version) stay Badges, and LifecycleBadge — the roster
// pill wrapper used on Projects, Organizations and service accounts — stays
// on the roster pill.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import type { InstalledExtension } from "@cinatra-ai/extensions/canonical-types";
import { LifecycleBadges } from "@cinatra-ai/extensions/components/lifecycle-badges";
import { LifecycleBadge } from "@/components/lifecycle-badge";

afterEach(cleanup);

const VERSION = "1.2.3";

function ext(over: Partial<InstalledExtension> = {}): InstalledExtension {
  return {
    id: "id",
    packageName: "@cinatra-ai/foo-agent",
    ownerLevel: "platform",
    ownerId: null,
    organizationId: null,
    kind: "agent",
    status: "active",
    source: {
      type: "verdaccio",
      registryUrl: "x",
      packageName: "@cinatra-ai/foo-agent",
      version: VERSION,
      integrity: "sha",
    },
    requiredInProd: false,
    dependencies: [],
    manifestHash: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as InstalledExtension;
}

describe("LifecycleBadges draws the lifecycle state as the Extensions marked text", () => {
  it.each(["locked", "archived"] as const)("draws '%s' as the Extensions status chip, not a Badge", (status) => {
    const { container } = render(<LifecycleBadges extension={ext({ status })} />);
    const chip = container.querySelector<HTMLElement>('[data-slot="installed-status-indicator"]');
    expect(chip, `${status} draws no Extensions status chip`).not.toBeNull();
    expect(chip!.getAttribute("data-status")).toBe(status);
    expect(chip!.className).toContain("font-mono");
    expect(chip!.className).toContain("uppercase");
    expect(chip!.querySelector("svg")).not.toBeNull();
    const badgeTexts = Array.from(container.querySelectorAll('[data-slot="badge"]')).map((b) => b.textContent);
    expect(badgeTexts).not.toContain(status === "locked" ? "Locked" : "Archived");
  });

  it("draws Locked in the live green and Archived in the muted ink, as the drawing does", () => {
    const locked = render(<LifecycleBadges extension={ext({ status: "locked" })} />).container;
    expect(locked.querySelector('[data-slot="installed-status-indicator"]')!.className).toContain("text-success");
    cleanup();
    const archived = render(<LifecycleBadges extension={ext({ status: "archived" })} />).container;
    expect(archived.querySelector('[data-slot="installed-status-indicator"]')!.className).toContain(
      "text-muted-foreground",
    );
  });

  it("keeps Required, source and version as Badges (they are not lifecycle states)", () => {
    const { container } = render(
      <LifecycleBadges extension={ext({ status: "locked", requiredInProd: true })} />,
    );
    const badgeTexts = Array.from(container.querySelectorAll('[data-slot="badge"]')).map((b) => b.textContent);
    expect(badgeTexts).toEqual(["Required", "Verdaccio", `v${VERSION}`]);
  });
});

describe("LifecycleBadge outside Extensions stays on the roster pill", () => {
  it("still draws Archived as the roster status pill", () => {
    const { container } = render(<LifecycleBadge status="archived" />);
    // LifecycleBadge renames the pill's slot to its own; the pill shows through
    // its status attribute and glyph attribute.
    const pill = container.querySelector('[data-lifecycle="archived"]');
    expect(pill).not.toBeNull();
    expect(pill!.getAttribute("data-status")).toBe("archived");
    expect(pill!.getAttribute("data-glyph")).toBe("icon");
    expect(container.querySelector('[data-slot="installed-status-indicator"]')).toBeNull();
  });
});
