import { inflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// cinatra#3459: the widget's review island draws media only through the byte
// road, and no fixture filed the six kinds it serves. These cases require one.

const mock = vi.hoisted(() => {
  process.env.BETTER_AUTH_SECRET ??= "dev-media-kinds-placeholder-not-a-credential";
  return { resolve: vi.fn(), upload: vi.fn(), register: vi.fn(), member: vi.fn() };
});
vi.mock("@/lib/register-all-object-types", () => ({ registerAllObjectTypes: mock.register }));
vi.mock("@/lib/artifacts/upload-artifact-type-map", () => ({ resolveUploadArtifactType: mock.resolve }));
vi.mock("@/lib/artifacts/artifact-service", () => ({ createUploadedArtifact: mock.upload }));
vi.mock("@/lib/better-auth-db", () => ({ readUserIsOrgMember: mock.member }));

import { MEDIA_BYTE_ROAD_KINDS, mediaByteRoadKindFor } from "@/lib/lifecycle/review-island-byte-road";
import { sniffMime } from "@/lib/artifacts/local-disk-blob-store";
import { crc32, mediaKindSamples } from "../../../scripts/fixtures/lib/media-kind-samples";
import { fileMediaKindSamples, seedMediaKindReviewRun } from "../../../scripts/fixtures/lib/file-media-kinds";

const sample = (kind: string) => {
  const found = mediaKindSamples().find((s) => s.kind === kind);
  if (!found) throw new Error(`no ${kind} sample`);
  return found.bytes;
};

/** The entries of a ZIP, read from its central directory, CRC-checked. */
function zipEntries(bytes: Buffer) {
  // The end record carries no comment, so it closes the file, and the central
  // directory ends where the end record starts.
  const end = bytes.length - 22;
  expect(bytes.readUInt32LE(end)).toBe(0x06054b50);
  expect(bytes.readUInt16LE(end + 20)).toBe(0);
  const count = bytes.readUInt16LE(end + 10);
  expect(bytes.readUInt16LE(end + 8)).toBe(count);
  let at = bytes.readUInt32LE(end + 16);
  expect(at + bytes.readUInt32LE(end + 12)).toBe(end);
  const entries = new Map<string, Buffer>();
  for (let i = 0; i < count; i += 1) {
    expect(bytes.readUInt32LE(at)).toBe(0x02014b50);
    const method = bytes.readUInt16LE(at + 10), crc = bytes.readUInt32LE(at + 16), size = bytes.readUInt32LE(at + 24);
    expect(method, "stored entries only").toBe(0);
    expect(bytes.readUInt32LE(at + 20), "stored size").toBe(size);
    const nameLength = bytes.readUInt16LE(at + 28), extra = bytes.readUInt16LE(at + 30), comment = bytes.readUInt16LE(at + 32);
    const local = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    expect(bytes.readUInt32LE(local)).toBe(0x04034b50);
    // The local header agrees with the central entry: method, CRC, sizes and name.
    expect(bytes.readUInt16LE(local + 8), `${name} local method`).toBe(method);
    expect(bytes.readUInt32LE(local + 14), `${name} local CRC`).toBe(crc);
    expect(bytes.readUInt32LE(local + 18), `${name} local size`).toBe(size);
    expect(bytes.readUInt32LE(local + 22), `${name} local size`).toBe(size);
    expect(bytes.subarray(local + 30, local + 30 + bytes.readUInt16LE(local + 26)).toString("utf8")).toBe(name);
    const dataAt = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const data = bytes.subarray(dataAt, dataAt + size);
    expect(crc32(data), `${name} CRC`).toBe(crc);
    entries.set(name, data);
    at += 46 + nameLength + extra + comment;
  }
  return entries;
}

describe("development media kind samples (#3459)", () => {
  it("cover exactly the six kinds of the byte road, each under a form of its own kind", () => {
    const samples = mediaKindSamples();
    expect(samples.map((s) => s.kind).sort()).toEqual(Object.keys(MEDIA_BYTE_ROAD_KINDS).sort());
    for (const s of samples) expect(mediaByteRoadKindFor(s.mime), s.kind).toBe(s.kind);
  });

  it("are detected by the blob store as the form they are filed under", () => {
    for (const s of mediaKindSamples()) expect(sniffMime(s.bytes.subarray(0, 512), s.mime), s.kind).toBe(s.mime);
  });

  it("are the same bytes on every call", () => {
    const [a, b] = [mediaKindSamples(), mediaKindSamples()];
    for (let i = 0; i < a.length; i += 1) expect(a[i].bytes.equals(b[i].bytes), a[i].kind).toBe(true);
  });

  it("make a PNG whose chunks check and whose pixels inflate to its size", () => {
    const png = sample("image");
    let at = 8;
    const chunks = new Map<string, Buffer>();
    while (at < png.length) {
      const length = png.readUInt32BE(at);
      const typed = png.subarray(at + 4, at + 8 + length);
      expect(crc32(typed)).toBe(png.readUInt32BE(at + 8 + length));
      chunks.set(typed.subarray(0, 4).toString("latin1"), typed.subarray(4));
      at += 12 + length;
    }
    const ihdr = chunks.get("IHDR")!;
    const [width, height] = [ihdr.readUInt32BE(0), ihdr.readUInt32BE(4)];
    expect(inflateSync(chunks.get("IDAT")!).length).toBe(height * (1 + width * 3));
    expect(chunks.has("IEND")).toBe(true);
  });

  it("make a WebM video, a PCM WAV and a PDF whose cross references point at their objects", () => {
    const webm = sample("video");
    expect(webm.subarray(0, 4).toString("hex")).toBe("1a45dfa3");
    expect(webm.includes(Buffer.from("webm"))).toBe(true);
    expect(webm.includes(Buffer.from("V_VP8"))).toBe(true);

    const wav = sample("audio");
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
    expect(wav.subarray(36, 40).toString("latin1")).toBe("data");
    expect(wav.readUInt32LE(40)).toBe(wav.length - 44);

    const pdf = sample("pdf").toString("latin1");
    const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(pdf)?.[1]);
    expect(pdf.slice(startxref, startxref + 4)).toBe("xref");
    const offsets = [...pdf.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(offsets).toHaveLength(5);
    offsets.forEach((offset, i) => expect(pdf.slice(offset).startsWith(`${i + 1} 0 obj`)).toBe(true));
  });

  it("make a Word document and an archive whose entries check", () => {
    const docx = zipEntries(sample("document"));
    expect([...docx.keys()]).toEqual(["[Content_Types].xml", "_rels/.rels", "word/document.xml"]);
    expect(docx.get("word/document.xml")!.toString("utf8")).toContain("<w:t>");
    expect([...zipEntries(sample("archive")).keys()]).toEqual(["README.txt", "data/sample.csv"]);
  });
});

describe("development media kind filing (#3459)", () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("CINATRA_RUNTIME_MODE", "development");
    mock.member.mockResolvedValue(true);
    mock.resolve.mockImplementation((mime: string) => ({ ok: true, objectTypeId: `type-for:${mime}` }));
    let n = 0;
    mock.upload.mockImplementation(async () => { n += 1; return { artifactId: `artifact-${n}`, representationRevisionId: `revision-${n}` }; });
  });

  it("files each kind's exact bytes as the user's private upload and returns the six review targets", async () => {
    const filed = await fileMediaKindSamples({ orgId: "org", userId: "user" });
    const samples = mediaKindSamples();
    expect(filed.map((f) => f.kind)).toEqual(samples.map((s) => s.kind));
    expect(mock.upload).toHaveBeenCalledTimes(6);
    for (const [i, s] of samples.entries()) {
      const input = mock.upload.mock.calls[i][0];
      expect(input).toMatchObject({
        orgId: "org", createdBy: "user", ownerLevel: "user", ownerId: "user", visibility: "private",
        declaredMime: s.mime, originKind: "upload", skipFallbackClassification: true,
      });
      const chunks: Uint8Array[] = [];
      for await (const bytes of input.stream) chunks.push(bytes);
      expect(Buffer.concat(chunks).equals(s.bytes), s.kind).toBe(true);
      expect(filed[i]).toEqual({
        kind: s.kind, mime: s.mime, objectType: `type-for:${s.mime}`,
        artifactId: `artifact-${i + 1}`, representationRevisionId: `revision-${i + 1}`,
      });
    }
  });

  it("files nothing when any kind has no installed upload type", async () => {
    mock.resolve.mockImplementation((mime: string) => mime === "audio/wav"
      ? { ok: false, kind: "no_type", reason: "no required type accepts audio/wav", matched: [] }
      : { ok: true, objectTypeId: `type-for:${mime}` });
    await expect(fileMediaKindSamples({ orgId: "org", userId: "user" })).rejects.toThrow(/audio sample.*nothing was filed/);
    expect(mock.upload).not.toHaveBeenCalled();
  });

  it("uses the trimmed ids for the membership read and every write", async () => {
    await fileMediaKindSamples({ orgId: " org ", userId: "\tuser " });
    expect(mock.member).toHaveBeenCalledWith("user", "org");
    for (const [input] of mock.upload.mock.calls) {
      expect(input).toMatchObject({ orgId: "org", createdBy: "user", ownerId: "user" });
    }
  });

  it("files nothing for a user who is not a member of the organization", async () => {
    mock.member.mockResolvedValue(false);
    await expect(fileMediaKindSamples({ orgId: "org", userId: "user" })).rejects.toThrow(/not a member of the organization.*nothing was filed/);
    expect(mock.resolve).not.toHaveBeenCalled();
    expect(mock.upload).not.toHaveBeenCalled();
  });

  it("files nothing for an empty organization or user", async () => {
    await expect(fileMediaKindSamples({ orgId: "  ", userId: "user" })).rejects.toThrow(/nonempty/);
    await expect(fileMediaKindSamples({ orgId: "org", userId: "" })).rejects.toThrow(/nonempty/);
    expect(mock.member).not.toHaveBeenCalled();
    expect(mock.upload).not.toHaveBeenCalled();
  });

  it("refuses outside the development runtime before any write", async () => {
    vi.stubEnv("CINATRA_RUNTIME_MODE", "production");
    await expect(fileMediaKindSamples({ orgId: "org", userId: "user" })).rejects.toThrow(/CINATRA_RUNTIME_MODE=development/);
    expect(mock.resolve).not.toHaveBeenCalled();
    expect(mock.upload).not.toHaveBeenCalled();
  });
});

describe("development media kind review run (#3459)", () => {
  const filed = ["image", "video", "audio", "pdf", "document", "archive"].map((kind, i) => ({
    kind, mime: `form-${i}`, objectType: `type-${i}`, artifactId: `artifact-${i}`, representationRevisionId: `revision-${i}`,
  })) as Parameters<typeof seedMediaKindReviewRun>[0]["filed"];
  const targets = filed.map(({ artifactId, representationRevisionId }) => ({ artifactId, representationRevisionId }));
  const harness = (pinned: typeof targets) => ({
    seedMarkedReviewGateRun: vi.fn(async () => "run"),
    waitForMarkedReviewGate: vi.fn(async () => ({ gateId: "gate", runId: "run", reviewTaskId: "task", status: "pending", pinnedTargets: pinned })),
  });

  it("seeds the run with the trimmed ids and the six targets, and accepts a gate that pins exactly them", async () => {
    const h = harness([...targets].reverse());
    await expect(seedMediaKindReviewRun({ orgId: " org ", userId: " user ", filed }, h))
      .resolves.toEqual({ runId: "run", reviewTaskId: "task", status: "pending", pinned: 6 });
    expect(h.seedMarkedReviewGateRun).toHaveBeenCalledWith({ orgId: "org", userId: "user", targets });
  });

  it("fails when the gate misses a target, pins a foreign one or pins one twice", async () => {
    const foreign = { artifactId: "artifact-x", representationRevisionId: "revision-x" };
    for (const pinned of [targets.slice(1), [...targets.slice(1), foreign], [...targets.slice(1), targets[1]], [...targets, foreign]]) {
      await expect(seedMediaKindReviewRun({ orgId: "org", userId: "user", filed }, harness(pinned)))
        .rejects.toThrow(/does not pin exactly the six filed revisions/);
    }
  });

  it("refuses to seed for anything but the six filed kinds", async () => {
    const h = harness(targets);
    await expect(seedMediaKindReviewRun({ orgId: "org", userId: "user", filed: filed.slice(1) }, h)).rejects.toThrow(/six filed/);
    expect(h.seedMarkedReviewGateRun).not.toHaveBeenCalled();
  });
});
