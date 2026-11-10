// @vitest-environment jsdom
//
// The roster pills the marketplace approval states reuse, graded against the
// approved drawing (design main 0eb4ba18, cinatra#4296):
//
//   specs/app.html, the pill recipes:
//     .pill.hold { background: rgba(199,149,69,0.16); color: var(--mustard-ink);
//                  border-color: rgba(199,149,69,0.42); }
//     .pill.hold .dot { background: var(--logo); }
//     .pill.idle { background: transparent; color: var(--muted);
//                  border-color: var(--line-strong); }
//   specs/app.html, the pill roster and block V.1:
//     Archived = `pill idle` at opacity 0.7, an archive box, stroke 2.4
//                (paths "M21 8v13H3V8" and "M1 3h22v5H1z");
//     Declined = `pill failed`, a trash can, stroke 2.8
//                (paths "M3 6h18", "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",
//                "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6");
//     Failed   = `pill failed`, a cross, stroke 3.
//   specs/app-extensions.html, "Example — lifecycle status":
//     Locked = a lock at stroke 2.4; Active (check) and Archived (cross) at 3.
//
// The app's `--warning` is the drawing's `--logo` mustard (#c79545), and its
// `--mustard-ink` and `--line-strong` are the drawing's tokens of those names.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { StatusPill, type StatusPillStatus } from "@/components/ui/status-pill";
import { InstalledStatusIndicator } from "@/components/extensions/installed-status-indicator";
import { LifecycleBadges } from "@cinatra-ai/extensions/components/lifecycle-badges";
import type { InstalledExtension } from "@cinatra-ai/extensions/canonical-types";

afterEach(cleanup);

function pill(status: StatusPillStatus, glyph: "icon" | "dot" = "icon"): HTMLElement {
  const { container } = render(
    <StatusPill status={status} glyph={glyph}>
      Label
    </StatusPill>,
  );
  return container.firstElementChild as HTMLElement;
}

function classes(el: Element): string[] {
  return (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

function paths(el: Element): string[] {
  return Array.from(el.querySelectorAll("svg path")).map((p) => p.getAttribute("d") ?? "");
}

const BOX = ["M21 8v13H3V8", "M1 3h22v5H1z"];
const TRASH = ["M3 6h18", "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2", "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"];
const CROSS = ["M18 6 6 18", "m6 6 12 12"];

describe("glyph geometry of the roster pills", () => {
  it("Archived draws the archive box at stroke 2.4, never the cross", () => {
    const p = pill("archived");
    expect(paths(p)).toEqual(BOX);
    expect(p.querySelector("svg")!.getAttribute("stroke-width")).toBe("2.4");
  });

  it("Declined draws the trash can at stroke 2.8, never the cross", () => {
    const p = pill("declined");
    expect(paths(p)).toEqual(TRASH);
    expect(p.querySelector("svg")!.getAttribute("stroke-width")).toBe("2.8");
  });

  it("Failed keeps the cross at stroke 3", () => {
    const p = pill("failed");
    expect(paths(p)).toEqual(CROSS);
    expect(p.querySelector("svg")!.getAttribute("stroke-width")).toBe("3");
  });

  it("each glyph is drawn at 10px (h-2.5 w-2.5), as the roster sizes them", () => {
    for (const status of ["archived", "declined"] as StatusPillStatus[]) {
      expect(classes(pill(status).querySelector("svg")!)).toEqual(expect.arrayContaining(["h-2.5", "w-2.5"]));
      cleanup();
    }
  });
});

describe("the pending pill's tokens (hold and idle)", () => {
  it("hold: the mustard tint at 16%, its border at 42%, the mustard ink", () => {
    const cls = classes(pill("hold"));
    expect(cls).toEqual(expect.arrayContaining(["bg-warning/16", "border-warning/42", "text-mustard-ink"]));
    expect(cls).not.toContain("text-warning");
    expect(cls).not.toContain("border-warning/30");
  });

  it("hold's dot is the mustard, not the ink", () => {
    const dot = pill("hold", "dot").querySelector('[data-slot="status-pill-dot"]')!;
    expect(classes(dot)).toContain("bg-warning");
    expect(classes(dot)).not.toContain("bg-current");
  });

  it("idle: no ground, the muted ink, the strong line", () => {
    const cls = classes(pill("idle"));
    expect(cls).toEqual(expect.arrayContaining(["bg-transparent", "text-muted-foreground", "border-line-strong"]));
    expect(cls).not.toContain("border-line");
  });

  it("idle's dot takes the muted ink of its label", () => {
    const dot = pill("idle", "dot").querySelector('[data-slot="status-pill-dot"]')!;
    expect(classes(dot)).toContain("bg-current");
  });

  it.each(["archived", "withdrawn", "reset"] as StatusPillStatus[])(
    "'%s' is drawn as `pill idle` and takes the strong line too",
    (status) => {
      const cls = classes(pill(status));
      expect(cls).toEqual(expect.arrayContaining(["bg-transparent", "text-muted-foreground", "border-line-strong"]));
      expect(cls).not.toContain("border-line");
    },
  );

  it("Archived keeps its 0.7 opacity", () => {
    expect(classes(pill("archived"))).toContain("opacity-70");
  });
});

describe("the Extensions lifecycle chip strokes", () => {
  function stroke(status: "active" | "locked" | "archived"): string | null {
    const { container } = render(<InstalledStatusIndicator status={status} />);
    return container.querySelector("svg")!.getAttribute("stroke-width");
  }

  it("Locked draws its lock at stroke 2.4", () => {
    expect(stroke("locked")).toBe("2.4");
  });

  it.each(["active", "archived"] as const)("%s keeps stroke 3", (status) => {
    expect(stroke(status)).toBe("3");
  });

  it("the Extensions chip row (LifecycleBadges) draws Locked at stroke 2.4", () => {
    const ext = {
      id: "id",
      packageName: "@cinatra-ai/foo-agent",
      ownerLevel: "platform",
      ownerId: null,
      organizationId: null,
      kind: "agent",
      status: "locked",
      source: { type: "verdaccio", registryUrl: "x", packageName: "@cinatra-ai/foo-agent", version: "1.0.0", integrity: "sha" },
      requiredInProd: false,
      dependencies: [],
      manifestHash: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as InstalledExtension;
    const { container } = render(<LifecycleBadges extension={ext} />);
    const chip = container.querySelector('[data-slot="installed-status-indicator"][data-status="locked"]');
    expect(chip, "LifecycleBadges draws no Locked chip").not.toBeNull();
    expect(chip!.querySelector("svg")!.getAttribute("stroke-width")).toBe("2.4");
  });
});
