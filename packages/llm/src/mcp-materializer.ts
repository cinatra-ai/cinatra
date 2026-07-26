/**
 * The ONE provider materializer for external MCP server tools (llm-providers
 * S2, cinatra#1713, epic #1711).
 *
 * A PURE module — no I/O, no `@/` imports, no `server-only` — that turns the
 * raw `LlmMcpServerTool`-shaped inputs a provider adapter is about to serialize
 * into a single validated, deterministic serialization shape. It is the single
 * place that owns:
 *
 *   1. URL validation — the server URL must be an absolute `http(s)` URL with a
 *      host; anything else is refused (never "best-effort" passed to a provider).
 *   2. A SINGLE authorization source — an authorization may arrive either as the
 *      `authorization` field OR as a case-insensitively-named `Authorization`
 *      HTTP header, but NEVER both (two sources ⇒ fail-closed refusal). The one
 *      source is canonicalized to an explicit scheme (a bare token becomes
 *      `Bearer <token>`; an existing `Bearer`/`Basic` scheme is normalized in
 *      case and preserved) and emitted in exactly one place.
 *   3. Deterministic name normalization with COLLISION DETECTION — every server
 *      label normalizes to a stable `[a-z0-9_]` name; if two inputs collide on a
 *      normalized name the batch is refused (the attribution map must be
 *      well-defined), and a `normalized → original label` attribution map is
 *      returned so a caller can report which server a normalized name came from.
 *
 * NOT WIRED INTO ANY ADAPTER YET. The adapter-facing serialization (OpenAI /
 * Anthropic) that consumes this materializer lands in the post-#1707 adapter
 * half of S2 (the adapter edits must target the post-plane shapes). This module
 * ships now, pure and independently tested, so that wiring is a call, not a
 * rewrite.
 */

export type McpTransport = "streamable-http" | "sse" | "unknown";

/** The raw per-server input the materializer consumes (a structural subset of
 *  `LlmMcpServerTool`, kept local so this module has no cross-package type
 *  dependency). */
export type McpMaterializerInput = {
  serverLabel: string;
  serverUrl: string;
  headers?: Record<string, string>;
  authorization?: string;
  serverDescription?: string;
  allowedTools?: string[] | null;
  approval?: McpToolboxApproval;
  transport?: McpTransport;
  /**
   * Where the entry came from (cinatra#2015 S0): "managed" = a first-party
   * connector toolbox / capability provider; "byo" = an `external_mcp_servers`
   * registry row a user registered. On a normalized-name collision the managed
   * entry wins over the BYO row; an omitted origin ranks as "byo" so an
   * untagged call site can never displace a managed connector's tool.
   */
  origin?: "managed" | "byo";
};

/**
 * Approval vocabulary (S2 AC2): `undefined` ⇒ `"auto_execute"`. The
 * capability-keyed translation (OpenAI serializes both; a provider declaring
 * `approval: "unsupported"` refuses `approval_required` fail-closed) lives
 * with the adapters — this pure module only carries the value through.
 */
export type McpToolboxApproval = "auto_execute" | "approval_required";

/** The validated, single-auth-source serialization shape a provider adapter
 *  serializes. `serverLabel` is the NORMALIZED name; `serverUrl` is canonical. */
export type MaterializedMcpServer = {
  serverLabel: string;
  serverUrl: string;
  headers?: Record<string, string>;
  authorization?: string;
  serverDescription?: string;
  allowedTools?: string[] | null;
  approval?: McpToolboxApproval;
  transport?: McpTransport;
};

/**
 * One per-entry suppression record (cinatra#2015 S0). A conflicting or invalid
 * entry suppresses ITSELF — never the batch — and the caller audit-warns each
 * record. `winnerLabel` is set only for `name_collision` and names the entry
 * that kept the normalized name.
 */
export type McpMaterializerSkip = {
  code: "invalid_url" | "empty_label" | "authorization_conflict" | "name_collision";
  label: string;
  message: string;
  winnerLabel?: string;
};

/**
 * Per-entry semantics (cinatra#2015 S0 — was whole-batch abort): the batch
 * ALWAYS materializes; individually invalid or colliding entries land in
 * `skipped` instead of aborting every other server. One bad row must never
 * drop every site's tools.
 */
export type McpMaterializerResult = {
  servers: MaterializedMcpServer[];
  attribution: Record<string, string>;
  skipped: McpMaterializerSkip[];
};

// ---------------------------------------------------------------------------
// Name normalization
// ---------------------------------------------------------------------------

/**
 * Deterministically normalize a server label to a stable `[a-z0-9_]` name:
 * lower-cased, every run of non-alphanumeric characters collapsed to a single
 * underscore, leading/trailing underscores trimmed. Returns `""` for a label
 * that carries no alphanumeric character (the caller treats that as an error).
 */
export function normalizeMcpServerName(label: string): string {
  // Collapse every non-alphanumeric run to a single "_" (linear global replace),
  // then strip leading/trailing underscores with an index scan rather than a
  // backtracking-prone `/^_+|_+$/` alternation (ReDoS-safe on uncontrolled input).
  const collapsed = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
  let start = 0;
  let end = collapsed.length;
  while (start < end && collapsed.charCodeAt(start) === 95 /* "_" */) start++;
  while (end > start && collapsed.charCodeAt(end - 1) === 95) end--;
  return collapsed.slice(start, end);
}

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

/**
 * Validate an MCP server URL. Requires an absolute `http:`/`https:` URL with a
 * non-empty host. Returns the canonical `href` on success. NOTE: this is a
 * SYNTACTIC/scheme check only — SSRF/private-address policy stays with the
 * server-only registry (`isPrivateUrl`); this pure module never resolves DNS.
 */
export function validateMcpServerUrl(
  raw: string,
): { ok: true; href: string } | { ok: false; message: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, message: `"${raw}" is not a valid absolute URL.` };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, message: `"${raw}" must use http:// or https://.` };
  }
  if (!url.host) {
    return { ok: false, message: `"${raw}" has no host.` };
  }
  return { ok: true, href: url.href };
}

// ---------------------------------------------------------------------------
// Single authorization source
// ---------------------------------------------------------------------------

const AUTH_HEADER_NAME = "authorization";

/** Canonicalize a raw authorization value to an explicit scheme. A bare token
 *  becomes `Bearer <token>`; an existing `Bearer`/`Basic` scheme is normalized
 *  in case and preserved (the "explicit Bearer rule"). */
function toExplicitAuthorization(raw: string): string {
  const value = raw.trim();
  // Split on the FIRST whitespace run without a `\s+(.*)$` overlap (which
  // backtracks polynomially on all-whitespace input — ReDoS-safe). `search`
  // finds the first whitespace index in linear time; the rest is a slice.
  const firstWs = value.search(/\s/);
  if (firstWs !== -1) {
    const scheme = value.slice(0, firstWs).toLowerCase();
    const rest = value.slice(firstWs).trim();
    if (rest) {
      if (scheme === "bearer") return `Bearer ${rest}`;
      if (scheme === "basic") return `Basic ${rest}`;
    }
  }
  return `Bearer ${value}`;
}

/**
 * Resolve the SINGLE authorization source for one server. Refuses (returns
 * `conflict`) when BOTH an `authorization` field and a case-insensitively-named
 * `Authorization` header are present. Splits the result into the canonical
 * `authorization` value (explicit scheme) and the residual non-auth `headers`.
 */
export function resolveSingleAuthorization(
  input: Pick<McpMaterializerInput, "headers" | "authorization">,
):
  | { ok: true; authorization?: string; headers?: Record<string, string> }
  | { ok: false; message: string } {
  const rawHeaders = input.headers ?? {};
  // Collect EVERY case-variant `Authorization`-named header (an object literal
  // can carry both `Authorization` and `authorization` as distinct keys). More
  // than one is itself ambiguous — two authorization sources — and is refused.
  const headerAuthValues: string[] = [];
  const residual: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawHeaders)) {
    if (key.toLowerCase() === AUTH_HEADER_NAME) {
      if (value.trim() !== "") headerAuthValues.push(value);
    } else {
      residual[key] = value;
    }
  }

  if (headerAuthValues.length > 1) {
    return {
      ok: false,
      message:
        "an MCP server declares more than one `Authorization` header (case variants) " +
        "— declare exactly one authorization source.",
    };
  }

  const fieldAuth = input.authorization?.trim() ? input.authorization : undefined;
  const headerAuthValue = headerAuthValues[0];
  const hasHeaderAuth = headerAuthValue !== undefined;

  if (fieldAuth && hasHeaderAuth) {
    return {
      ok: false,
      message:
        "an MCP server declares an authorization in both the `authorization` field " +
        "and an `Authorization` header — declare exactly one source.",
    };
  }

  const source = fieldAuth ?? (hasHeaderAuth ? headerAuthValue : undefined);
  const headers = Object.keys(residual).length > 0 ? residual : undefined;
  if (source === undefined) {
    return { ok: true, headers };
  }
  return { ok: true, authorization: toExplicitAuthorization(source), headers };
}

// ---------------------------------------------------------------------------
// Batch materializer
// ---------------------------------------------------------------------------

/**
 * Materialize a batch of external MCP server inputs into the validated
 * serialization shape.
 *
 * PER-ENTRY semantics (cinatra#2015 S0 — was whole-batch abort): an entry that
 * fails validation (URL, empty label, authorization conflict) suppresses
 * ITSELF into `skipped`; the rest of the batch materializes. A normalized-name
 * collision keeps exactly one entry per name — the first MANAGED entry if any,
 * else the first in input order (managed connector entries win over BYO rows;
 * an untagged origin ranks as BYO) — and suppresses the others into `skipped`
 * with the winner named. Returns the surviving servers in input order plus
 * the `normalized → original label` attribution map.
 */
export function materializeExternalMcpServers(
  inputs: readonly McpMaterializerInput[],
): McpMaterializerResult {
  const skipped: McpMaterializerSkip[] = [];

  // Pass 1 — per-entry validation; individually invalid entries drop out here.
  type Candidate = {
    input: McpMaterializerInput;
    normalized: string;
    server: MaterializedMcpServer;
  };
  const candidates: Candidate[] = [];
  for (const input of inputs) {
    const normalized = normalizeMcpServerName(input.serverLabel);
    if (normalized === "") {
      skipped.push({
        code: "empty_label",
        label: input.serverLabel,
        message: `server label "${input.serverLabel}" normalizes to an empty name.`,
      });
      continue;
    }

    const url = validateMcpServerUrl(input.serverUrl);
    if (!url.ok) {
      skipped.push({ code: "invalid_url", label: input.serverLabel, message: url.message });
      continue;
    }

    const auth = resolveSingleAuthorization(input);
    if (!auth.ok) {
      skipped.push({
        code: "authorization_conflict",
        label: input.serverLabel,
        message: auth.message,
      });
      continue;
    }

    const server: MaterializedMcpServer = {
      serverLabel: normalized,
      serverUrl: url.href,
    };
    if (auth.headers) server.headers = auth.headers;
    if (auth.authorization !== undefined) server.authorization = auth.authorization;
    if (input.serverDescription !== undefined) server.serverDescription = input.serverDescription;
    if (input.allowedTools !== undefined) server.allowedTools = input.allowedTools;
    if (input.approval !== undefined) server.approval = input.approval;
    if (input.transport !== undefined) server.transport = input.transport;
    candidates.push({ input, normalized, server });
  }

  // Pass 2 — collision resolution per normalized name: first managed wins,
  // else first in input order. Losers suppress themselves with the winner named.
  const winnerByNormalized = new Map<string, Candidate>();
  for (const candidate of candidates) {
    const incumbent = winnerByNormalized.get(candidate.normalized);
    if (!incumbent) {
      winnerByNormalized.set(candidate.normalized, candidate);
      continue;
    }
    const incumbentManaged = incumbent.input.origin === "managed";
    const candidateManaged = candidate.input.origin === "managed";
    if (!incumbentManaged && candidateManaged) {
      // The managed entry displaces the earlier BYO/untagged one.
      winnerByNormalized.set(candidate.normalized, candidate);
      skipped.push(collisionSkip(incumbent, candidate));
    } else {
      skipped.push(collisionSkip(candidate, incumbent));
    }
  }

  const servers: MaterializedMcpServer[] = [];
  const attribution: Record<string, string> = {};
  for (const candidate of candidates) {
    if (winnerByNormalized.get(candidate.normalized) !== candidate) continue;
    servers.push(candidate.server);
    attribution[candidate.normalized] = candidate.input.serverLabel;
  }

  return { servers, attribution, skipped };
}

function collisionSkip(
  loser: { input: McpMaterializerInput; normalized: string },
  winner: { input: McpMaterializerInput },
): McpMaterializerSkip {
  return {
    code: "name_collision",
    label: loser.input.serverLabel,
    winnerLabel: winner.input.serverLabel,
    message:
      `MCP server label "${loser.input.serverLabel}" normalizes to "${loser.normalized}", ` +
      `already taken by "${winner.input.serverLabel}"` +
      `${winner.input.origin === "managed" ? " (managed connector entry wins)" : ""} — suppressed.`,
  };
}
