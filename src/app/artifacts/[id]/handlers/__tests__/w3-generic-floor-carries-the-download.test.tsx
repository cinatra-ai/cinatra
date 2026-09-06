// @vitest-environment jsdom
//
// THE FLOOR CARRIES THE DOWNLOAD (cinatra#3091, fix leg 2 — the convergence
// round's first finding).
//
// Fix leg 2 closed the artifact page's header at the drawn mono meta line and
// took the Download control out of it, because the drawing gives the download to
// the KIND. The generic floor — the card a MIME with no inline preview falls to —
// is one of those kinds: §V.2 draws "a file nothing of ours can read: its name,
// its form, its size, and the download". It was drawing the first three and a
// sentence pointing at the header's button, so with that button gone a person
// looking at an unpreviewable file had no way to save the bytes at all.
//
// RED BEFORE THE FIX: no link, and a sentence naming a control that is not on
// the page.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import type { ArtifactSummary } from "@/lib/artifacts/artifact-service";

import { FallbackHandler } from "../fallback-handler";

const artifact = {
  artifactId: "art_7f21",
  title: "quarterly.bin",
  size: 4096,
  originKind: "upload",
  createdAt: "2026-09-01T10:00:00.000Z",
} as unknown as ArtifactSummary;

afterEach(cleanup);

describe("the generic floor draws §V.2's download card", () => {
  it("draws a download control pointed at the representation's content", () => {
    render(
      <FallbackHandler
        artifact={artifact}
        mime="application/octet-stream"
        downloadHref="/api/artifacts/art_7f21/versions/rev_9ac3/content"
      />,
    );
    const link = screen.getByRole("link", { name: /download/i });
    expect(link.getAttribute("href")).toBe(
      "/api/artifacts/art_7f21/versions/rev_9ac3/content",
    );
    expect(link.hasAttribute("download")).toBe(true);
  });

  it("names no control the page does not carry", () => {
    render(
      <FallbackHandler
        artifact={artifact}
        mime="application/octet-stream"
        downloadHref="/api/artifacts/art_7f21/versions/rev_9ac3/content"
      />,
    );
    expect(document.body.textContent ?? "").not.toMatch(/button above/i);
  });

  it("draws no dead control where the row has no representation at all", () => {
    render(<FallbackHandler artifact={artifact} mime="application/octet-stream" />);
    expect(screen.queryByRole("link", { name: /download/i })).toBeNull();
  });

  it("still draws the file's name, its form and its size", () => {
    render(
      <FallbackHandler
        artifact={artifact}
        mime="application/octet-stream"
        downloadHref="/api/artifacts/art_7f21/versions/rev_9ac3/content"
      />,
    );
    const text = document.body.textContent ?? "";
    expect(text).toContain("quarterly.bin");
    expect(text).toContain("application/octet-stream");
    expect(text).toContain("4096");
  });
});
