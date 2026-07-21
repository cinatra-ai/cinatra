import { describe, expect, it } from "vitest";
import {
  resolveAttachmentCapability,
  CAPABILITY_RULES,
  extensionForIngestibleMime,
  filenameExtensionMatchesMime,
} from "../attachments/capability-registry";

// Capability matrix snapshot. Pure +
// deterministic. Decision A: PDF/image/text broadly ingestible; Office/
// archive NOT (no extraction path); size + unknown model/provider →
// structured reason, never a silent yes.

describe("resolveAttachmentCapability", () => {
  it("OpenAI gpt-5 ingests PDF + images → openai_input_file", () => {
    const pdf = resolveAttachmentCapability({
      provider: "openai",
      model: "gpt-5.5",
      mime: "application/pdf",
    });
    expect(pdf).toMatchObject({ ingestible: true, nativeKind: "openai_input_file" });
    const png = resolveAttachmentCapability({
      provider: "openai",
      model: "gpt-5.4",
      mime: "image/png",
    });
    expect(png.ingestible).toBe(true);
  });

  it("Anthropic claude: PDF/image/text/csv all ingestible (Decision A aligned)", () => {
    for (const mime of [
      "application/pdf",
      "image/png",
      "text/plain",
      "text/markdown",
      "text/csv",
    ]) {
      expect(
        resolveAttachmentCapability({
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          mime,
        }).ingestible,
      ).toBe(true);
    }
  });

  it("Gemini ingests audio/video; nativeKind gemini_file_data", () => {
    const v = resolveAttachmentCapability({
      provider: "gemini",
      model: "gemini-2.5-flash",
      mime: "video/mp4",
    });
    expect(v).toMatchObject({ ingestible: true, nativeKind: "gemini_file_data" });
  });

  it("Office/zip is NEVER natively ingestible (no extraction path)", () => {
    for (const provider of ["openai", "anthropic", "gemini"] as const) {
      const d = resolveAttachmentCapability({
        provider,
        model:
          provider === "openai"
            ? "gpt-5.5"
            : provider === "anthropic"
              ? "claude-sonnet-4-6"
              : "gemini-2.5-flash",
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      });
      expect(d.ingestible).toBe(false);
    }
  });

  it("oversize → structured reason; unknown provider/model → reason (never silent yes)", () => {
    const big = resolveAttachmentCapability({
      provider: "openai",
      model: "gpt-5.5",
      mime: "application/pdf",
      size: 999 * 1024 * 1024,
    });
    expect(big.ingestible).toBe(false);
    if (!big.ingestible) expect(big.reason).toMatch(/exceeds/);
    const unknown = resolveAttachmentCapability({
      provider: "openai",
      model: "some-future-model",
      mime: "application/pdf",
    });
    expect(unknown.ingestible).toBe(false);
  });

  it("registry is non-empty and every rule has a native kind", () => {
    expect(CAPABILITY_RULES.length).toBeGreaterThanOrEqual(3);
    for (const r of CAPABILITY_RULES) {
      expect(r.nativeKind).toBeTruthy();
      expect(r.maxBytes).toBeGreaterThan(0);
    }
  });
});

// cinatra#1891 DEFECT-3: OpenAI's `input_file` (context-stuffing) path derives
// the file FORMAT from the filename extension — an extensionless / unrecognized
// name is a deterministic 400 even when the bytes ARE a supported format. These
// helpers are the single authority that turns an ingestible mime into a
// provider-recognized extension (and recognizes an already-good filename).
describe("extensionForIngestibleMime (cinatra#1891 DEFECT-3)", () => {
  it("maps each COMMON_DOC ingestible mime to its canonical extension", () => {
    expect(extensionForIngestibleMime("application/pdf")).toBe(".pdf");
    expect(extensionForIngestibleMime("text/plain")).toBe(".txt");
    expect(extensionForIngestibleMime("text/markdown")).toBe(".md");
    expect(extensionForIngestibleMime("text/csv")).toBe(".csv");
    expect(extensionForIngestibleMime("application/json")).toBe(".json");
  });

  it("maps concrete image mimes (image/* prefix admits these)", () => {
    expect(extensionForIngestibleMime("image/png")).toBe(".png");
    expect(extensionForIngestibleMime("image/jpeg")).toBe(".jpg");
    expect(extensionForIngestibleMime("image/webp")).toBe(".webp");
  });

  it("derives an extension for ANY admitted image/* subtype not in the table (peer-review r3: image/gif)", () => {
    // The capability rule admits image/* by prefix, so a subtype the explicit
    // table omits must still get an extension (never an extensionless upload).
    expect(extensionForIngestibleMime("image/gif")).toBe(".gif");
    expect(extensionForIngestibleMime("image/svg+xml")).toBe(".svg"); // strip +suffix
    expect(extensionForIngestibleMime("image/bmp")).toBe(".bmp");
    expect(filenameExtensionMatchesMime("anim.gif", "image/gif")).toBe(true);
    expect(filenameExtensionMatchesMime("anim.png", "image/gif")).toBe(false); // wrong subtype
  });

  it("does NOT derive a malformed extension for dotted/vendor image subtypes (peer-review r4)", () => {
    // `.vnd.microsoft.icon` cannot round-trip through extensionOf (last dot) →
    // would drive a re-append. Return null instead of guessing.
    expect(extensionForIngestibleMime("image/vnd.microsoft.icon")).toBeNull();
    expect(extensionForIngestibleMime("image/x-icon")).toBeNull();
    // Round-trip holds for the simple subtypes it DOES derive (no re-append).
    for (const mime of ["image/gif", "image/bmp", "image/svg+xml"]) {
      const ext = extensionForIngestibleMime(mime)!;
      expect(filenameExtensionMatchesMime(`file${ext}`, mime)).toBe(true);
    }
  });

  it("normalizes charset params + case before lookup", () => {
    expect(extensionForIngestibleMime("text/markdown; charset=utf-8")).toBe(".md");
    expect(extensionForIngestibleMime("  TEXT/PLAIN ")).toBe(".txt");
  });

  it("returns null for non-ingestible / unknown mimes (never guesses)", () => {
    expect(extensionForIngestibleMime("application/zip")).toBeNull();
    expect(
      extensionForIngestibleMime(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBeNull();
    expect(extensionForIngestibleMime("image/*")).toBeNull(); // a bare prefix has no one extension
    expect(extensionForIngestibleMime("audio/mpeg")).toBeNull();
    expect(extensionForIngestibleMime("")).toBeNull();
  });

  // Cross-check against the capability registry's OWN ingestible decision so
  // this is not a duplicated literal list (peer-review r2): every COMMON_DOC mime the
  // OpenAI rule ingests must have a canonical extension, and every mime WITH an
  // extension must be ingestible — the two authorities cannot drift apart.
  it("the extension map agrees with resolveAttachmentCapability's ingestible set", () => {
    for (const mime of [
      "application/pdf",
      "text/plain",
      "text/markdown",
      "text/csv",
      "application/json",
      "image/png",
      "image/jpeg",
      "image/webp",
    ]) {
      const ingestible = resolveAttachmentCapability({
        provider: "openai",
        model: "gpt-5.5",
        mime,
      }).ingestible;
      const ext = extensionForIngestibleMime(mime);
      // ingestible ⇔ has a canonical extension.
      expect(Boolean(ext)).toBe(ingestible);
      if (ext) expect(ext).toMatch(/^\.[a-z0-9]+$/);
    }
    // A non-ingestible mime has no extension.
    expect(extensionForIngestibleMime("application/zip")).toBeNull();
  });
});

describe("filenameExtensionMatchesMime (cinatra#1891 DEFECT-3, MIME-AWARE — peer-review r2)", () => {
  it("true only when the filename extension matches the AUTHORITATIVE mime (canonical + aliases)", () => {
    expect(filenameExtensionMatchesMime("q3-plan.md", "text/markdown")).toBe(true);
    expect(filenameExtensionMatchesMime("q3-plan.markdown", "text/markdown")).toBe(true);
    expect(filenameExtensionMatchesMime("notes.txt", "text/plain")).toBe(true);
    expect(filenameExtensionMatchesMime("data.csv", "text/csv")).toBe(true);
    expect(filenameExtensionMatchesMime("payload.json", "application/json")).toBe(true);
    expect(filenameExtensionMatchesMime("report.pdf", "application/pdf")).toBe(true);
    expect(filenameExtensionMatchesMime("photo.jpg", "image/jpeg")).toBe(true);
    expect(filenameExtensionMatchesMime("photo.jpeg", "image/jpeg")).toBe(true);
    expect(filenameExtensionMatchesMime("shot.webp", "image/webp")).toBe(true);
    expect(filenameExtensionMatchesMime("UPPER.MD", "text/markdown")).toBe(true); // case-insensitive
    expect(filenameExtensionMatchesMime("x.md", "text/markdown; charset=utf-8")).toBe(true); // mime params
  });

  it("FALSE when the extension belongs to a DIFFERENT mime (the codex-r2 bug: .pdf on markdown bytes)", () => {
    expect(filenameExtensionMatchesMime("report.pdf", "text/markdown")).toBe(false);
    expect(filenameExtensionMatchesMime("data.csv", "application/json")).toBe(false);
    expect(filenameExtensionMatchesMime("photo.png", "image/jpeg")).toBe(false);
  });

  it("false for extensionless names (the DEFECT-3 bare-UUID case), unknown ext, or non-ingestible mime", () => {
    expect(filenameExtensionMatchesMime("a3f9c1e2-0000-4000-8000-000000000000", "text/markdown")).toBe(false);
    expect(filenameExtensionMatchesMime("scratch", "text/plain")).toBe(false);
    expect(filenameExtensionMatchesMime("archive.zip", "text/plain")).toBe(false);
    expect(filenameExtensionMatchesMime("trailing.", "text/plain")).toBe(false);
    expect(filenameExtensionMatchesMime(".hidden", "text/plain")).toBe(false); // leading dot only
    expect(filenameExtensionMatchesMime("", "text/plain")).toBe(false);
    expect(filenameExtensionMatchesMime("bundle.zip", "application/zip")).toBe(false); // mime not ingestible
  });
});
