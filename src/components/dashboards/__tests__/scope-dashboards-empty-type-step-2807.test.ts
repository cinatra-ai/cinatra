// cinatra#2807 fix leg 5, CONVERGENCE round. The rendering tests assert that the
// empty block's two lines carry `text-scope-empty-title` and
// `text-scope-empty-help`. Those are class-name assertions: they would keep
// passing if the theme tokens behind the utilities were renamed, misspelled or
// deleted, and the drawn type step would silently disappear.
//
// This test pins the OTHER half of that contract — that the stylesheet really
// defines both tokens, at the sizes the ratified load-states drawing gives the
// empty block: a 12.5px/600 headline over an 11px/400 helper. Together the two
// halves prove the step end to end without a browser.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

/** The declared value of a custom property, whitespace-normalized. */
function token(name: string): string | null {
  const m = css.match(new RegExp(`--${name}\\s*:\\s*([^;]+);`));
  return m ? m[1].replace(/\s+/g, " ").trim() : null;
}

describe("the Dashboards empty block's drawn type step is defined in the stylesheet", () => {
  it("defines the headline token at the drawn 12.5px", () => {
    const v = token("text-scope-empty-title");
    expect(v).not.toBeNull();
    expect(v).toContain("12.5px");
  });

  it("defines the helper token at the drawn 11px", () => {
    const v = token("text-scope-empty-help");
    expect(v).not.toBeNull();
    expect(v).toContain("11px");
  });

  it("keeps the two a real STEP apart, not the same size twice", () => {
    // The fourth proof round graded 12px over 12px — no step at all. Whatever
    // the tokens hold, they must not collapse back to one size.
    expect(token("text-scope-empty-title")).not.toEqual(
      token("text-scope-empty-help"),
    );
  });

  it("is named the way the sibling scope token already is", () => {
    // `--text-scope-caption` is the established precedent; the empty block's
    // tokens join that family rather than inventing a second naming scheme.
    expect(token("text-scope-caption")).not.toBeNull();
  });
});
