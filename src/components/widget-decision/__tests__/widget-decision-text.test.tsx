// @vitest-environment jsdom
//
// cinatra#2575 (epic #2564 S8b) — the ADVERSARIAL STRINGS.
//
// The defect this pins, in one sentence: text with no spaces in it had its
// ending clipped off the right edge of the confirmation window while the Confirm
// button stayed perfectly reachable, so a person could authorize a decision
// whose text they were never shown.
//
// Codex round 2 removed the inner `max-h-56 overflow-y-auto` box and closed that
// hole on the VERTICAL axis. The coordinator's layout verification then found it
// still open on the horizontal one: `whitespace-pre-wrap` creates wrap
// opportunities at spaces and newlines only, so a single unbroken run extends as
// far as it likes, and the app's global `html { overflow-x: hidden }` clips the
// overflow rather than offering a scrollbar to reach it. Round 2's exploit,
// rotated ninety degrees.
//
// TWO surfaces carry somebody else's text, and both are covered here:
//
//   · the RATIONALE — the message being confirmed, capped at
//     `WIDGET_COMMENT_MAX_CHARS`;
//   · the SUBJECT — what is being decided, assembled from artifact TITLES the
//     requester chose and capped at 400. This is the WORSE of the two: the site
//     holds the widget bearer and can open this window on any gate the person
//     may read, so naming the subject is the window's primary defence against a
//     substituted gate. An unbroken title whose distinguishing suffix is clipped
//     defeats exactly the affordance the line exists to provide.
//
// The caps are the WHOLE budget for each field, so the strings below are not
// stress tests — they are the largest inputs each path accepts, made entirely of
// characters that offer no wrap opportunity. If the window can show these in
// full, it can show any of them.
//
// WHAT THIS FILE CAN AND CANNOT PROVE — stated plainly, because the difference
// matters. jsdom parses and renders but does NOT lay out: every geometric
// property (`scrollWidth`, `clientWidth`, `getBoundingClientRect`) is a hardcoded
// zero, and Tailwind's utilities are never compiled here, so `getComputedStyle`
// would not report `overflow-wrap` either. An assertion like
// `scrollWidth <= clientWidth` would therefore pass in this file no matter what
// the components did — it would be theatre, not evidence, so it is not written.
//
// What IS proven here is the half a renderer can prove:
//   · every character reaches the DOM, in order, unmodified — nothing is
//     excerpted, elided or dropped;
//   · the elements carry the layout contract that makes them all visible, and
//     carry nothing that could hide them.
//
// The GEOMETRIC half — that the laid-out page overflows in neither axis with
// these exact strings — is proven in a real browser and recorded as a screenshot
// plus a measurement on the pull request, because a real layout engine is the
// only thing that can prove it. Neither half is sufficient alone.

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { WIDGET_COMMENT_MAX_CHARS } from "@/lib/lifecycle/widget-action-capability";

import {
  WidgetDecisionRationale,
  WidgetDecisionSubject,
} from "../widget-decision-text";

/**
 * The subject cap enforced by `subjectLabelFor` in the ASK route
 * (`SUBJECT_MAX_CHARS`). It is a private constant there, so it is restated here
 * with its source named — and the assertion below only ever needs it to be a
 * length the path really accepts, not the exact one, since a subject longer than
 * the cap cannot reach the page at all.
 */
const SUBJECT_MAX_CHARS = 400;

const TAIL = "ENDOFMESSAGE";

/**
 * `length` characters with NO soft-wrap opportunity anywhere in them: no space,
 * no newline, no tab, and no hyphen or slash either — a break after those is a
 * normal wrap opportunity, which would let `whitespace-pre-wrap` alone pass and
 * hide the defect.
 *
 * Built from a repeating alphanumeric run so a truncation is visible as a
 * specific position rather than an anonymous blob, and ending in a distinct
 * sentinel so "the ending survived" is checkable on its own.
 */
function unbroken(length: number): string {
  return (
    "A".padEnd(length - TAIL.length, "0123456789abcdefghijklmnopqrstuvwxyz") + TAIL
  );
}

const ADVERSARIAL_RATIONALE = unbroken(WIDGET_COMMENT_MAX_CHARS);
const ADVERSARIAL_SUBJECT = unbroken(SUBJECT_MAX_CHARS);

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(node: React.ReactElement): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(node);
  });
  const el = host.querySelector("p");
  if (!el) throw new Error("rendered no element");
  return el;
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  if (host) host.remove();
  root = null;
  host = null;
});

/** Each surface, with the worst input its own path accepts. */
const SURFACES: Array<{
  name: string;
  element: (text: string) => React.ReactElement;
  text: string;
  length: number;
}> = [
  {
    name: "the rationale",
    element: (text) => <WidgetDecisionRationale text={text} />,
    text: ADVERSARIAL_RATIONALE,
    length: WIDGET_COMMENT_MAX_CHARS,
  },
  {
    name: "the subject",
    element: (text) => <WidgetDecisionSubject text={text} />,
    text: ADVERSARIAL_SUBJECT,
    length: SUBJECT_MAX_CHARS,
  },
];

describe("the widget confirmation window's untrusted text (cinatra#2575)", () => {
  it("the fixtures are unbroken and exactly at the cap", () => {
    // Guards the fixtures themselves: a later edit that accidentally shortened
    // one, or let a space in, would silently turn every assertion below into a
    // test of nothing.
    for (const { name, text, length } of SURFACES) {
      expect(text, name).toHaveLength(length);
      expect(text, name).not.toMatch(/[\s\-/\\]/);
    }
    // ...and the two are genuinely different lengths, so a copy-paste that made
    // both cases the same string would be caught.
    expect(WIDGET_COMMENT_MAX_CHARS).not.toBe(SUBJECT_MAX_CHARS);
  });

  describe.each(SURFACES)("$name", ({ element, text, length }) => {
    it("renders EVERY character — nothing excerpted, elided or dropped", () => {
      const el = render(element(text));

      // The whole string, character for character and in order. Equality rather
      // than `toContain`, so a rendering that showed the text plus an ellipsis —
      // or that showed it twice — fails too.
      expect(el.textContent).toBe(text);
      expect(el.textContent).toHaveLength(length);

      // The ENDING specifically. This is the part the defect ate: the clip took
      // the suffix, so a regression shows up here first and most legibly.
      expect(el.textContent!.endsWith(TAIL)).toBe(true);

      // No ellipsis was introduced anywhere — neither the character nor the
      // three-dot spelling a truncation helper would leave behind.
      expect(el.textContent).not.toMatch(/[…]|\.\.\./);
    });

    it("carries the wrap contract that makes those characters VISIBLE", () => {
      const el = render(element(text));
      const tokens = (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

      // `wrap-anywhere` (`overflow-wrap: anywhere`) is what wraps an unbroken
      // run, and `break-words` (`overflow-wrap: break-word`) would NOT: per CSS
      // Text, only `anywhere`'s break opportunities count toward min-content
      // intrinsic size, and these paragraphs are grid items whose default
      // `min-width: auto` floors them at min-content. Under `break-words` the
      // run still widens the track and still overflows. The utility is asserted
      // by name because the substitution is the plausible future edit that
      // silently reopens the defect.
      expect(tokens).toContain("wrap-anywhere");
      expect(tokens).not.toContain("break-words");
    });

    it("carries NOTHING that could hide a character, in either axis", () => {
      const el = render(element(text));
      const tokens = (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

      // Each of these re-hides an ending by a different route: a scroll or clip
      // region (round 2's original box, or its horizontal twin), a height or
      // width cap, a clamp or ellipsis that drops characters outright, and the
      // whitespace settings that would defeat the wrap above.
      const FORBIDDEN = [
        /^-?overflow(-[xy])?-/,
        /^-?max-[hw]-/,
        /^truncate$/,
        /^text-ellipsis$/,
        /^line-clamp-/,
        /^whitespace-nowrap$/,
        /^text-nowrap$/,
        /^break-normal$/,
      ];
      for (const token of tokens) {
        const utility = token.split(":").pop()!; // strip `sm:` / `dark:` variants
        for (const pattern of FORBIDDEN) {
          expect(utility, `class token "${token}"`).not.toMatch(pattern);
        }
      }

      // And no inline geometry, which would sidestep the class contract
      // entirely (codex wrap-round 1, finding 2).
      expect(el.getAttribute("style")).toBeNull();
    });

    it("shows the text, never interprets it", () => {
      // Adjacent to the layout property and cheap to hold: both strings are
      // attacker-influenced text on a page whose whole job is being trustworthy,
      // so they must arrive as text. React escapes a text child, and this pins
      // that nobody later reaches for `dangerouslySetInnerHTML` to "render
      // formatting".
      const markup = "<img src=x onerror=alert(1)>craft";
      const el = render(element(markup));
      expect(el.textContent).toBe(markup);
      expect(el.querySelector("img")).toBeNull();
      expect(el.children).toHaveLength(0);
    });
  });

  it("the rationale ALSO preserves the author's own line breaks", () => {
    // `whitespace-pre-wrap` is the rationale's alone — the subject is a
    // server-assembled single line, so it has no authored breaks to keep. The
    // two therefore differ deliberately, and this pins that the message half
    // did not lose it while the wrap fix was being applied.
    const el = render(<WidgetDecisionRationale text={"first\n\nsecond"} />);
    expect(el.getAttribute("class")).toContain("whitespace-pre-wrap");
    expect(el.textContent).toBe("first\n\nsecond");
  });
});
