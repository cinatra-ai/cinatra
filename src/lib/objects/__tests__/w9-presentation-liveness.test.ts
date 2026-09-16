import { describe, expect, it } from "vitest";

import { selectLiveExtensions } from "../presentation-identity";

// cinatra#3033 (lifecycle-c W9), acceptance item 1: "each of the four displays
// draws on the page, on the card and inside a third-party application at the
// pinned revision" — and the ratified drawing, app-artifact-review §XI: "One
// display per type ... the same display is drawn, unchanged, wherever the
// artifact is read".
//
// The LinkedIn display drew NOWHERE even after its row carried the type, because
// presentation liveness was derived from type-id NAMESPACES only. The pack whose
// display the drawing names — `@cinatra-ai/linkedin-artifacts` — CLAIMS the id
// and registers no type, so it was never live, its user assertion could not win
// tier 1, and the row presented under `@cinatra-ai/linkedin`, a package that
// does not exist and ships no renderer. Measured live: the artifact page drew
// `data-artifact-renderer="markdown"`.

describe("W9 — a pack is presentation-live through the type it CLAIMS, not only the one it owns", () => {
  it("makes the id's namespace owner live", () => {
    const live = selectLiveExtensions([
      { typeId: "@acme/legal:contract", claimants: [] },
    ]);
    expect(live.has("@acme/legal")).toBe(true);
  });

  it("makes the CLAIMANT of a registered type live", () => {
    const live = selectLiveExtensions([
      {
        typeId: "@cinatra-ai/linkedin:post-draft",
        claimants: ["@cinatra-ai/linkedin-artifacts"],
      },
    ]);
    expect(live.has("@cinatra-ai/linkedin-artifacts")).toBe(true);
    // The namespace owner stays live too — the two do not displace each other.
    expect(live.has("@cinatra-ai/linkedin")).toBe(true);
  });

  it("makes NOTHING live from a type nothing registered — the caller passes the live registry", () => {
    // An orphaned claim contributes no entry at all, so the set stays empty.
    expect(selectLiveExtensions([]).size).toBe(0);
  });

  it("keeps every claimant of a multiply-claimed type", () => {
    const live = selectLiveExtensions([
      { typeId: "@cinatra-ai/linkedin:post-draft", claimants: ["@a/one", "@b/two"] },
    ]);
    expect(live.has("@a/one")).toBe(true);
    expect(live.has("@b/two")).toBe(true);
  });
});
