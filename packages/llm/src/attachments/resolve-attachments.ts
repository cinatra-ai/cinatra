import type { LlmAttachmentRef, LlmAttachmentManifest } from "../types";
import {
  resolveAttachmentCapability,
  type LlmProviderId,
  type AttachmentNativeKind,
} from "./capability-registry";

// Orchestration-layer attachment resolver. PURE control flow with INJECTED
// ports (no @/lib, no provider SDK, no fs): cache-first provider-file
// resolution. A non-ingestible attachment is NEVER silently dropped; it
// becomes a structured manifest entry the model receives.

export type ResolvedAttachmentPart = {
  ref: LlmAttachmentRef;
  nativeKind: AttachmentNativeKind;
  providerFileId: string;
  mime: string;
};

/** Injected I/O — implemented app-side (cache store + provider upload). */
export type AttachmentResolverPorts = {
  /**
   * Live cache entry for this ref+provider, or null (miss/expired).
   * Returns the cached AUTHORITATIVE metadata (`mime` + `sizeBytes`
   * stored at upload time from the resolved artifact, NOT from the
   * caller-supplied ref) so the resolver can re-validate against the
   * current capability cap+mime. A stale or poisoned row that disagrees is
   * treated as a miss → re-upload.
   */
  cacheGet: (
    ref: LlmAttachmentRef,
    provider: LlmProviderId,
  ) =>
    | Promise<{ providerFileId: string; mime: string; sizeBytes: number } | null>
    | { providerFileId: string; mime: string; sizeBytes: number }
    | null;
  /**
   * Upload the artifact bytes to the provider, return its file id.
   *
   * The resolver passes the AUTHORITATIVE capability (`maxBytes`,
   * `nativeKind`) so the port can:
   *   (a) cap the in-memory buffer to maxBytes BEFORE materializing (the
   *       caller-supplied `ref.size` is decorative — never trusted alone);
   *   (b) reject the upload (→ manifest) when the server-detected mime
   *       at the blob layer disagrees with the ref’s claimed mime.
   * Throwing any error here degrades that one ref to the not-readable
   * manifest; the turn still proceeds for the other refs.
   */
  providerUpload: (
    ref: LlmAttachmentRef,
    provider: LlmProviderId,
    capability: { maxBytes: number; nativeKind: AttachmentNativeKind },
  ) => Promise<{ providerFileId: string; mime: string; sizeBytes: number }>;
  /** Persist the provider file id (with the capability TTL). */
  cachePut: (
    ref: LlmAttachmentRef,
    provider: LlmProviderId,
    value: {
      providerFileId: string;
      mime: string;        // AUTHORITATIVE — from the upload return, never ref.mime
      sizeBytes: number;   // AUTHORITATIVE — from the upload return, never ref.size
      ttlMs: number;
    },
  ) => Promise<void> | void;
};

export type ResolvedAttachments = {
  readable: ResolvedAttachmentPart[];
  manifest: LlmAttachmentManifest | null;
};

/**
 * Resolve every attachment for a (provider, model) generation:
 *  - ingestible (capability registry) → cache-first provider file id
 *    (miss/expired ⇒ upload + cache) → a native part for the adapter;
 *  - non-ingestible (mime/size/unknown) → a structured manifest entry
 *    (the reason from the capability registry) — never dropped.
 * A provider-upload failure degrades that one attachment to the manifest
 * (the turn still proceeds) rather than failing the whole generation.
 */
export async function resolveAttachments(input: {
  attachments: LlmAttachmentRef[] | undefined;
  provider: LlmProviderId;
  model: string;
  ports: AttachmentResolverPorts;
}): Promise<ResolvedAttachments> {
  const refs = input.attachments ?? [];
  if (refs.length === 0) return { readable: [], manifest: null };

  const readable: ResolvedAttachmentPart[] = [];
  const notReadable: LlmAttachmentManifest["attachedButNotReadable"] = [];

  for (const ref of refs) {
    const cap = resolveAttachmentCapability({
      provider: input.provider,
      model: input.model,
      mime: ref.mime,
      size: ref.size,
    });
    if (!cap.ingestible) {
      notReadable.push({
        ref,
        title: ref.title,
        size: ref.size,
        reason: cap.reason,
      });
      continue;
    }
    // A cache READ outage must NOT block the upload (treat as a miss), and
    // a cachePut failure AFTER a successful upload must NOT make a readable
    // file unreadable (best-effort). ONLY a real providerUpload failure
    // degrades to the manifest.
    let providerFileId: string | null = null;
    let authoritativeMime: string | null = null;
    let cacheHitRaw: { providerFileId: string; mime: string; sizeBytes: number } | null = null;
    try {
      cacheHitRaw = await input.ports.cacheGet(ref, input.provider);
    } catch {
      cacheHitRaw = null; // cache read failure → miss, proceed to upload
    }
    if (cacheHitRaw) {
      // Validate the cache row's AUTHORITATIVE metadata against the current
      // capability cap + the ref. A row written with ref.mime / ref.size,
      // or a poisoned row, gets treated as a MISS → re-upload writes the
      // correct metadata.
      const sizeOk = cacheHitRaw.sizeBytes <= cap.maxBytes;
      const mimeOk = cacheHitRaw.mime === ref.mime;
      // Gemini cache rows must hold the provider file URI. Any Gemini
      // cached id without a URI scheme is treated as a miss.
      const geminiUriOk =
        input.provider !== "gemini" ||
        /^[a-z][a-z0-9+.-]*:\/\//i.test(cacheHitRaw.providerFileId);
      if (sizeOk && mimeOk && geminiUriOk) {
        providerFileId = cacheHitRaw.providerFileId;
        authoritativeMime = cacheHitRaw.mime;
      }
    }
    if (!providerFileId) {
      let uploaded: { providerFileId: string; mime: string; sizeBytes: number };
      try {
        uploaded = await input.ports.providerUpload(
          ref,
          input.provider,
          { maxBytes: cap.maxBytes, nativeKind: cap.nativeKind },
        );
      } catch (err) {
        notReadable.push({
          ref,
          title: ref.title,
          size: ref.size,
          reason: `provider upload failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
        continue;
      }
      providerFileId = uploaded.providerFileId;
      authoritativeMime = uploaded.mime;
      // best-effort: a cache write failure must not lose the readable part.
      // Cache the AUTHORITATIVE metadata returned by the upload (NOT
      // ref.mime / ref.size), so the next cache hit can be safely
      // re-validated.
      try {
        await input.ports.cachePut(ref, input.provider, {
          providerFileId: uploaded.providerFileId,
          mime: uploaded.mime,
          sizeBytes: uploaded.sizeBytes,
          ttlMs: cap.cacheTtlMs,
        });
      } catch {
        /* swallow — the file is uploaded + usable this turn regardless */
      }
    }
    readable.push({
      ref,
      nativeKind: cap.nativeKind,
      providerFileId,
      // Emit the AUTHORITATIVE mime (always set by either the cache hit or
      // the upload return) — NEVER ref.mime, which is caller-controlled.
      mime: authoritativeMime ?? ref.mime,
    });
  }

  return {
    readable,
    manifest:
      notReadable.length > 0
        ? { attachedButNotReadable: notReadable }
        : null,
  };
}

/**
 * Render the structured manifest as a model-facing block (NOT UI copy):
 * the model is told a file exists and why it cannot read it, which prevents
 * hallucinated assumptions about unreadable attachment contents.
 */
export function manifestToModelText(
  manifest: LlmAttachmentManifest,
): string {
  const lines = manifest.attachedButNotReadable.map((e) => {
    const name = e.title ?? e.ref.filename ?? e.ref.artifactId;
    return `- ${name} (${e.ref.mime}${
      e.size ? `, ${e.size} bytes` : ""
    }): NOT readable — ${e.reason}`;
  });
  return [
    "[ATTACHMENTS — system note, not user text]",
    "The user attached the following file(s) which you CANNOT read in this",
    "turn. Do not invent or assume their contents; if they are needed, say",
    "so and ask the user to provide a readable form.",
    ...lines,
  ].join("\n");
}
