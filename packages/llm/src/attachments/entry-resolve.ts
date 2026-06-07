import type { AdapterAttachmentPart, LlmAttachmentRef } from "../types";
import type { LlmProviderId } from "./capability-registry";
import {
  resolveAttachments,
  manifestToModelText,
  type AttachmentResolverPorts,
} from "./resolve-attachments";

// Shared orchestration-entry attachment resolution step, called by all four
// index.ts entry points right before the adapter call. PURE control flow with
// INJECTED ports (no @/lib, no provider SDK, no fs). CRITICAL byte-identical
// guarantee: when there are no attachments OR no injected ports for legacy
// callers this is a no-op -- the system prompt is returned UNCHANGED and
// resolvedAttachments is omitted, so the adapter request body stays identical
// to legacy.

/**
 * Per-message resolution for stream paths. Each user message with
 * `attachments` is resolved INDEPENDENTLY; the result is a sanitized message
 * array (only `{role, content, resolvedAttachments?}` -- any caller-smuggled
 * `resolvedAttachments` is dropped) and an aggregated not-readable manifest
 * covering every ref the entry could not resolve. Assistant messages pass
 * through with only `{role, content}`. With no ports, every user-attached ref
 * is degraded to the manifest (Decision A) -- chat replay never silently drops
 * files.
 */
export type SanitizedStreamMessage = {
  role: "user" | "assistant";
  content: string;
  resolvedAttachments?: AdapterAttachmentPart[];
};

export async function resolveStreamMessageAttachments(params: {
  messages: ReadonlyArray<{
    role: "user" | "assistant";
    content: string;
    attachments?: LlmAttachmentRef[];
  }>;
  ports: AttachmentResolverPorts | undefined;
  provider: LlmProviderId;
  model: string;
  system: string;
}): Promise<{ messages: SanitizedStreamMessage[]; system: string }> {
  // Fast path -- no attachments anywhere => byte-identical (sanitized
  // messages still strip any caller-smuggled resolvedAttachments).
  const anyAttachments = params.messages.some(
    (m) => (m.attachments?.length ?? 0) > 0,
  );
  if (!anyAttachments) {
    return {
      messages: params.messages.map((m) => ({ role: m.role, content: m.content })),
      system: params.system,
    };
  }
  // Per-ref accumulation: only the NOT-READABLE refs go into the aggregated
  // manifest, NEVER refs that were natively emitted for the same turn
  // (`[ok.pdf, no.zip]` must emit ok.pdf AND tell the model only no.zip is
  // not readable, not both).
  const notReadable: Array<{
    ref: LlmAttachmentRef;
    reason: string;
  }> = [];
  const sanitized: SanitizedStreamMessage[] = [];
  for (const m of params.messages) {
    if (m.role !== "user" || !m.attachments || m.attachments.length === 0) {
      sanitized.push({ role: m.role, content: m.content });
      continue;
    }
    if (!params.ports) {
      // No resolver ports -> every ref degrades to Decision-A manifest
      // (no native parts can be produced this turn).
      sanitized.push({ role: "user", content: m.content });
      for (const ref of m.attachments) {
        notReadable.push({
          ref,
          reason: "artifact resolver unavailable for this run",
        });
      }
      continue;
    }
    // Ports present -- resolve precisely; readable refs become native
    // parts, the manifest's not-readable entries surface their own
    // per-ref reasons (from the capability registry / upload failures).
    const r = await resolveAttachments({
      attachments: m.attachments,
      provider: params.provider,
      model: params.model,
      ports: params.ports,
    });
    sanitized.push({
      role: "user",
      content: m.content,
      ...(r.readable.length > 0
        ? {
            resolvedAttachments: r.readable.map((p) => ({
              nativeKind: p.nativeKind,
              providerFileId: p.providerFileId,
              mime: p.mime,
            })),
          }
        : {}),
    });
    if (r.manifest) {
      for (const e of r.manifest.attachedButNotReadable) {
        notReadable.push({ ref: e.ref, reason: e.reason });
      }
    }
  }
  const system =
    notReadable.length > 0
      ? `${manifestToModelText({
          attachedButNotReadable: notReadable.map((e) => ({
            ref: e.ref,
            title: e.ref.title,
            size: e.ref.size,
            reason: e.reason,
          })),
        })}\n\n${params.system}`
      : params.system;
  return { messages: sanitized, system };
}

export async function resolveEntryAttachments(params: {
  attachments: LlmAttachmentRef[] | undefined;
  ports: AttachmentResolverPorts | undefined;
  provider: LlmProviderId;
  model: string;
  system: string;
}): Promise<{ resolvedAttachments?: AdapterAttachmentPart[]; system: string }> {
  // (1) No attachments -- byte-identical no-op for legacy callers.
  if (!params.attachments?.length) {
    return { system: params.system };
  }
  // (2) Attachments BUT no resolver ports -- Decision A requires the model to
  // be TOLD the file exists and is not readable. Never silently drop the
  // attachment signal. Build a "resolver unavailable for this run" manifest
  // for every ref and prepend to system; the turn still proceeds.
  if (!params.ports) {
    const manifest = {
      attachedButNotReadable: params.attachments.map((ref) => ({
        ref,
        title: ref.title,
        size: ref.size,
        reason: "artifact resolver unavailable for this run",
      })),
    };
    return {
      system: `${manifestToModelText(manifest)}\n\n${params.system}`,
    };
  }
  const { readable, manifest } = await resolveAttachments({
    attachments: params.attachments,
    provider: params.provider,
    model: params.model,
    ports: params.ports,
  });
  // Drop the resolver's `ref` -- the adapter only needs the native triple.
  const resolvedAttachments =
    readable.length > 0
      ? readable.map((r) => ({
          nativeKind: r.nativeKind,
          providerFileId: r.providerFileId,
          mime: r.mime,
        }))
      : undefined;
  // Decision A: a non-ingestible attachment is NEVER silently dropped -- its
  // structured manifest is PREPENDED to the system prompt so the model knows a
  // file exists and why it cannot read it.
  const system = manifest
    ? `${manifestToModelText(manifest)}\n\n${params.system}`
    : params.system;
  return { resolvedAttachments, system };
}
