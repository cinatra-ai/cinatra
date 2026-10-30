// @vitest-environment jsdom
//
// Chrome face (cinatra#4289): the components drawing sets its interface
// chrome in its sans face, `--font-sans: "Archivo"`, commented "UI chrome"
// (specs/app-components.html:41). The application's own `--font-sans` is
// Inter for body text, and Archivo is the `--font-display` token, applied
// through the `font-display` utility (src/app/globals.css). Each primitive
// below is drawn with the drawing's sans face, so each one carries
// `font-display`:
//
//   status pill      `.pill`  font-family: var(--font-sans); 12px; 600   (:216)
//   Button           `.btn`   font: 500 13px var(--font-sans)            (:234)
//   toolbar buttons  inline   font: 500 12.5px var(--font-sans)          (:486)
//
//   pnpm exec vitest run src/components/ui/__tests__/chrome-face-archivo-4289.test.tsx
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { StatusPill } from "@/components/ui/status-pill";
import { Button } from "@/components/ui/button";
import { Toolbar, ToolbarButton, ToolbarGroup } from "@/components/ui/toolbar";

afterEach(cleanup);

describe("cinatra#4289: chrome primitives take the drawing's Archivo face", () => {
  it("sets the status pill in the display face (Archivo)", () => {
    const { container } = render(<StatusPill status="running">Running</StatusPill>);
    const pill = container.firstElementChild as HTMLElement;
    expect(pill.className).toContain("font-display");
    expect(pill.className).not.toContain("font-mono");
  });

  it("sets the Button in the display face (Archivo)", () => {
    const { getByRole } = render(<Button>Save</Button>);
    const cls = getByRole("button").className;
    expect(cls).toContain("font-display");
    expect(cls).not.toContain("font-mono");
  });

  it("sets the toolbar button in the display face (Archivo)", () => {
    const { getByRole } = render(
      <Toolbar>
        <ToolbarGroup>
          <ToolbarButton active>All</ToolbarButton>
        </ToolbarGroup>
      </Toolbar>,
    );
    const cls = getByRole("button", { name: "All" }).className;
    expect(cls).toContain("font-display");
    expect(cls).not.toContain("font-mono");
  });

  it("sets an asChild toolbar button (a link) in the display face (Archivo)", () => {
    const { getByRole } = render(
      <Toolbar>
        <ToolbarButton asChild>
          <a href="/upload">Upload</a>
        </ToolbarButton>
      </Toolbar>,
    );
    expect(getByRole("link", { name: "Upload" }).className).toContain("font-display");
  });
});
