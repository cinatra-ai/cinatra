// The picker's derived meaning, narrowed to what the picker OFFERS (cinatra#3319;
// spec `specs/app-artifacts.html` §VI.1). The confirmation gate refuses any
// extension outside the candidate list, so a pre-selection or a chip naming one
// would be a dead pick. Chips are labelled as the drawing writes them
// ("Pricing sheet · Sales" followed by the confidence).
//
//   pnpm exec vitest run src/lib/artifacts/__tests__/picker-meaning-offer-3319.test.ts

import { describe, expect, it } from "vitest";

type Narrow = (
  offer: {
    preselect: string | null;
    suggestions: Array<{ extension: string; confidence: number | null }>;
  },
  types: Array<{
    objectTypeId: string | null;
    extension: string;
    displayName: string;
    extensionLabel: string;
  }>,
) => {
  preselect: string | null;
  suggestions: Array<{ extension: string; label: string; confidence: number | null }>;
};

async function narrow(): Promise<Narrow> {
  const mod = (await import("@/lib/artifacts/picker-meaning-offer")) as unknown as {
    narrowMeaningOfferToOffered: Narrow;
  };
  return mod.narrowMeaningOfferToOffered;
}

const IDEA = "@cinatra-ai/blog-idea-artifact";
const POST = "@cinatra-ai/blog-post-artifact";
const TYPES = [
  {
    objectTypeId: "@cinatra-ai/blog-idea-artifact:blog-idea",
    extension: IDEA,
    displayName: "Blog idea",
    extensionLabel: "Blog Idea",
  },
  {
    objectTypeId: "@cinatra-ai/blog-post-artifact:post",
    extension: POST,
    displayName: "Post",
    extensionLabel: "Blog Post",
  },
];

describe("cinatra#3319 — narrowMeaningOfferToOffered", () => {
  it("N1: an offered pre-selection is kept", async () => {
    const n = await narrow();
    expect(n({ preselect: IDEA, suggestions: [] }, TYPES)).toEqual({ preselect: IDEA, suggestions: [] });
  });

  it("N2: a pre-selection the picker does not offer is dropped", async () => {
    const n = await narrow();
    expect(n({ preselect: "@acme/other-artifact", suggestions: [] }, TYPES).preselect).toBeNull();
  });

  it("N3: a chip is labelled 'display name · pack label' and keeps its confidence", async () => {
    const n = await narrow();
    expect(n({ preselect: null, suggestions: [{ extension: POST, confidence: 0.61 }] }, TYPES)).toEqual({
      preselect: null,
      suggestions: [{ extension: POST, label: "Post · Blog Post", confidence: 0.61 }],
    });
  });

  it("N4: a chip the picker does not offer is dropped; order of the rest is kept", async () => {
    const n = await narrow();
    const out = n(
      {
        preselect: null,
        suggestions: [
          { extension: POST, confidence: 0.4 },
          { extension: "@acme/other-artifact", confidence: 0.5 },
          { extension: IDEA, confidence: null },
        ],
      },
      TYPES,
    );
    expect(out.suggestions.map((s) => s.extension)).toEqual([POST, IDEA]);
    expect(out.suggestions[1]!.confidence).toBeNull();
  });

  it("N5: the pre-selected extension is never also a chip", async () => {
    const n = await narrow();
    const out = n({ preselect: IDEA, suggestions: [{ extension: IDEA, confidence: 0.9 }] }, TYPES);
    expect(out).toEqual({ preselect: IDEA, suggestions: [] });
  });
});
