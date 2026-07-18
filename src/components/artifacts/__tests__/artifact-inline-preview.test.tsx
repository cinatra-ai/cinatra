/**
 * ArtifactInlinePreview — the host-owned NEUTRAL preview slot (cinatra#1630 AC-3)
 * that replaces the in-core inline-image reuse sites. Proves:
 *   - it draws HOST-OWNED passive pixels (an <img>) for an image representation
 *     with an effective (capability-gated) preview href — no extension code, no
 *     concrete-MIME allowlist;
 *   - it fails closed to the core fallback when no href is effective (e.g. the
 *     image base is archived ⇒ upstream mints null);
 *   - it does not <img> a non-image transport class.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ArtifactInlinePreview } from "../artifact-inline-preview";

describe("ArtifactInlinePreview — capability-gated neutral preview", () => {
  it("renders an <img> for an image representation with an effective preview href", () => {
    const html = renderToStaticMarkup(
      <ArtifactInlinePreview
        previewHref="/api/artifacts/a1/versions/v1/preview"
        mime="image/png"
        title="Shot"
      />,
    );
    expect(html).toContain("<img");
    expect(html).toContain('src="/api/artifacts/a1/versions/v1/preview"');
    expect(html).toContain('alt="Shot"');
    expect(html).not.toContain("No inline preview available");
  });

  it("renders the core fallback (no <img>) when no preview href is effective (fail closed)", () => {
    const html = renderToStaticMarkup(
      <ArtifactInlinePreview previewHref={null} mime="image/png" title="Shot" />,
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("No inline preview available");
  });

  it("renders the core fallback for a non-image transport class (never <img>s a pdf)", () => {
    const html = renderToStaticMarkup(
      <ArtifactInlinePreview
        previewHref="/api/artifacts/a1/versions/v1/preview"
        mime="application/pdf"
        title="Doc"
      />,
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("No inline preview available");
  });
});
