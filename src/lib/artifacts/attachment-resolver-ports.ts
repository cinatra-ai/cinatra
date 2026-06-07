import type {
  AttachmentResolverPorts,
  LlmAttachmentRef,
} from "@cinatra-ai/llm";
import { uploadFile } from "@cinatra-ai/llm";
import {
  getCachedProviderFile,
  putCachedProviderFile,
} from "@/lib/artifacts/provider-file-cache";
import { resolveArtifactVersionForServe } from "@/lib/artifacts/artifact-read";
import { createLocalDiskBlobStore } from "@/lib/artifacts/local-disk-blob-store";

// Shared app-side attachment resolver ports factory. The orchestration layer
// never imports @/lib; this module supplies the cache + provider-upload +
// cachePut implementations injected as AttachmentResolverPorts.
//
// CRITICAL TENANT-ISOLATION RULE: callers MUST pass an orgId that is
// AUTH-DERIVED for the request (chat: session.activeOrganizationId; bridge:
// run.orgId from the auth-injected x-cinatra-a2a-context-id only — NEVER
// a caller-supplied agent_run_id, NEVER the bridge-token actor’s org).
// Cache reads, blob reads, and cache writes are all scoped to that orgId
// so a hijacked credential cannot pivot to another tenant’s artifacts.

const blobStore = createLocalDiskBlobStore();

export function buildAttachmentResolverPorts(input: {
  orgId: string;
}): AttachmentResolverPorts {
  const { orgId } = input;
  return {
    cacheGet: (ref: LlmAttachmentRef, provider) => {
      const hit = getCachedProviderFile({
        orgId,
        artifactId: ref.artifactId,
        representationRevisionId: ref.representationRevisionId,
        digest: ref.digest,
        provider,
      });
      // Surface the stored AUTHORITATIVE mime + sizeBytes so the resolver
      // can re-validate cache hits against the current capability cap and
      // the ref's claimed mime.
      return hit
        ? {
            providerFileId: hit.providerFileId,
            mime: hit.mime,
            sizeBytes: hit.sizeBytes,
          }
        : null;
    },

    providerUpload: async (ref: LlmAttachmentRef, provider, capability) => {
      // 1) Resolve the artifact version (AUTHORITATIVE blob_id, mime, size).
      // resolveArtifactVersionForServe enforces org_id scope; a wrong orgId
      // returns null.
      //
      // The bridge path passes `liveOnly: true` so a tombstoned-but-pinned
      // representation is NOT resolvable through the LLM bridge. The deleted-
      // allowed pin override is route-only (gated by the route's
      // actor-visibility check); the bridge does not currently enforce
      // per-actor visibility, so widening its read surface would let an LLM
      // read tombstoned bytes outside the tombstone-respecting flow.
      const resolved = resolveArtifactVersionForServe({
        orgId,
        artifactId: ref.artifactId,
        representationRevisionId: ref.representationRevisionId,
        liveOnly: true,
      });
      if (!resolved) {
        throw new Error(
          `artifact version not resolvable for upload: ${ref.artifactId}/${ref.representationRevisionId} (orgId scope)`,
        );
      }
      // 2) Enforce the AUTHORITATIVE maxBytes BEFORE opening the blob
      // (caller-supplied ref.size is decorative and not trusted on its own).
      // The capability.maxBytes is per-provider (32 MB / 100 MB).
      if (resolved.sizeBytes > capability.maxBytes) {
        throw new Error(
          `artifact ${resolved.sizeBytes} bytes exceeds the ${capability.maxBytes}-byte limit for ${provider}`,
        );
      }
      // 3) The AUTHORITATIVE (server-sniffed) mime at the blob layer must
      // agree with the ref's claimed mime; otherwise the upload is rejected
      // so a tampered ref cannot inject content under a forged mime
      // classification.
      if (resolved.mime !== ref.mime) {
        throw new Error(
          `artifact mime mismatch: ref says ${ref.mime} but blob says ${resolved.mime}`,
        );
      }
      // 4) Read the blob bytes with a STREAMING byte counter so a runaway
      // stream (theoretically impossible given step 2) still cannot
      // materialize an oversize buffer in memory.
      //
      // Open by the resource-bound storage_key (returned by the semantic
      // serve resolver), not by a scope-derived path. Two artifacts sharing
      // one resource (substance dedupe) both read from the same canonical
      // bytes via this path; the local-disk store enforces an
      // `orgs/<orgId>/` prefix on the storage_key.
      const handle = await blobStore.openByStorageKey({
        orgId,
        storageKey: resolved.storageKey,
      });
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of handle.stream) {
        total += chunk.byteLength;
        if (total > capability.maxBytes) {
          throw new Error(
            `artifact stream exceeded the ${capability.maxBytes}-byte cap mid-read`,
          );
        }
        chunks.push(Buffer.from(chunk));
      }
      const content = Buffer.concat(chunks);
      // 5) Upload with the AUTHORITATIVE mime (NOT ref.mime — already
      // proven equal above, but using `resolved.mime` makes the data flow
      // explicit and survives future relaxations).
      const fileRef = await uploadFile({
        provider,
        content,
        filename: ref.filename ?? ref.title ?? ref.artifactId,
        mimeType: resolved.mime,
      });
      // Return the AUTHORITATIVE metadata so the resolver can store it in
      // cache and validate future hits — never round-trip ref.mime / ref.size
      // through the cache.
      return {
        providerFileId: fileRef.id,
        mime: resolved.mime,
        sizeBytes: resolved.sizeBytes,
      };
    },

    cachePut: (ref, provider, value) => {
      // Write the AUTHORITATIVE mime + sizeBytes the resolver gives us (from
      // the upload return), NOT ref.mime/ref.size which are caller-controlled
      // and could poison the cache.
      putCachedProviderFile(
        {
          orgId,
          artifactId: ref.artifactId,
          representationRevisionId: ref.representationRevisionId,
          digest: ref.digest,
          provider,
        },
        {
          providerFileId: value.providerFileId,
          mime: value.mime,
          sizeBytes: value.sizeBytes,
          ttlMs: value.ttlMs,
        },
      );
    },
  };
}
