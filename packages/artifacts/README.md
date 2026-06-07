# @cinatra-ai/artifacts

Pure type and contract definitions for tenant- and version-scoped binary artifact storage. This package carries no runtime storage implementation — only the `BlobStore` interface, scope/record shapes, and the immutable artifact-version model that concrete bindings (local disk, object store) and serving layers implement.

Blob identity is always tenant + artifact-version scoped, storage keys are server-generated (a client filename is never used as a path), and bytes live only in the blob store.

## Public API

- `BlobStore` — blob persistence/read interface (put, open, range, stat, delete).
- `BlobScope` — org + artifact + representation-revision addressing.
- `BlobPutInput` — streamed write input with a hard byte ceiling.
- `BlobRecord` — stored blob metadata (id, key, sha256, size, MIME).
- `BlobReadHandle` — read stream plus size and detected MIME.
- `BlobTooLargeError` — thrown when a write exceeds `maxBytes`.
- `ArtifactCreationDisabledError` — retired error, type-only compatibility export.
- `ArtifactRef` — normalized immutable reference a run or message pins.
- `ArtifactVersion` — one immutable artifact version (full-fidelity file model).
- `ArtifactObjectData` — metadata mirror shape (refs only, never bytes).
- `ArtifactOriginKind` — origin union (upload, email_attachment, agent_generated, etc.).
- `SEMANTIC_ARTIFACT_OBJECT_TYPE` — shared object type for semantic artifact rows.

## Usage

```ts
import type { BlobStore, BlobPutInput } from "@cinatra-ai/artifacts";

async function store(blobStore: BlobStore, input: BlobPutInput) {
  const record = await blobStore.put(input);
  return record.blobId;
}
```

## Docs

See https://docs.cinatra.ai
