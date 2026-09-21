import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BlobTooLargeError } from "@cinatra-ai/artifacts";

// artifact-data-root reads the DB metadata key via @/lib/database — stub it
// so the unit graph stays DB-free (env unset + null metadata ⇒ the default
// cwd-relative `data/artifacts` root, i.e. the historical layout).
vi.mock("@/lib/database", () => ({
  readMetadataValueFromDatabase: () => null,
  writeMetadataValueToDatabase: () => {},
}));

import {
  ARTIFACT_ORG_QUOTA_BYTES_ENV,
  ARTIFACT_QUOTA_MODE_ENV,
  ARTIFACT_STAGING_CAP_BYTES_ENV,
  ARTIFACT_STAGING_DIR_NAME,
  ArtifactQuotaExceededError,
  createLocalDiskBlobStore,
  isContentAddressedStorageKey,
  sha256FromContentAddressedKey,
} from "../local-disk-blob-store";

// Local-disk BlobStore coverage. Root vitest config supplies the
// server-only stub + the @cinatra-ai/artifacts alias.

async function* bytes(...chunks: string[]): AsyncIterable<Uint8Array> {
  for (const c of chunks) yield new TextEncoder().encode(c);
}

const QUOTA_ENVS = [
  ARTIFACT_ORG_QUOTA_BYTES_ENV,
  ARTIFACT_QUOTA_MODE_ENV,
  ARTIFACT_STAGING_CAP_BYTES_ENV,
] as const;

describe("createLocalDiskBlobStore", () => {
  let root: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;
  const priorEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "v5-blob-"));
    cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(root);
    for (const k of QUOTA_ENVS) {
      priorEnv[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    cwdSpy.mockRestore();
    rmSync(root, { recursive: true, force: true });
    for (const k of QUOTA_ENVS) {
      if (priorEnv[k] === undefined) delete process.env[k];
      else process.env[k] = priorEnv[k];
    }
  });

  const dataRoot = () => path.join(root, "data", "artifacts");

  it("put → sha256 + size + org-scoped CONTENT-ADDRESSED key; openByStorageKey round-trips bytes", async () => {
    const store = createLocalDiskBlobStore();
    const scope = { orgId: "org1", artifactId: "art1", representationRevisionId: "v1" };
    const rec = await store.put({
      ...scope,
      stream: bytes("hello ", "world"),
      maxBytes: 1024,
    });
    expect(rec.sizeBytes).toBe(11);
    expect(rec.sha256).toMatch(/^[a-f0-9]{64}$/);
    // orgs/<org>/blobs/sha256/<aa>/<sha>.bin — org IN the path, extension
    // and blobId NOT in the path.
    expect(rec.storageKey).toBe(
      `orgs/org1/blobs/sha256/${rec.sha256.slice(0, 2)}/${rec.sha256}.bin`,
    );
    expect(isContentAddressedStorageKey(rec.storageKey)).toBe(true);
    expect(sha256FromContentAddressedKey(rec.storageKey)).toBe(rec.sha256);
    const handle = await store.openByStorageKey({
      orgId: "org1",
      storageKey: rec.storageKey,
    });
    let out = "";
    for await (const c of handle.stream) out += new TextDecoder().decode(c);
    expect(out).toBe("hello world");
    // The staging dir holds no residue after a successful publish.
    expect(readdirSync(path.join(dataRoot(), ARTIFACT_STAGING_DIR_NAME))).toEqual([]);
  });

  it("same bytes twice → SAME storage key, one file, both puts succeed (deterministic concurrent-write handling)", async () => {
    const store = createLocalDiskBlobStore();
    const scope = { orgId: "org1", artifactId: "artA", representationRevisionId: "v1" };
    const a = await store.put({ ...scope, stream: bytes("same-bytes"), maxBytes: 1024 });
    const b = await store.put({
      ...scope,
      artifactId: "artB",
      stream: bytes("same-bytes"),
      maxBytes: 1024,
    });
    expect(b.storageKey).toBe(a.storageKey);
    expect(b.sha256).toBe(a.sha256);
    expect(b.blobId).not.toBe(a.blobId); // row id stays fresh per put
    expect(existsSync(path.join(dataRoot(), a.storageKey))).toBe(true);
    expect(readdirSync(path.join(dataRoot(), ARTIFACT_STAGING_DIR_NAME))).toEqual([]);
  });

  it("different bytes → different content-addressed keys", async () => {
    const store = createLocalDiskBlobStore();
    const scope = { orgId: "org1", artifactId: "a", representationRevisionId: "v" };
    const a = await store.put({ ...scope, stream: bytes("one"), maxBytes: 64 });
    const b = await store.put({ ...scope, stream: bytes("two"), maxBytes: 64 });
    expect(a.storageKey).not.toBe(b.storageKey);
  });

  it("LEGACY scope-derived keys stay readable (openByStorageKey + scope-keyed open)", async () => {
    const legacyKey = "orgs/org1/artifacts/art1/versions/v1/blob-1.bin";
    const abs = path.join(dataRoot(), legacyKey);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, "legacy bytes");
    const store = createLocalDiskBlobStore();
    const byKey = await store.openByStorageKey({ orgId: "org1", storageKey: legacyKey });
    let out = "";
    for await (const c of byKey.stream) out += new TextDecoder().decode(c);
    expect(out).toBe("legacy bytes");
    const byScope = await store.open({
      orgId: "org1",
      artifactId: "art1",
      representationRevisionId: "v1",
      blobId: "blob-1",
    });
    out = "";
    for await (const c of byScope.stream) out += new TextDecoder().decode(c);
    expect(out).toBe("legacy bytes");
  });

  it("enforces maxBytes (BlobTooLargeError) and leaves no staging/final residue", async () => {
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
    expect(readdirSync(path.join(dataRoot(), ARTIFACT_STAGING_DIR_NAME))).toEqual([]);
    expect(existsSync(path.join(dataRoot(), "orgs"))).toBe(false);
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

  describe("reachability-guarded content-addressed delete", () => {
    it("keeps a YOUNG content-addressed file (grace window) without consulting reachability", async () => {
      const isReferenced = vi.fn().mockResolvedValue(false);
      const store = createLocalDiskBlobStore({ isStorageKeyReferenced: isReferenced });
      const rec = await store.put({
        orgId: "org1",
        artifactId: "a",
        representationRevisionId: "v",
        stream: bytes("fresh"),
        maxBytes: 64,
      });
      await store.deleteByStorageKey({ orgId: "org1", storageKey: rec.storageKey });
      expect(existsSync(path.join(dataRoot(), rec.storageKey))).toBe(true);
      expect(isReferenced).not.toHaveBeenCalled();
    });

    it("keeps an OLD content-addressed file while a live row references it", async () => {
      const store = createLocalDiskBlobStore({ isStorageKeyReferenced: () => true });
      const rec = await store.put({
        orgId: "org1",
        artifactId: "a",
        representationRevisionId: "v",
        stream: bytes("kept"),
        maxBytes: 64,
      });
      const abs = path.join(dataRoot(), rec.storageKey);
      const old = new Date(Date.now() - 60 * 60 * 1000);
      utimesSync(abs, old, old);
      await store.deleteByStorageKey({ orgId: "org1", storageKey: rec.storageKey });
      expect(existsSync(abs)).toBe(true);
    });

    it("deletes an OLD, unreferenced content-addressed file", async () => {
      const store = createLocalDiskBlobStore({ isStorageKeyReferenced: () => false });
      const rec = await store.put({
        orgId: "org1",
        artifactId: "a",
        representationRevisionId: "v",
        stream: bytes("gone"),
        maxBytes: 64,
      });
      const abs = path.join(dataRoot(), rec.storageKey);
      const old = new Date(Date.now() - 60 * 60 * 1000);
      utimesSync(abs, old, old);
      await store.deleteByStorageKey({ orgId: "org1", storageKey: rec.storageKey });
      expect(existsSync(abs)).toBe(false);
    });

    it("re-put of the SAME bytes refreshes mtime, re-arming the grace window", async () => {
      const store = createLocalDiskBlobStore({ isStorageKeyReferenced: () => false });
      const scope = { orgId: "org1", artifactId: "a", representationRevisionId: "v" };
      const rec = await store.put({ ...scope, stream: bytes("reused"), maxBytes: 64 });
      const abs = path.join(dataRoot(), rec.storageKey);
      const old = new Date(Date.now() - 60 * 60 * 1000);
      utimesSync(abs, old, old);
      // Second writer reuses the existing file → mtime refreshed to now.
      await store.put({ ...scope, stream: bytes("reused"), maxBytes: 64 });
      await store.deleteByStorageKey({ orgId: "org1", storageKey: rec.storageKey });
      expect(existsSync(abs)).toBe(true); // young again → kept
    });

    it("keeps the file when a concurrent writer refreshes mtime DURING the reachability probe", async () => {
      // Simulates the put()-reuses-file-while-GC-probes race: the injected
      // probe refreshes the file's mtime (what a concurrent put() does
      // before committing its row) and reports unreferenced. The post-probe
      // mtime re-check must keep the file.
      const scope = { orgId: "org1", artifactId: "a", representationRevisionId: "v" };
      const store = createLocalDiskBlobStore({
        isStorageKeyReferenced: (_org, key) => {
          const now = new Date();
          utimesSync(path.join(dataRoot(), key), now, now);
          return false;
        },
      });
      const rec = await store.put({ ...scope, stream: bytes("raced"), maxBytes: 64 });
      const abs = path.join(dataRoot(), rec.storageKey);
      const old = new Date(Date.now() - 60 * 60 * 1000);
      utimesSync(abs, old, old);
      await store.deleteByStorageKey({ orgId: "org1", storageKey: rec.storageKey });
      expect(existsSync(abs)).toBe(true);
    });

    it("per-key critical section: a same-bytes put racing the unlink never loses the bytes", async () => {
      // Deterministic interleaving of the codex-round-2 race: a guarded
      // delete is MID-SEQUENCE (probe pending) when a same-bytes put()
      // arrives. The per-storage-key mutex forces the put to wait; the
      // delete unlinks the old unreferenced file; the put then observes the
      // missing file and PUBLISHES ITS STAGED COPY. End state: bytes on
      // disk — never a returned record pointing at nothing.
      const scope = { orgId: "org1", artifactId: "a", representationRevisionId: "v" };
      let releaseProbe!: () => void;
      let releaseProbeEntered!: () => void;
      const probeEntered = new Promise<void>((r) => {
        releaseProbeEntered = r;
      });
      const probeGate = new Promise<void>((r) => {
        releaseProbe = r;
      });
      const store = createLocalDiskBlobStore({
        isStorageKeyReferenced: async () => {
          releaseProbeEntered();
          await probeGate;
          return false; // rows already GC'd
        },
      });
      const seed = await store.put({ ...scope, stream: bytes("contested"), maxBytes: 64 });
      const abs = path.join(dataRoot(), seed.storageKey);
      const old = new Date(Date.now() - 60 * 60 * 1000);
      utimesSync(abs, old, old);

      const deleting = store.deleteByStorageKey({ orgId: "org1", storageKey: seed.storageKey });
      await probeEntered; // delete holds the key lock, probe in flight
      const racingPut = store.put({ ...scope, stream: bytes("contested"), maxBytes: 64 });
      // Give the racing put a beat to reach the lock, then let the delete win.
      await new Promise((r) => setTimeout(r, 25));
      releaseProbe();
      await deleting;
      const rec = await racingPut;
      expect(rec.storageKey).toBe(seed.storageKey);
      expect(existsSync(abs)).toBe(true); // staged copy was published
    });

    it("LEGACY keys keep today's direct-delete semantics", async () => {
      const legacyKey = "orgs/org1/artifacts/art1/versions/v1/blob-1.bin";
      const abs = path.join(dataRoot(), legacyKey);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, "legacy");
      const isReferenced = vi.fn().mockResolvedValue(true);
      const store = createLocalDiskBlobStore({ isStorageKeyReferenced: isReferenced });
      await store.deleteByStorageKey({ orgId: "org1", storageKey: legacyKey });
      expect(existsSync(abs)).toBe(false);
      expect(isReferenced).not.toHaveBeenCalled();
    });
  });

  describe("WARN-first quotas", () => {
    it("org quota in default WARN mode logs and proceeds", async () => {
      process.env[ARTIFACT_ORG_QUOTA_BYTES_ENV] = "5";
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const store = createLocalDiskBlobStore({ getOrgUsageBytes: () => 10 });
        const rec = await store.put({
          orgId: "org1",
          artifactId: "a",
          representationRevisionId: "v",
          stream: bytes("over-quota-but-warn"),
          maxBytes: 64,
        });
        expect(rec.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("org-quota"));
      } finally {
        warnSpy.mockRestore();
      }
    });

    it("org quota in enforce mode rejects the put", async () => {
      process.env[ARTIFACT_ORG_QUOTA_BYTES_ENV] = "5";
      process.env[ARTIFACT_QUOTA_MODE_ENV] = "enforce";
      const store = createLocalDiskBlobStore({ getOrgUsageBytes: () => 10 });
      await expect(
        store.put({
          orgId: "org1",
          artifactId: "a",
          representationRevisionId: "v",
          stream: bytes("rejected"),
          maxBytes: 64,
        }),
      ).rejects.toBeInstanceOf(ArtifactQuotaExceededError);
    });

    it("an unanswerable org-usage read skips the check (fail-soft)", async () => {
      process.env[ARTIFACT_ORG_QUOTA_BYTES_ENV] = "5";
      process.env[ARTIFACT_QUOTA_MODE_ENV] = "enforce";
      const store = createLocalDiskBlobStore({ getOrgUsageBytes: () => null });
      const rec = await store.put({
        orgId: "org1",
        artifactId: "a",
        representationRevisionId: "v",
        stream: bytes("usage-unknown"),
        maxBytes: 64,
      });
      expect(rec.sizeBytes).toBeGreaterThan(0);
    });

    it("enforce mode bounds the INCOMING stream by the remaining headroom", async () => {
      process.env[ARTIFACT_ORG_QUOTA_BYTES_ENV] = "10";
      process.env[ARTIFACT_QUOTA_MODE_ENV] = "enforce";
      const store = createLocalDiskBlobStore({ getOrgUsageBytes: () => 4 });
      // 4 used + 20 incoming > 10 → rejected mid-stream.
      await expect(
        store.put({
          orgId: "org1",
          artifactId: "a",
          representationRevisionId: "v",
          stream: bytes("x".repeat(20)),
          maxBytes: 1024,
        }),
      ).rejects.toBeInstanceOf(ArtifactQuotaExceededError);
      // No staging residue, no final file.
      expect(readdirSync(path.join(dataRoot(), ARTIFACT_STAGING_DIR_NAME))).toEqual([]);
      expect(existsSync(path.join(dataRoot(), "orgs"))).toBe(false);
      // 4 used + 3 incoming ≤ 10 → accepted.
      const rec = await store.put({
        orgId: "org1",
        artifactId: "a",
        representationRevisionId: "v",
        stream: bytes("abc"),
        maxBytes: 1024,
      });
      expect(rec.sizeBytes).toBe(3);
    });

    it("staging-dir residency cap in enforce mode rejects the put", async () => {
      process.env[ARTIFACT_STAGING_CAP_BYTES_ENV] = "4";
      process.env[ARTIFACT_QUOTA_MODE_ENV] = "enforce";
      const staging = path.join(dataRoot(), ARTIFACT_STAGING_DIR_NAME);
      mkdirSync(staging, { recursive: true });
      writeFileSync(path.join(staging, "resident"), "xxxxxxxx"); // 8 bytes ≥ cap
      const store = createLocalDiskBlobStore();
      await expect(
        store.put({
          orgId: "org1",
          artifactId: "a",
          representationRevisionId: "v",
          stream: bytes("blocked"),
          maxBytes: 64,
        }),
      ).rejects.toBeInstanceOf(ArtifactQuotaExceededError);
    });
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
  // Sibling of `sniffOf` for the head-window arms below. `sniffOf` takes a
  // `number[]` and caps `maxBytes` at 64, and its calls above stay
  // byte-identical; these arms need buffers LARGER than the head window, so
  // they stream the bytes as they are under a maxBytes that admits them.
  async function sniffOfBytes(buf: Uint8Array, declaredMime?: string) {
    const store = createLocalDiskBlobStore();
    async function* one() {
      yield buf;
    }
    const rec = await store.put({
      orgId: "o",
      artifactId: "a",
      representationRevisionId: "v",
      stream: one(),
      declaredMime,
      maxBytes: 8192,
    });
    return rec.mimeDetected;
  }
  /** `n` bytes all in 0x80–0xbf: UTF-8 CONTINUATION bytes with no lead byte, so
   *  the buffer is invalid UTF-8 at ANY window size, and no byte is a NUL. */
  const continuationOnly = (n: number) =>
    Uint8Array.from({ length: n }, (_, i) => 0x80 + (i % 0x40));
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
    // Without the declared confirmation the weak sync still names NO media
    // type — that is what this arm guards. The head is not valid UTF-8 (0xff is
    // no lead byte), so it now reads as the binary base rather than as text.
    expect(await sniffOf(adtsHead)).toBe("application/octet-stream");
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

  it("sniffs a PK/ZIP container, honouring a declared OOXML/ODF office type (the docx-as-zip trap, #1883 A1)", async () => {
    // `PK\x03\x04` — the ZIP local-file-header magic shared by a raw archive AND
    // every OOXML/ODF office document (which are ZIP containers on disk).
    const zipHead = [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00];
    // No declaration / a non-office declaration → the raw archive type.
    expect(await sniffOf(zipHead)).toBe("application/zip");
    expect(await sniffOf(zipHead, "application/octet-stream")).toBe("application/zip");
    expect(await sniffOf(zipHead, "application/zip")).toBe("application/zip");
    // A declared office media type is a SAFE refinement of the ZIP signature and
    // wins — otherwise the writer would reject a real .docx against
    // document-artifact's office-only accepts. The DECLARED mime decides.
    expect(
      await sniffOf(
        zipHead,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(
      await sniffOf(
        zipHead,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ),
    ).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(
      await sniffOf(
        zipHead,
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ),
    ).toBe("application/vnd.openxmlformats-officedocument.presentationml.presentation");
    expect(await sniffOf(zipHead, "application/vnd.oasis.opendocument.text")).toBe(
      "application/vnd.oasis.opendocument.text",
    );
    // The office refinement requires the bytes to ACTUALLY be a ZIP container:
    // a plain-text head declared as docx does NOT ride the office branch.
    const textHead = [0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x20, 0x77, 0x6f]; // "hello wo"
    expect(
      await sniffOf(
        textHead,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).not.toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  });

  it("CANONICALIZES a parameterized declared MIME (strips `; charset=…`, lowercases) so preview eligibility matches", async () => {
    // A parameterized declaration must be stored UNPARAMETERIZED — the preview
    // eligibility gate + the representation registrar match EXACTLY against the
    // allowlist, so `application/json; charset=utf-8` stored verbatim would 415.
    const jsonHead = [0x7b, 0x22, 0x6b, 0x22, 0x3a, 0x31, 0x7d]; // {"k":1}
    expect(await sniffOf(jsonHead, "application/json; charset=utf-8")).toBe("application/json");
    expect(await sniffOf(jsonHead, "APPLICATION/JSON")).toBe("application/json");
    const csvHead = [0x61, 0x2c, 0x62, 0x2c, 0x63]; // a,b,c
    expect(await sniffOf(csvHead, "text/csv; charset=utf-8")).toBe("text/csv");
    const mdHead = [0x23, 0x20, 0x54, 0x69, 0x74, 0x6c, 0x65]; // "# Title"
    expect(await sniffOf(mdHead, "text/markdown; charset=UTF-8")).toBe("text/markdown");
    // A parameterized OFFICE declaration over a real ZIP head still canonicalizes.
    const zipHead = [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00];
    expect(
      await sniffOf(
        zipHead,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document; foo=bar",
      ),
    ).toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  });

  it("sniffs ID3 + declared-confirmed bare-frame MP3 as audio/mpeg", async () => {
    const id3Head = [0x49, 0x44, 0x33, 0x04, 0x01, 0x20, 0x20, 0x20];
    expect(await sniffOf(id3Head, "text/plain")).toBe("audio/mpeg");
    const frameHead = [0xff, 0xfb, 0x90, 0x64, 0x20, 0x20, 0x20, 0x20];
    expect(await sniffOf(frameHead, "audio/mpeg")).toBe("audio/mpeg");
    // Bare frame sync WITHOUT the declared confirmation still names NO media
    // type (too weak a signature to overrule the declaration path) — that is
    // what this arm guards. The head is not valid UTF-8 (0xff is no lead
    // byte), so it now reads as the binary base rather than as text.
    expect(await sniffOf(frameHead)).toBe("application/octet-stream");
  });

  it("sniffs fLaC and OggS containers", async () => {
    const flacHead = [0x66, 0x4c, 0x61, 0x43, 0x20, 0x20, 0x20, 0x22];
    expect(await sniffOf(flacHead)).toBe("audio/flac");
    const oggHead = [0x4f, 0x67, 0x67, 0x53, 0x02, 0x20, 0x20, 0x20];
    expect(await sniffOf(oggHead)).toBe("audio/ogg");
    expect(await sniffOf(oggHead, "video/ogg")).toBe("video/ogg");
  });

  // The head window is read as TEXT only when it is valid UTF-8 (cinatra#3601).
  // Before, a window without a NUL was called text whatever its bytes were, so
  // a binary file was stored as text/plain and the write boundary's accepts
  // check refused it against the binary artifact type. These arms pin the new
  // reading and, just as importantly, pin that a genuinely textual buffer is
  // read exactly as it was before.

  it("reads a NUL-free binary head window declared application/octet-stream as application/octet-stream", async () => {
    const buf = continuationOnly(2048);
    expect(buf.includes(0)).toBe(false);
    expect(await sniffOfBytes(buf, "application/octet-stream")).toBe("application/octet-stream");
  });

  it("reads the same NUL-free binary bytes with NO declaration as the binary base", async () => {
    // The undeclared case: honouring a declared octet-stream inside the text
    // branch would leave this one reading text/plain; validating the window
    // carries it to the fallback's binary base.
    expect(await sniffOfBytes(continuationOnly(2048))).toBe("application/octet-stream");
  });

  it("reads a binary file whose first 16 bytes are printable ASCII as binary (the window is wider than 16 bytes)", async () => {
    // A 16-byte window would pass the UTF-8 check on this buffer and store it
    // as text: this arm is what pins the WIDER window.
    const buf = new Uint8Array(2048);
    buf.set(new TextEncoder().encode("BINARYish HEADER"), 0);
    buf.set(continuationOnly(2032), 16);
    expect(buf.subarray(0, 16).every((byte) => byte >= 0x20 && byte < 0x7f)).toBe(true);
    expect(buf.includes(0)).toBe(false);
    expect(await sniffOfBytes(buf, "application/octet-stream")).toBe("application/octet-stream");
  });

  it("still reads a real UTF-8 text buffer with multi-byte characters declared application/octet-stream as text/plain", async () => {
    const text = "naïve café — Grüße, 世界! ".repeat(64);
    const buf = new TextEncoder().encode(text);
    expect(buf.byteLength).toBeGreaterThan(512);
    expect(await sniffOfBytes(buf, "application/octet-stream")).toBe("text/plain");
  });

  it("still reads text as text when the head window ends INSIDE a multi-byte character", async () => {
    // 511 ASCII bytes then a 3-byte character: the window's last byte is that
    // character's LEAD byte, an incomplete trailing sequence a streaming fatal
    // decoder must hold back rather than refuse.
    const buf = new TextEncoder().encode(`${"a".repeat(511)}—more text after the window`);
    expect(buf[511]).toBe(0xe2);
    expect(await sniffOfBytes(buf)).toBe("text/plain");
  });

  it("still honours a declared text-like type for a window that is NOT valid UTF-8", async () => {
    // The declared-honouring reading is identical above and below the branch,
    // so a text-like declaration is untouched by the validation.
    expect(await sniffOfBytes(continuationOnly(2048), "text/csv")).toBe("text/csv");
  });

  it("keeps today's fallback for a window that holds a NUL", async () => {
    // A NUL in the window never entered the text branch and still does not.
    // The whole window is valid UTF-8 — a NUL is itself a valid UTF-8 byte and
    // every other byte here is printable ASCII — so this arm rests on the NUL
    // guard alone: drop `!b.includes(0)` from the branch and it reads
    // text/plain again.
    const buf = new TextEncoder().encode("plain ascii around one nul ".repeat(76));
    expect(buf.byteLength).toBeGreaterThan(512);
    buf[3] = 0;
    expect(await sniffOfBytes(buf, "application/octet-stream")).toBe("application/octet-stream");
  });
});
