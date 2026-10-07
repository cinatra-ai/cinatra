// THE SHARED RENDERER'S SHAPE FIXES, AND WHAT THEY MAY COST (cinatra#2934, W5c).
//
// The renderer draws text a model wrote, and a model's text is untrusted: the
// window replays whatever came back from a provider that a prompt injection may
// be steering. So the cost of drawing it has to depend on how LONG the text is
// and not on what it says — a shape fix that gets slower the more of one
// character it is handed is a way to stop the screen from a message.
//
// Two of them were:
//
//   · the simplified-table fix was a repetition nested inside a repetition —
//     one row's `[^\n]+` could take the pipe another row's iteration wanted, so
//     a run of table-looking lines could be divided between the iterations in a
//     great many ways, each of which the engine may try;
//   · the empty-paragraph strip let its attribute run cross a `<`, so an
//     opening `<p` with no `>` after it kept scanning through every later `<p`.
//     MEASURED on this head, before the repair, with `"<p".repeat(n)`:
//     4 000 characters 3 ms, 16 000 characters 52 ms, 64 000 characters 799 ms
//     — four times the text for sixteen times the work, which is the square.
//     After the repair the same 64 000 characters, and four times more again,
//     are under a millisecond.
//
// The budgets below are deliberately far above what the repaired code takes
// (single-digit milliseconds) and far below what the old shapes took, so the
// assertion is about the SHAPE of the cost and cannot fail on a slow runner.
import { describe, expect, it } from "vitest";

import { normalizeCoreMarkdown, stripEmptyParagraphs } from "../markdown-render-core";
import { renderRunWindowMarkdown } from "../run-window-markdown";

/** The wall-clock cost of one call, in milliseconds. */
function millis(work: () => void): number {
  const started = performance.now();
  work();
  return performance.now() - started;
}

describe("the shared renderer's shape fixes", () => {
  it("gives a model's separator-less pipe table the separator markdown needs", () => {
    const drawn = renderRunWindowMarkdown(
      "Here it is:\n\nField | Value\nIdea | A weekly publishing rhythm\nTone | Plain",
    );
    expect(drawn).toContain("<table");
    expect((drawn.match(/<th /g) ?? []).length).toBe(2);
    expect((drawn.match(/<td /g) ?? []).length).toBe(4);
    expect(drawn).toContain("A weekly publishing rhythm");
    // The prose before it is still prose.
    expect(drawn).toContain(">Here it is:</p>");
  });

  it("leaves a run of lines that is not a table exactly as it was written", () => {
    // The header holds one cell once the blanks are dropped, so the block is
    // not a table and not one character of it may be rewritten.
    const text = "a| |\nb|c";
    expect(normalizeCoreMarkdown(text)).toBe(text);
  });

  it("draws bold as bold rather than printing its asterisks", () => {
    const drawn = renderRunWindowMarkdown("Placed the **idea** in the field.");
    expect(drawn).toContain(">idea</strong>");
    expect(drawn).not.toContain("**");
  });

  it("costs the LENGTH of a pathological line of pipes, not its shape", () => {
    // One line of many pipes is the shape the nested repetition could divide
    // between its iterations in exponentially many ways.
    const pipes = `head|line\n${"cell|".repeat(20_000)}tail`;
    expect(millis(() => normalizeCoreMarkdown(pipes))).toBeLessThan(2_000);

    // A run of table-looking lines whose LAST line breaks the block, so the
    // shape fix reaches its rejection with the whole run in hand.
    const rejected = `${"a|b\n".repeat(20_000)}z| |`;
    expect(millis(() => normalizeCoreMarkdown(rejected))).toBeLessThan(2_000);
  });

  it("strips empty paragraphs out of a text of nothing but opening tags in linear time", () => {
    // The shape that measured 799 ms at 64 000 characters before the repair,
    // here at four times that length.
    const openings = "<p".repeat(128_000);
    expect(millis(() => stripEmptyParagraphs(openings))).toBeLessThan(2_000);
    // And it still strips what it is for.
    expect(stripEmptyParagraphs('before<p class="my-2">  </p>after')).toBe("beforeafter");
    expect(stripEmptyParagraphs("<p>kept</p>")).toBe("<p>kept</p>");
  });
});
