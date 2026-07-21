import { describe, expect, it } from "vitest";
import {
  mimeAcceptedByAccepts,
  resolveUploadArtifactTypeFromCandidates,
  selectRequiredArtifactUploadCandidates,
  type RegisteredArtifactType,
  type UploadArtifactTypeCandidate,
} from "../upload-artifact-type-map";

// The four REQUIRED system-base packs' registered types + accepts, as the
// registry-reading wrapper would surface them (epic #1785, wave A3).
const BASE_CANDIDATES: UploadArtifactTypeCandidate[] = [
  { objectTypeId: "@cinatra-ai/pdf-artifact:document", acceptMimes: ["application/pdf"] },
  { objectTypeId: "@cinatra-ai/audio-artifact:recording", acceptMimes: ["audio/*"] },
  { objectTypeId: "@cinatra-ai/video-artifact:video", acceptMimes: ["video/mp4", "video/webm", "video/ogg"] },
  { objectTypeId: "@cinatra-ai/image-artifact:image", acceptMimes: ["image/*"] },
];

describe("mimeAcceptedByAccepts", () => {
  it("matches an exact declared MIME", () => {
    expect(mimeAcceptedByAccepts(["application/pdf"], "application/pdf")).toBe(true);
    expect(mimeAcceptedByAccepts(["application/pdf"], "image/png")).toBe(false);
  });

  it("matches a `type/*` wildcard against any subtype", () => {
    expect(mimeAcceptedByAccepts(["image/*"], "image/png")).toBe(true);
    expect(mimeAcceptedByAccepts(["image/*"], "image/svg+xml")).toBe(true);
    expect(mimeAcceptedByAccepts(["image/*"], "audio/mpeg")).toBe(false);
  });

  it("strips MIME parameters and is case-insensitive", () => {
    expect(mimeAcceptedByAccepts(["image/*"], "IMAGE/PNG; charset=binary")).toBe(true);
    expect(mimeAcceptedByAccepts(["application/pdf"], "Application/PDF")).toBe(true);
  });

  it("rejects an empty / whitespace MIME", () => {
    expect(mimeAcceptedByAccepts(["image/*"], "")).toBe(false);
    expect(mimeAcceptedByAccepts(["image/*"], "   ")).toBe(false);
    expect(mimeAcceptedByAccepts(["image/*"], undefined)).toBe(false);
  });
});

describe("resolveUploadArtifactTypeFromCandidates", () => {
  it("resolves an exact-MIME upload to the one base pack", () => {
    const r = resolveUploadArtifactTypeFromCandidates("application/pdf", BASE_CANDIDATES);
    expect(r).toEqual({ ok: true, objectTypeId: "@cinatra-ai/pdf-artifact:document" });
  });

  it("resolves a wildcard-accepted upload (image/png → image pack)", () => {
    const r = resolveUploadArtifactTypeFromCandidates("image/png", BASE_CANDIDATES);
    expect(r).toEqual({ ok: true, objectTypeId: "@cinatra-ai/image-artifact:image" });
  });

  it("resolves an enumerated video MIME, refuses a non-enumerated one", () => {
    expect(resolveUploadArtifactTypeFromCandidates("video/mp4", BASE_CANDIDATES)).toEqual({
      ok: true,
      objectTypeId: "@cinatra-ai/video-artifact:video",
    });
    const miss = resolveUploadArtifactTypeFromCandidates("video/quicktime", BASE_CANDIDATES);
    expect(miss.ok).toBe(false);
  });

  it("REFUSES a MIME no base pack accepts (fail closed — e.g. URL-import markdown)", () => {
    const r = resolveUploadArtifactTypeFromCandidates("text/markdown", BASE_CANDIDATES);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.matched).toEqual([]);
      expect(r.reason).toMatch(/no installed required-base artifact type/);
    }
  });

  it("REFUSES an empty / missing MIME (fail closed)", () => {
    expect(resolveUploadArtifactTypeFromCandidates(undefined, BASE_CANDIDATES).ok).toBe(false);
    expect(resolveUploadArtifactTypeFromCandidates("", BASE_CANDIDATES).ok).toBe(false);
  });

  it("REFUSES an ambiguous MIME accepted by more than one base type", () => {
    const ambiguous: UploadArtifactTypeCandidate[] = [
      { objectTypeId: "@cinatra-ai/image-artifact:image", acceptMimes: ["image/*"] },
      // A (hypothetical) second registered type also accepting image/png.
      { objectTypeId: "@cinatra-ai/screenshot-artifact:screenshot", acceptMimes: ["image/png"] },
    ];
    const r = resolveUploadArtifactTypeFromCandidates("image/png", ambiguous);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.matched.sort()).toEqual([
        "@cinatra-ai/image-artifact:image",
        "@cinatra-ai/screenshot-artifact:screenshot",
      ]);
      expect(r.reason).toMatch(/ambiguously accepted/);
    }
  });

  it("de-dupes a single type that lists a MIME twice (not an ambiguity)", () => {
    const dup: UploadArtifactTypeCandidate[] = [
      { objectTypeId: "@cinatra-ai/pdf-artifact:document", acceptMimes: ["application/pdf", "application/pdf"] },
    ];
    expect(resolveUploadArtifactTypeFromCandidates("application/pdf", dup)).toEqual({
      ok: true,
      objectTypeId: "@cinatra-ai/pdf-artifact:document",
    });
  });
});

describe("selectRequiredArtifactUploadCandidates", () => {
  // A mixed registry snapshot: two required base packs, one required floor pack
  // (universal `*/*`), one required pack with no file accepts, one non-required
  // third-party pack, and one host/built-in (no definer).
  const REGISTRY: RegisteredArtifactType[] = [
    { objectTypeId: "@cinatra-ai/pdf-artifact:document", definer: "@cinatra-ai/pdf-artifact", acceptMimes: ["application/pdf"] },
    { objectTypeId: "@cinatra-ai/image-artifact:image", definer: "@cinatra-ai/image-artifact", acceptMimes: ["image/*"] },
    // The retired generic floor — required, but a `*/*` catch-all: EXCLUDED.
    { objectTypeId: "@cinatra-ai/objects:object", definer: "@cinatra-ai/default-artifact", acceptMimes: ["*/*"] },
    // Required but declares no file MIMEs (dashboard-only): EXCLUDED.
    { objectTypeId: "@cinatra-ai/dashboard-artifact:board", definer: "@cinatra-ai/dashboard-artifact", acceptMimes: undefined },
    // A third-party pack that also accepts image/* but is NOT required: EXCLUDED
    // (this is what stops silent third-party capture of uploads).
    { objectTypeId: "@vendor/screenshot-artifact:shot", definer: "@vendor/screenshot-artifact", acceptMimes: ["image/*"] },
    // A host/built-in registration (no provenance): EXCLUDED.
    { objectTypeId: "@cinatra-ai/email:body", definer: null, acceptMimes: ["message/rfc822"] },
  ];
  const REQUIRED = new Set([
    "@cinatra-ai/pdf-artifact",
    "@cinatra-ai/image-artifact",
    "@cinatra-ai/default-artifact",
    "@cinatra-ai/dashboard-artifact",
  ]);
  const isRequired = (pkg: string) => REQUIRED.has(pkg);

  it("keeps only required, dedicated (non-universal), file-accepting types", () => {
    const candidates = selectRequiredArtifactUploadCandidates(REGISTRY, isRequired);
    expect(candidates).toEqual([
      { objectTypeId: "@cinatra-ai/pdf-artifact:document", acceptMimes: ["application/pdf"] },
      { objectTypeId: "@cinatra-ai/image-artifact:image", acceptMimes: ["image/*"] },
    ]);
  });

  it("EXCLUDES the retired `*/*` generic floor even when it is required", () => {
    const candidates = selectRequiredArtifactUploadCandidates(REGISTRY, isRequired);
    expect(candidates.some((c) => c.acceptMimes.includes("*/*"))).toBe(false);
  });

  it("EXCLUDES a non-required third-party pack (no silent upload capture)", () => {
    const candidates = selectRequiredArtifactUploadCandidates(REGISTRY, isRequired);
    expect(candidates.some((c) => c.objectTypeId === "@vendor/screenshot-artifact:shot")).toBe(false);
  });

  it("EXCLUDES host/built-in (null definer) and no-file-accepts types", () => {
    const candidates = selectRequiredArtifactUploadCandidates(REGISTRY, isRequired);
    const ids = candidates.map((c) => c.objectTypeId);
    expect(ids).not.toContain("@cinatra-ai/email:body");
    expect(ids).not.toContain("@cinatra-ai/dashboard-artifact:board");
  });

  it("resolves end-to-end through the selected candidates (image/png → image pack)", () => {
    const candidates = selectRequiredArtifactUploadCandidates(REGISTRY, isRequired);
    expect(resolveUploadArtifactTypeFromCandidates("image/png", candidates)).toEqual({
      ok: true,
      objectTypeId: "@cinatra-ai/image-artifact:image",
    });
  });
});

// ---------------------------------------------------------------------------
// Full required-base roster after the MIME-base expansion (epic #1883 A1): the
// existing five (image/pdf/audio/video/chart) + the four new bases (zip / text /
// document / json). This matrix proves the roster is MUTUALLY DISJOINT under the
// core matcher (exactly-one-or-refuse) — every declared MIME resolves to exactly
// its own base, and the two known container/suffix traps (docx-as-zip, json vs
// the chart `+json` type) do NOT collide.
// ---------------------------------------------------------------------------
const FULL_ROSTER: UploadArtifactTypeCandidate[] = [
  { objectTypeId: "@cinatra-ai/image-artifact:artifact", acceptMimes: ["image/*"] },
  { objectTypeId: "@cinatra-ai/pdf-artifact:artifact", acceptMimes: ["application/pdf"] },
  { objectTypeId: "@cinatra-ai/audio-artifact:artifact", acceptMimes: ["audio/*"] },
  { objectTypeId: "@cinatra-ai/video-artifact:artifact", acceptMimes: ["video/*"] },
  { objectTypeId: "@cinatra-ai/chart-artifact:artifact", acceptMimes: ["application/vnd.cinatra.chart+json"] },
  { objectTypeId: "@cinatra-ai/zip-artifact:artifact", acceptMimes: ["application/zip", "application/x-zip-compressed"] },
  { objectTypeId: "@cinatra-ai/text-artifact:artifact", acceptMimes: ["text/plain", "text/markdown", "text/csv"] },
  {
    objectTypeId: "@cinatra-ai/document-artifact:artifact",
    acceptMimes: [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.oasis.opendocument.text",
    ],
  },
  { objectTypeId: "@cinatra-ai/json-artifact:artifact", acceptMimes: ["application/json"] },
];

describe("required-base roster — exactly-one-or-refuse over the expanded set (#1883 A1)", () => {
  const cases: Array<[string, string]> = [
    ["application/pdf", "@cinatra-ai/pdf-artifact:artifact"],
    ["image/png", "@cinatra-ai/image-artifact:artifact"],
    ["audio/mpeg", "@cinatra-ai/audio-artifact:artifact"],
    ["video/mp4", "@cinatra-ai/video-artifact:artifact"],
    ["application/vnd.cinatra.chart+json", "@cinatra-ai/chart-artifact:artifact"],
    ["application/zip", "@cinatra-ai/zip-artifact:artifact"],
    ["application/x-zip-compressed", "@cinatra-ai/zip-artifact:artifact"],
    ["text/plain", "@cinatra-ai/text-artifact:artifact"],
    ["text/markdown", "@cinatra-ai/text-artifact:artifact"],
    ["text/csv", "@cinatra-ai/text-artifact:artifact"],
    [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "@cinatra-ai/document-artifact:artifact",
    ],
    [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "@cinatra-ai/document-artifact:artifact",
    ],
    [
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "@cinatra-ai/document-artifact:artifact",
    ],
    ["application/vnd.oasis.opendocument.text", "@cinatra-ai/document-artifact:artifact"],
    ["application/json", "@cinatra-ai/json-artifact:artifact"],
  ];

  it.each(cases)("resolves %s to exactly %s", (mime, expected) => {
    expect(resolveUploadArtifactTypeFromCandidates(mime, FULL_ROSTER)).toEqual({
      ok: true,
      objectTypeId: expected,
    });
  });

  it("does NOT collide application/json with the chart +json type (declared exact match only)", () => {
    expect(resolveUploadArtifactTypeFromCandidates("application/json", FULL_ROSTER)).toEqual({
      ok: true,
      objectTypeId: "@cinatra-ai/json-artifact:artifact",
    });
    expect(resolveUploadArtifactTypeFromCandidates("application/vnd.cinatra.chart+json", FULL_ROSTER)).toEqual({
      ok: true,
      objectTypeId: "@cinatra-ai/chart-artifact:artifact",
    });
  });

  it("routes an office type to document-artifact, NOT zip-artifact (the declared mime decides, not the ZIP container)", () => {
    // The core map only ever sees the DECLARED mime; the office types are never
    // application/zip, so document and zip stay disjoint here — the byte-sniff
    // refinement is handled at the blob layer (see local-disk-blob-store).
    expect(
      resolveUploadArtifactTypeFromCandidates(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        FULL_ROSTER,
      ).ok,
    ).toBe(true);
    expect(
      resolveUploadArtifactTypeFromCandidates(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        FULL_ROSTER,
      ),
    ).toEqual({ ok: true, objectTypeId: "@cinatra-ai/document-artifact:artifact" });
  });

  it("still REFUSES an unmapped MIME after the expansion (no floor)", () => {
    for (const miss of ["application/octet-stream", "font/woff2", "text/html", "application/x-tar"]) {
      const r = resolveUploadArtifactTypeFromCandidates(miss, FULL_ROSTER);
      expect(r.ok, miss).toBe(false);
    }
  });

  it("no MIME in the roster is accepted by two bases (mutual disjointness)", () => {
    for (const [mime] of cases) {
      const matched = FULL_ROSTER.filter((c) =>
        c.acceptMimes.some((a) => mimeAcceptedByAccepts([a], mime)),
      );
      expect(matched.map((m) => m.objectTypeId), `${mime} matched >1 base`).toHaveLength(1);
    }
  });
});
