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
});
