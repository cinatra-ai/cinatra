// `text/x-markdown` IS CANONICALISED ONCE, IN THE HOST (cinatra#3319,
// acceptance 4 — the half the ownership boundary leaves on this side).
//
// "`text/x-markdown` is canonicalised once to `text/markdown` in the host or
//  declared by the markdown pack, never by the text pack."
//
// The host half is taken here: the alias resolves to the registered media type
// before any registry is read, so a row recorded under the legacy spelling
// reaches the same display a row recorded under the registered one reaches. The
// pack-side declarations named beside it in the same acceptance item stay in the
// packs' own repositories.
import { describe, expect, it } from "vitest";

import {
  REPRESENTATION_MIME_ALIAS_PAIRS,
  canonicalRepresentationMime,
} from "../renderer-resolution";

describe("acceptance 4 — the host's one canonicalisation", () => {
  it("maps the legacy markdown spelling to the registered one", () => {
    expect(canonicalRepresentationMime("text/x-markdown")).toBe("text/markdown");
  });

  it("is idempotent — the registered spelling comes back unchanged", () => {
    expect(canonicalRepresentationMime("text/markdown")).toBe("text/markdown");
    expect(canonicalRepresentationMime(canonicalRepresentationMime("text/x-markdown"))).toBe(
      "text/markdown",
    );
  });

  it("changes nothing else — a media type this host knows no alias for is returned as given", () => {
    for (const mime of [
      "text/plain",
      "text/csv",
      "application/json",
      "application/pdf",
      "image/png",
      "application/octet-stream",
      "text/html",
      "",
    ]) {
      expect(canonicalRepresentationMime(mime)).toBe(mime);
    }
  });

  it("tolerates the two ways one spelling reaches the host differently", () => {
    expect(canonicalRepresentationMime("  TEXT/X-MARKDOWN ")).toBe("text/markdown");
  });

  it("carries exactly the alias the acceptance item names — no host-invented synonyms", () => {
    expect(REPRESENTATION_MIME_ALIAS_PAIRS).toEqual([["text/x-markdown", "text/markdown"]]);
  });
});
