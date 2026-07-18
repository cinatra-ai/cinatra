// Pure stream-payload normalizers (cinatra#1218 delete stage) — the
// wire-agnostic helpers relocated from the deleted bespoke
// `chat-stream-events.ts`. These cases carry over the original contracts
// verbatim so the relocation cannot drift the behavior the AG-UI reducer
// (../ag-ui-reducer.ts) folds through.

import { describe, expect, it } from "vitest";
import {
  extractErrorMessage,
  mergeCitations,
  normalizeCitations,
} from "../stream-normalizers";

describe("normalizeCitations", () => {
  it("fills indexes/titles and drops url-less entries", () => {
    expect(normalizeCitations([
      { index: 3, title: "A", url: "https://a" },
      { title: "no-url" },
      { url: "https://b" },
      null,
      "junk",
    ])).toEqual([
      { index: 3, title: "A", url: "https://a" },
      { index: 3, title: "", url: "https://b" },
    ]);
    expect(normalizeCitations(undefined)).toEqual([]);
  });
});

describe("mergeCitations", () => {
  it("dedupes by url keeping first-seen order", () => {
    const merged = mergeCitations(
      [{ index: 1, title: "A", url: "https://a" }],
      [{ index: 2, title: "A2", url: "https://a" }, { index: 3, title: "B", url: "https://b" }],
    );
    expect(merged.map((c) => c.url)).toEqual(["https://a", "https://b"]);
    expect(merged[0].title).toBe("A");
  });
});

describe("extractErrorMessage", () => {
  it("extracts the friendly message from JSON error bodies", () => {
    expect(
      extractErrorMessage(JSON.stringify({ error: { message: "Provider down" } })),
    ).toBe("Provider down");
    expect(extractErrorMessage(JSON.stringify({ message: "flat" }))).toBe("flat");
    expect(extractErrorMessage(JSON.stringify({ error: "stringy" }))).toBe("stringy");
  });

  it("falls back for empty and oversized bodies", () => {
    expect(extractErrorMessage("")).toBe("Something went wrong. Please try again.");
    expect(extractErrorMessage("x".repeat(301))).toBe("The request failed. Please try again in a moment.");
    expect(extractErrorMessage("plain failure")).toBe("plain failure");
  });
});
