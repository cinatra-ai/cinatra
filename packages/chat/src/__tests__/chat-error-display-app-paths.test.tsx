// @vitest-environment jsdom
//
// cinatra#2526 — in-app routes cited by a user-facing message must render as
// CLICKABLE links, not dead plain text. The live case is the assistant's
// "Cinatra MCP public URL is not configured … Set it at
// /configuration/development?tab=tunnel." (src/lib/assistant-runtime/runtime.ts).
//
// Two contracts are pinned:
//   1. the shared `linkifyErrorText` seam emits an in-app route as a link
//      segment (`external: false`) and stays LOSSLESS, and
//   2. `FriendlyErrorBody` renders that segment as a SAME-TAB link (an in-app
//      route must never get `target="_blank"`), while a provider URL keeps its
//      new-tab treatment.
//
// The negative cases matter as much as the positive one: this splitter runs
// over arbitrary provider prose, so a greedy path matcher would linkify "N/A",
// "and/or" or the path inside an already-matched URL.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { FriendlyErrorBody, linkifyErrorText } from "../chat-error-display";

afterEach(cleanup);

const MCP_ERROR =
  "Cinatra MCP public URL is not configured for hosted MCP access. Set it at /configuration/development?tab=tunnel.";

describe("linkifyErrorText — in-app routes (#2526)", () => {
  it("links the assistant MCP-URL route, period excluded, losslessly", () => {
    const segs = linkifyErrorText(MCP_ERROR);
    const links = segs.filter((s) => s.kind === "link");
    expect(links).toEqual([
      {
        kind: "link",
        value: "/configuration/development?tab=tunnel",
        href: "/configuration/development?tab=tunnel",
        external: false,
      },
    ]);
    // the sentence-ending period stays text
    expect(segs[segs.length - 1]).toEqual({ kind: "text", value: "." });
    expect(segs.map((s) => s.value).join("")).toBe(MCP_ERROR);
  });

  it("marks provider URLs external and in-app routes internal, in one string", () => {
    const msg = "see https://platform.openai.com/account/api-keys or /configuration/llm now";
    const segs = linkifyErrorText(msg);
    expect(
      segs.filter((s) => s.kind === "link").map((s) => [s.href, s.external]),
    ).toEqual([
      ["https://platform.openai.com/account/api-keys", true],
      ["/configuration/llm", false],
    ]);
    expect(segs.map((s) => s.value).join("")).toBe(msg);
  });

  it("does NOT rescan the path inside an already-matched URL", () => {
    const segs = linkifyErrorText("at https://example.com/configuration/llm end");
    expect(segs.filter((s) => s.kind === "link").map((s) => s.href)).toEqual([
      "https://example.com/configuration/llm",
    ]);
  });

  it("leaves prose slashes alone", () => {
    for (const msg of [
      "value is N/A",
      "pass true and/or false",
      "available 24/7",
      "mail ops@example.com/help",
      "ratio 1/2 of the batch",
      "trailing slash / alone",
    ]) {
      const segs = linkifyErrorText(msg);
      expect(segs.filter((s) => s.kind === "link")).toEqual([]);
      expect(segs.map((s) => s.value).join("")).toBe(msg);
    }
  });

  it("keeps a bare path with no query linkable and strips trailing punctuation", () => {
    const segs = linkifyErrorText("Finish at /setup/model.");
    expect(segs.filter((s) => s.kind === "link")).toEqual([
      { kind: "link", value: "/setup/model", href: "/setup/model", external: false },
    ]);
    expect(segs[segs.length - 1]).toEqual({ kind: "text", value: "." });
  });
});

describe("FriendlyErrorBody — in-app routes (#2526)", () => {
  it("renders the MCP-URL route as a same-tab link (no target=_blank)", () => {
    render(<FriendlyErrorBody error={MCP_ERROR} />);
    const link = screen.getByRole("link", {
      name: "/configuration/development?tab=tunnel",
    });
    expect(link.getAttribute("href")).toBe("/configuration/development?tab=tunnel");
    expect(link.getAttribute("target")).toBeNull();
    // the surrounding prose survives the split
    expect(screen.getByText(/Set it at/)).toBeTruthy();
  });

  it("still opens a provider URL in a new tab", () => {
    render(
      <FriendlyErrorBody error="401 Incorrect API key. See https://platform.openai.com/account/api-keys." />,
    );
    const link = screen.getByRole("link", {
      name: "https://platform.openai.com/account/api-keys",
    });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noreferrer");
  });
});
