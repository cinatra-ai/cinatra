import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlobTooLargeError } from "@cinatra-ai/artifacts";
import { createLocalDiskBlobStore } from "../local-disk-blob-store";

// Local-disk BlobStore coverage. Root vitest config supplies the
// server-only stub + the @cinatra-ai/artifacts alias.

async function* bytes(...chunks: string[]): AsyncIterable<Uint8Array> {
  for (const c of chunks) yield new TextEncoder().encode(c);
}

describe("createLocalDiskBlobStore", () => {
  let root: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "v5-blob-"));
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(root);
  });
  afterEach(() => {
    cwdSpy.mockRestore();
    rmSync(root, { recursive: true, force: true });
  });

  it("put → sha256 + size + scoped key; open round-trips bytes", async () => {
    const store = createLocalDiskBlobStore();
    const scope = { orgId: "org1", artifactId: "art1", representationRevisionId: "v1" };
    const rec = await store.put({
      ...scope,
      stream: bytes("hello ", "world"),
      maxBytes: 1024,
    });
    expect(rec.sizeBytes).toBe(11);
    expect(rec.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(rec.storageKey).toBe(
      `orgs/org1/artifacts/art1/versions/v1/${rec.blobId}.bin`,
    );
    const handle = await store.open({ ...scope, blobId: rec.blobId });
    let out = "";
    for await (const c of handle.stream) out += new TextDecoder().decode(c);
    expect(out).toBe("hello world");
  });

  it("enforces maxBytes (BlobTooLargeError)", async () => {
    const store = createLocalDiskBlobStore();
    await expect(
      store.put({
        orgId: "o",
        artifactId: "a",
        representationRevisionId: "v",
        stream: bytes("x".repeat(100)),
        maxBytes: 10,
      }),
    ).rejects.toBeInstanceOf(BlobTooLargeError);
  });

  it("rejects path-traversal scope segments", async () => {
    const store = createLocalDiskBlobStore();
    await expect(
      store.put({
        orgId: "../../etc",
        artifactId: "a",
        representationRevisionId: "v",
        stream: bytes("x"),
        maxBytes: 64,
      }),
    ).rejects.toThrow(/unsafe orgId/);
  });

  it("sniffs PNG magic bytes over a wrong declaredMime", async () => {
    const store = createLocalDiskBlobStore();
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2,
    ]);
    async function* one() {
      yield png;
    }
    const rec = await store.put({
      orgId: "o",
      artifactId: "a",
      representationRevisionId: "v",
      stream: one(),
      declaredMime: "text/plain",
      maxBytes: 64,
    });
    expect(rec.mimeDetected).toBe("image/png");
  });

  // Media container sniffs. These heads are deliberately NUL-free where
  // the real container allows it — the regression they pin is the UTF-8
  // text heuristic swallowing media bytes as text/plain.
  async function sniffOf(head: number[], declaredMime?: string) {
    const store = createLocalDiskBlobStore();
    const bytes = new Uint8Array(head);
    async function* one() {
      yield bytes;
    }
    const rec = await store.put({
      orgId: "o",
      artifactId: "a",
      representationRevisionId: "v",
      stream: one(),
      declaredMime,
      maxBytes: 64,
    });
    return rec.mimeDetected;
  }
  const ftypHead = [
    0x18, 0x18, 0x18, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
    0x18, 0x18, 0x18, 0x18,
  ];
  // EBML header bytes as emitted by real WebM muxers — no NUL in 16 bytes.
  const ebmlHead = [
    0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81,
    0x01, 0x42, 0xf2, 0x81,
  ];
  // "RIFF" + NUL-free size + "WAVE" + "fmt " — the text-heuristic trap.
  const wavHead = [
    0x52, 0x49, 0x46, 0x46, 0x40, 0x12, 0x33, 0x01, 0x57, 0x41, 0x56, 0x45,
    0x66, 0x6d, 0x74, 0x20,
  ];
  const webpHead = [
    0x52, 0x49, 0x46, 0x46, 0x40, 0x12, 0x33, 0x01, 0x57, 0x45, 0x42, 0x50,
    0x56, 0x50, 0x38, 0x20,
  ];

  it("sniffs ISO-BMFF (ftyp) honouring a declared media MIME", async () => {
    expect(await sniffOf(ftypHead, "audio/x-m4a")).toBe("audio/x-m4a");
    expect(await sniffOf(ftypHead, "video/mp4")).toBe("video/mp4");
    // Non-media declaration cannot ride the container: default video/mp4.
    expect(await sniffOf(ftypHead, "text/plain")).toBe("video/mp4");
    expect(await sniffOf(ftypHead)).toBe("video/mp4");
  });

  it("pins ftyp qt-brand (QuickTime) to video/quicktime — never promoted to the allowlisted video/mp4", async () => {
    // `....ftypqt  ` — the QuickTime major brand. Deliberately excluded
    // from PREVIEW_INLINE_MIME_ALLOWLIST; a generic/missing declared MIME
    // must NOT let it ride the inline preview path as video/mp4.
    const ftypQtHead = [
      0x18, 0x18, 0x18, 0x18, 0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20,
      0x18, 0x18, 0x18, 0x18,
    ];
    expect(await sniffOf(ftypQtHead)).toBe("video/quicktime");
    expect(await sniffOf(ftypQtHead, "application/octet-stream")).toBe("video/quicktime");
    expect(await sniffOf(ftypQtHead, "video/mp4")).toBe("video/quicktime");
  });

  it("sniffs declared-confirmed ADTS AAC as audio/aac (not text/plain)", async () => {
    // ADTS sync 0xFFF / layer 00 with a NUL-free head — the text-heuristic
    // trap. Declared-confirmed only (same weak-signature rule as MP3).
    const adtsHead = [0xff, 0xf1, 0x4c, 0x80, 0x20, 0x20, 0x20, 0x20];
    expect(await sniffOf(adtsHead, "audio/aac")).toBe("audio/aac");
    // Without the declared confirmation the weak sync stays heuristic text.
    expect(await sniffOf(adtsHead)).toBe("text/plain");
  });

  it("sniffs EBML as webm (not text/plain) and honours audio/webm", async () => {
    expect(await sniffOf(ebmlHead, "video/webm")).toBe("video/webm");
    expect(await sniffOf(ebmlHead, "audio/webm")).toBe("audio/webm");
    expect(await sniffOf(ebmlHead)).toBe("video/webm");
  });

  it("sniffs RIFF/WAVE as audio/wav and RIFF/WEBP as image/webp (not text/plain)", async () => {
    expect(await sniffOf(wavHead, "audio/wav")).toBe("audio/wav");
    expect(await sniffOf(wavHead)).toBe("audio/wav");
    expect(await sniffOf(webpHead, "image/webp")).toBe("image/webp");
  });

  it("sniffs ID3 + declared-confirmed bare-frame MP3 as audio/mpeg", async () => {
    const id3Head = [0x49, 0x44, 0x33, 0x04, 0x01, 0x20, 0x20, 0x20];
    expect(await sniffOf(id3Head, "text/plain")).toBe("audio/mpeg");
    const frameHead = [0xff, 0xfb, 0x90, 0x64, 0x20, 0x20, 0x20, 0x20];
    expect(await sniffOf(frameHead, "audio/mpeg")).toBe("audio/mpeg");
    // Bare frame sync WITHOUT the declared confirmation stays heuristic
    // text (too weak a signature to overrule the declaration path).
    expect(await sniffOf(frameHead)).toBe("text/plain");
  });

  it("sniffs fLaC and OggS containers", async () => {
    const flacHead = [0x66, 0x4c, 0x61, 0x43, 0x20, 0x20, 0x20, 0x22];
    expect(await sniffOf(flacHead)).toBe("audio/flac");
    const oggHead = [0x4f, 0x67, 0x67, 0x53, 0x02, 0x20, 0x20, 0x20];
    expect(await sniffOf(oggHead)).toBe("audio/ogg");
    expect(await sniffOf(oggHead, "video/ogg")).toBe("video/ogg");
  });
});
