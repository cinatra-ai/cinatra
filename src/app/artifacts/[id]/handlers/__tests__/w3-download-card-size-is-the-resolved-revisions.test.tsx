// @vitest-environment jsdom
//
// THE SIZE ON THE DOWNLOAD CARD IS THE RESOLVED REVISION'S (cinatra#3091,
// wave 3 — the follow-up fix leg 4 named and deliberately left open).
//
// The ratified drawing's V.2 draws this card as "the file's name, its form,
// its size, and the download". Three of those four already came from the
// pinned representation the page resolved; the SIZE did not. It came from
// `artifact.size` — the value cached on the object row when the artifact was
// created — which is exactly the stale reading cinatra#3026 removed from the
// page header and which `artifact-page-header-reading` records as travelling
// with the size to whichever surface still draws one.
//
// The save road appends an immutable revision and never rewrites that cached
// row value, by design. So a file whose bytes moved kept reporting its FIRST
// revision's size on the one surface whose whole job is to describe the bytes
// on offer — beside a Download control that hands over the newer ones. The
// number and the button disagreed.
//
// RED BEFORE THE FIX: the card drew `artifact.size` whatever the resolved
// revision's size was, so the first case below read the cached 4096 where the
// resolved revision is 91340, and the page passed the floor no size at all.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { ArtifactSummary } from "@/lib/artifacts/artifact-service";

import { FallbackHandler } from "../fallback-handler";

const ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..", "..");
const PAGE_PATH = "src/app/artifacts/[id]/page.tsx";

// The row's cached size, written when the artifact was created and never
// rewritten since.
const artifact = {
  artifactId: "art_7f21",
  title: "quarterly.bin",
  size: 4096,
  originKind: "upload",
  createdAt: "2026-09-01T10:00:00.000Z",
} as unknown as ArtifactSummary;

afterEach(cleanup);

describe("V.2's download card reads its size from the revision it offers", () => {
  it("draws the RESOLVED revision's size, not the row's cached one", () => {
    render(
      <FallbackHandler
        artifact={artifact}
        mime="application/octet-stream"
        sizeBytes={91340}
        downloadHref="/api/artifacts/art_7f21/versions/rev_9ac3/content"
      />,
    );
    const text = document.body.textContent ?? "";
    expect(text).toContain("91340");
    // Not merely "also present": the stale value must be GONE, or the card
    // draws two sizes and the reader cannot tell which one the button hands
    // over.
    expect(text).not.toContain("4096");
  });

  it("falls back to the row's cached size only where no revision resolved", () => {
    // A row with no materialized representation has no revision to read a size
    // from and draws no download either. The cached value is then the only
    // reading there is, and it is still better than an empty size cell.
    render(<FallbackHandler artifact={artifact} mime="application/octet-stream" />);
    expect(document.body.textContent ?? "").toContain("4096");
    expect(screen.queryByRole("link", { name: /download/i })).toBeNull();
  });

  it("the size and the download describe ONE revision — the same one", () => {
    // The whole defect in one assertion: whatever number this card draws, it is
    // the size of the bytes its own control hands over.
    render(
      <FallbackHandler
        artifact={artifact}
        mime="application/octet-stream"
        sizeBytes={91340}
        downloadHref="/api/artifacts/art_7f21/versions/rev_9ac3/content"
      />,
    );
    const link = screen.getByRole("link", { name: /download/i });
    expect(link.getAttribute("href")).toContain("rev_9ac3");
    expect(document.body.textContent ?? "").toContain("91340");
  });
});

describe("the page hands the floor the size of the revision it resolved", () => {
  it("the file path this suite reads is the page the router mounts", () => {
    expect(existsSync(path.join(ROOT, PAGE_PATH))).toBe(true);
  });

  it("passes the resolved representation's sizeBytes, never artifact.size", () => {
    const page = readFileSync(path.join(ROOT, PAGE_PATH), "utf8");
    // The floor is built in exactly one place on this page and reused by every
    // degrade path, so pinning that one construction pins them all.
    const call = page.match(/<FallbackHandler[\s\S]*?\/>/);
    expect(call).not.toBeNull();
    expect(call?.[0]).toContain("sizeBytes={resolved?.sizeBytes ?? null}");
    expect(call?.[0]).not.toContain("artifact.size");
  });
});
