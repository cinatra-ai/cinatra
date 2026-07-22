/**
 * <ScopeBadge ownerName> (cinatra#1905): the canonical ownership badge names
 * the OWNING entity — "LEVEL — Name" inside the same pill — while:
 *   - level-only output stays byte-identical when no name is passed
 *   - the name renders in a nested normal-case span (the pill's uppercase/
 *     tracking styling applies to the level word only)
 *   - `children` still overrides everything (the skills call sites pass
 *     children={skill.level} and must keep rendering exactly that)
 *   - whitespace-only names are treated as absent, and names are trimmed
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ScopeBadge } from "../scope-badge";

describe("ScopeBadge ownerName (#1905)", () => {
  it("renders level-only exactly as before when no ownerName is passed", () => {
    const html = renderToStaticMarkup(<ScopeBadge level="team" />);
    expect(html).toContain(">team</span>");
    expect(html).not.toContain("—");
  });

  it("renders LEVEL — Name with the name in a normal-case span", () => {
    const html = renderToStaticMarkup(
      <ScopeBadge level="team" ownerName="Best Team Ever" />,
    );
    expect(html).toContain("team");
    expect(html).toMatch(/<span class="normal-case tracking-normal">— Best Team Ever<\/span>/);
    // The pill keeps its data contract.
    expect(html).toContain('data-slot="scope-badge"');
    expect(html).toContain('data-level="team"');
  });

  it("trims the name and treats whitespace-only as absent", () => {
    const trimmed = renderToStaticMarkup(
      <ScopeBadge level="organization" ownerName="  Acme Inc  " />,
    );
    expect(trimmed).toContain("— Acme Inc</span>");
    expect(trimmed).not.toContain("Acme Inc  ");

    const blank = renderToStaticMarkup(<ScopeBadge level="organization" ownerName="   " />);
    expect(blank).toContain(">organization</span>");
    expect(blank).not.toContain("—");
  });

  it("children still override everything (skills contract)", () => {
    const html = renderToStaticMarkup(
      <ScopeBadge level="team" ownerName="Ignored Name">
        custom
      </ScopeBadge>,
    );
    expect(html).toContain(">custom</span>");
    expect(html).not.toContain("Ignored Name");
  });
});
