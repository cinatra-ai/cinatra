// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ArtifactSummary } from "@/lib/artifacts/artifact-service";

const dispatch = vi.hoisted(() => ({ semantic: vi.fn() }));
vi.mock("@/app/artifacts/[id]/renderer-resolution", () => ({
  resolveSemanticDispatch: dispatch.semantic,
  resolveSemanticListRowDispatch: () => null,
  classifyLoadablePath: () => "none",
}));
vi.mock("@/lib/artifacts/artifact-renderer-loader", () => ({ loadArtifactRenderer: vi.fn() }));

import { LibraryRowGlyph } from "../library-row-glyph";

function summary(mime = "application/octet-stream"): ArtifactSummary {
  return {
    objectType: "@fixture/idea:artifact", mime,
    presentationIdentity: { kind: "extension", extension: "@fixture/idea" },
  } as ArtifactSummary;
}
async function glyphCell(row: ArtifactSummary): Promise<Element> {
  const html = renderToStaticMarkup(await LibraryRowGlyph({ summary: row }));
  const glyph = new DOMParser().parseFromString(html, "text/html").querySelector("[data-testid='artifacts-library-glyph']")!;
  return glyph;
}
async function icon(row: ArtifactSummary): Promise<Element> {
  return (await glyphCell(row)).querySelector("svg")!;
}

afterEach(() => { dispatch.semantic.mockReset(); });

describe("library rows show their actual kind glyph, preserving recorded coverage", () => {
  it("retains the recorded glyph-coverage exception for a missing listRow renderer", async () => {
    expect((await glyphCell(summary())).getAttribute("data-glyph-source")).toBe("recorded-exception");
  });

  it("draws different SVG shapes for typed, file and structured fallback rows", async () => {
    dispatch.semantic.mockReturnValue({ packageName: "@fixture/idea", generatedKey: "fixture::detail", built: true });
    const typed = await icon(summary());
    dispatch.semantic.mockReturnValue(null);
    const file = await icon(summary("application/pdf"));
    const fallback = await icon(summary());
    expect(typed.classList.contains("lucide-boxes")).toBe(true);
    expect(file.classList.contains("lucide-file-text")).toBe(true);
    expect(fallback.classList.contains("lucide-braces")).toBe(true);
    expect(new Set([typed.innerHTML, file.innerHTML, fallback.innerHTML]).size).toBe(3);
  });
});
