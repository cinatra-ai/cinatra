import "server-only";

/**
 * Provider-aware dispatch resolver for /api/llm-bridge.
 *
 * Reads the optional `cinatra_llm` block from the bridge request body and
 * decides which provider + model the request should run against. Implements:
 *
 *   - preferredProvider is honored when its adapter is available; soft
 *     fallback only when no capabilityRequired gate is set; otherwise 503.
 *   - media_input routes only to gemini; native_mcp routes only to openai
 *     or anthropic; function_tools routes to any of the three because Gemini
 *     translates function tools via FunctionDeclaration (see
 *     packages/llm/src/providers/gemini.ts translateTools()).
 *   - preferredModel must be in ALLOWED_MODEL_IDS[effectiveProvider];
 *     otherwise the resolver returns 400 model_provider_mismatch.
 *   - when cinatra_llm is undefined, the caller takes the legacy path with
 *     no extra arguments.
 *   - capability-only routing: when capabilityRequired is set and
 *     preferredProvider is not, pick the first available compatible adapter;
 *     only return 503 when none exists.
 *
 * The helper is pure — all adapter resolution is injected by the route so
 * tests can mock `resolveProviderAdapter` without touching network or DB.
 */

import {
  ALLOWED_MODEL_IDS,
  LLM_PROVIDERS,
  canProviderSatisfyCapability,
  describeCapabilityRequirement,
  type LlmProvider,
  type LlmCapability,
  type OasCinatraLlm,
} from "@cinatra-ai/agents";

// Capability matrix moved to the declared single source of truth
// (packages/agents/src/llm-provider-policy.ts). `canProviderSatisfyCapability`
// + `describeCapabilityRequirement` are imported above so the bridge resolver,
// the actionable error wording, and any future preflight all share ONE matrix.

// ---------------------------------------------------------------------------
// Media-branch helpers (pure; importable from tests)
//
// All five exports below are deterministic helpers driving the media branch
// inside /api/llm-bridge route.ts. They live here (not route.ts) so vitest
// can drive them directly — Next.js restricts named imports from route files.
//
//   - YouTube detection uses host-based parsing via new URL(), with an
//     explicit allowlist of YouTube hostnames and no regex.
//   - MIME inference uses an explicit Gemini-supported MIME set with no
//     audio/* / video/* wildcards. It falls back to URL pathname extension
//     when the Content-Type header is missing/unparseable, and the final MIME
//     must appear in the allowlist or null is returned.
//   - The size cap uses a streaming reader that aborts mid-flight when
//     accumulated bytes exceed maxBytes, so oversize payloads never allocate
//     the full buffer. Content-Length is the fast-path short-circuit one
//     level up in route.ts.
// ---------------------------------------------------------------------------

const YOUTUBE_HOSTNAMES: ReadonlySet<string> = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

export function isYouTubeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return YOUTUBE_HOSTNAMES.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export const GEMINI_MEDIA_MIME_ALLOWLIST: ReadonlySet<string> = new Set([
  "audio/wav",
  "audio/mp3",
  "audio/mpeg",
  "audio/aiff",
  "audio/aac",
  "audio/ogg",
  "audio/flac",
  "video/mp4",
  "video/mpeg",
  "video/mov",
  "video/avi",
  "video/x-flv",
  "video/mpg",
  "video/webm",
  "video/wmv",
  "video/3gpp",
]);

// Pathname-extension → MIME map. Used only when the Content-Type header is
// missing or unparseable. Keys are lowercase pathname extensions including
// the leading dot. Values must appear in GEMINI_MEDIA_MIME_ALLOWLIST.
const EXTENSION_MIME_MAP: ReadonlyMap<string, string> = new Map<string, string>([
  [".mp3", "audio/mpeg"],
  [".wav", "audio/wav"],
  [".m4a", "audio/mp4"], // NOTE: audio/mp4 is NOT in the Gemini allowlist —
  // inferMimeTypeFromUrlOrHeader below filters anything not in the allowlist
  // to null. Keep the .m4a→audio/mp4 mapping entry because URL-path inference
  // recognizes that extension, but the allowlist gate rejects it (returns
  // null), which the route surfaces as HTTP 400 MEDIA-MIME-UNSUPPORTED.
  [".ogg", "audio/ogg"],
  [".flac", "audio/flac"],
  [".mp4", "video/mp4"],
  [".webm", "video/webm"],
  [".mov", "video/mov"],
  [".mpg", "video/mpeg"],
  [".mpeg", "video/mpeg"],
  [".3gp", "video/3gpp"],
  [".wmv", "video/wmv"],
  [".avi", "video/avi"],
  [".flv", "video/x-flv"],
]);

export function inferMimeTypeFromUrlOrHeader(
  url: string,
  contentTypeHeader: string | null,
): string | null {
  // Step 1 — try the header. Strip charset and lowercase.
  const headerMime =
    contentTypeHeader?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (headerMime && GEMINI_MEDIA_MIME_ALLOWLIST.has(headerMime)) {
    return headerMime;
  }

  // Step 2 — fall back to URL pathname extension.
  let pathname: string;
  try {
    pathname = new URL(url).pathname.toLowerCase();
  } catch {
    return null;
  }
  const dot = pathname.lastIndexOf(".");
  if (dot < 0) return null;
  const ext = pathname.slice(dot);
  const mapped = EXTENSION_MIME_MAP.get(ext);
  if (mapped && GEMINI_MEDIA_MIME_ALLOWLIST.has(mapped)) {
    return mapped;
  }
  return null;
}

export const MEDIA_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

export type StreamFetchResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: "exceeded"; bytesSeen: number };

export async function streamFetchWithSizeCap(
  response: Response,
  maxBytes: number,
): Promise<StreamFetchResult> {
  // Stream the response body chunk-by-chunk, aborting early if the
  // accumulated byte count crosses maxBytes. Never allocates the full buffer
  // for oversize payloads.
  if (!response.body) {
    // Defensive fallback — Response.body is non-null in modern Node runtimes
    // but the Web type union includes null. Buffer first, then check size.
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      return { ok: false, reason: "exceeded", bytesSeen: buf.byteLength };
    }
    return { ok: true, bytes: buf };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesSeen = 0;
  // The loop must read until done or until the size cap fires. Each chunk is
  // a Uint8Array; we accumulate byteLength and bail on the first overflow.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      bytesSeen += value.byteLength;
      if (bytesSeen > maxBytes) {
        await reader.cancel("size-exceeded").catch(() => {
          // Cancel failure is non-fatal — we still return the overrun result.
        });
        return { ok: false, reason: "exceeded", bytesSeen };
      }
      chunks.push(value);
    }
  }
  // Concatenate the chunks into a single Uint8Array.
  const merged = new Uint8Array(bytesSeen);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes: merged };
}

// ---------------------------------------------------------------------------
// Adapter availability probe — mockable seam for tests
// ---------------------------------------------------------------------------

export type AdapterAvailabilityProbe = (provider: LlmProvider) => Promise<boolean>;

// ---------------------------------------------------------------------------
// Dispatch result — the discriminated outcome the route consumes
// ---------------------------------------------------------------------------

export type CinatraLlmDispatchOutcome =
  | {
      kind: "passthrough";
      // Back-compat: cinatra_llm undefined → null. Soft fallback (caller's
      // preferred provider unavailable AND no capability gate) → the
      // originally-requested provider id, so the route can log a single
      // machine-parseable warn line.
      requestedProvider: LlmProvider | null;
    }
  | {
      kind: "dispatch";
      effectiveProvider: LlmProvider;
      preferredModel: string | undefined;
      requestedProvider: LlmProvider | null;
      // True when the requested provider could not be honored AND no
      // capability gate forced a 503. The route logs a single warn line.
      softFellBack: boolean;
    }
  | {
      kind: "error";
      status: 400 | 503;
      body: Record<string, unknown>;
    };

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export async function resolveCinatraLlmDispatch(
  cinatraLlm: OasCinatraLlm,
  isAdapterAvailable: AdapterAvailabilityProbe,
): Promise<CinatraLlmDispatchOutcome> {
  // Back-compat: when the block is absent, the caller takes the legacy path.
  // The null requestedProvider marks that no override was requested.
  if (!cinatraLlm) {
    return { kind: "passthrough", requestedProvider: null };
  }

  const requestedProvider: LlmProvider | null = cinatraLlm.preferredProvider ?? null;
  const capability = cinatraLlm.capabilityRequired;

  // Step 1 — try to honor the preferredProvider first.
  // Returns the chosen provider on success or null on failure.
  async function tryHonorPreferred(): Promise<LlmProvider | null> {
    if (!cinatraLlm || !cinatraLlm.preferredProvider) return null;
    const available = await isAdapterAvailable(cinatraLlm.preferredProvider);
    return available ? cinatraLlm.preferredProvider : null;
  }

  // Step 2 — capability-only routing. Iterates LLM_PROVIDERS in
  // declaration order; returns the first available compatible provider.
  async function tryCapabilityRouting(
    cap: LlmCapability,
  ): Promise<LlmProvider | null> {
    for (const candidate of LLM_PROVIDERS) {
      if (!canProviderSatisfyCapability(candidate, cap)) continue;
      const available = await isAdapterAvailable(candidate);
      if (available) return candidate;
    }
    return null;
  }

  const honored = await tryHonorPreferred();
  let effectiveProvider: LlmProvider | null = honored;

  // Branch A — preferred provider honored.
  if (effectiveProvider !== null) {
    // Capability gate against the honored provider. If the caller
    // demanded a capability the honored provider cannot satisfy, hard error.
    if (capability && !canProviderSatisfyCapability(effectiveProvider, capability)) {
      return {
        kind: "error",
        status: 503,
        body: {
          error: "capability_unsatisfiable",
          code: "CAPABILITY_UNSATISFIABLE",
          capability,
          effectiveProvider,
          requestedProvider,
          // Actionable, human-readable guidance (shared SoT wording). The
          // WayFlow runtime surfaces a failing ApiNode's response body in the
          // task-failure text (RuntimeError), so this reaches the run's
          // RUN_ERROR instead of a generic "WayFlow task failed". The honored
          // provider is available but cannot satisfy the capability.
          message: describeCapabilityRequirement(capability, {
            incompatibleProvider: effectiveProvider,
          }),
        },
      };
    }
    return finalizeDispatch(effectiveProvider, requestedProvider);
  }

  // Branch B — preferred provider unavailable OR not set.
  // When a capability gate is set, never silently fall back; either route to
  // another compatible provider or return 503.
  if (capability) {
    const routed = await tryCapabilityRouting(capability);
    if (routed === null) {
      return {
        kind: "error",
        status: 503,
        body: {
          error: "capability_unsatisfiable",
          code: "CAPABILITY_UNSATISFIABLE",
          capability,
          requestedProvider,
          // Actionable guidance (shared SoT wording) — no installed AND
          // configured connector provides this capability. Surfaced to the
          // run via the WayFlow task-failure text (see Branch A note).
          message: describeCapabilityRequirement(capability),
        },
      };
    }
    effectiveProvider = routed;
    return finalizeDispatch(effectiveProvider, requestedProvider);
  }

  // Branch C — no capability, no honored provider.
  // If preferredProvider was set → soft fallback (signaled via the
  // requestedProvider field on passthrough so the route can log the warn).
  // Otherwise → plain back-compat passthrough.
  if (cinatraLlm.preferredProvider) {
    return { kind: "passthrough", requestedProvider };
  }
  return { kind: "passthrough", requestedProvider: null };

  // ---------------------------------------------------------------------
  // Inner helper — runs Step 3 (model gate) and produces the dispatch outcome.
  // Hoisted out so both honored-path and capability-routed-path share the
  // model-gate logic without duplicating it.
  // ---------------------------------------------------------------------
  function finalizeDispatch(
    chosen: LlmProvider,
    requested: LlmProvider | null,
  ): CinatraLlmDispatchOutcome {
    const preferredModel = cinatraLlm?.preferredModel;
    if (preferredModel !== undefined) {
      const allowedForProvider = ALLOWED_MODEL_IDS[chosen];
      if (!allowedForProvider.includes(preferredModel)) {
        return {
          kind: "error",
          status: 400,
          body: {
            error: "model_provider_mismatch",
            code: "MODEL_PROVIDER_MISMATCH",
            preferredModel,
            effectiveProvider: chosen,
            allowedForProvider: [...allowedForProvider],
          },
        };
      }
    }
    return {
      kind: "dispatch",
      effectiveProvider: chosen,
      preferredModel,
      requestedProvider: requested,
      softFellBack: false,
    };
  }
}
