import { z } from "zod";

import { parseClaimDispositions } from "./claims";

// ---------------------------------------------------------------------------
// connectorRef external-pointer lifecycle — the PURE policy leaf
// (cinatra#1451, epic #1424 / #1448).
//
// The `external` claim disposition (epic #1448 principle 4) is a
// connector-owned POINTER to third-party-canonical content (a Google Doc, a
// WordPress post, a Drupal node). Its delivery form is `representation.form =
// "connectorRef"` — NOT a blob artifact. This leaf holds the side-effect-free
// mechanism the connector-sync write path, the external-pack sub-issues
// (gdrive/wordpress/drupal — #1463/#1464/#1465), and the snapshot/export
// action all share:
//
//   - the reference-state vocabulary + machine (`linked → stale → dangling`),
//     moved ONLY by connector sync/verification; an upstream delete flags
//     `dangling` and NEVER silently tombstones the object row;
//   - the pointer-row `objects.data` builder — BARE identity only (url +
//     connector/external ids + light metadata); heavy fields are read on
//     demand through the connector facade, never persisted into the row;
//   - the connector-facade contract (probe + on-demand content resolution);
//   - the pointer pin/context policy — external pointers are `pinnable:false`
//     and are NEVER context-selectable (you pin the SNAPSHOT record instead);
//   - the snapshot/export builder — captures resolved content into a NEW,
//     INDEPENDENT record-class artifact whose provenance is CORRELATION fields
//     only (atomicity, epic #1448 principle 2: no artifact-ID references in
//     content, no FK to the pointer), so it stays servable after the pointer
//     is deleted;
//   - the "open in source application" deeplink resolver (http/https only).
//
// Zero React / DB / server-only imports — safe anywhere (mirrors ./claims).
// DELIBERATELY off the package barrel (`./index.ts`): consumers import the
// `@cinatra-ai/objects/connector-ref` subpath, the same route-graph-ratchet
// discipline `@cinatra-ai/objects/claims` follows.
// ---------------------------------------------------------------------------

/** The representation form an external-pointer artifact takes (mirrors the
 * `accepts.connectorRef` manifest form + the built-in `"connector-ref"`
 * artifact-type descriptor name). */
export const CONNECTOR_REF_REPRESENTATION_FORM = "connectorRef" as const;

/** The `ArtifactObjectData.artifactType` discriminator a pointer row carries.
 * (`file` / `dashboard` / `connector-ref` are the built-in form names.) */
export const CONNECTOR_REF_ARTIFACT_TYPE = "connector-ref" as const;

// ---------------------------------------------------------------------------
// Reference states — the pointer's health relative to its upstream target.
// ---------------------------------------------------------------------------

/**
 * - `linked`  — the upstream target resolves and is in sync (the healthy state
 *   a freshly written / freshly re-synced pointer is in).
 * - `stale`   — the upstream target still resolves but has CHANGED since the
 *   last sync (content drifted upstream; a re-sync or a fresh snapshot is
 *   warranted). Still a live, openable pointer.
 * - `dangling`— the upstream target no longer resolves (deleted / 404 / gone).
 *   The pointer row PERSISTS (never auto-tombstoned) so history, correlations,
 *   and any captured snapshots survive; a later successful sync can re-link it.
 */
export const CONNECTOR_REF_STATES = ["linked", "stale", "dangling"] as const;
export type ConnectorRefState = (typeof CONNECTOR_REF_STATES)[number];

/**
 * What a connector's sync/verification probe reports about the upstream
 * target. This is the ONLY input that moves the reference state — the state
 * never changes from a read, a pin, a UI action, or a GC pass.
 *
 * - `present`  — target resolves, unchanged since last sync   → `linked`
 * - `modified` — target resolves but changed upstream          → `stale`
 * - `absent`   — target does not resolve (deleted / gone)      → `dangling`
 */
export const CONNECTOR_REF_PROBE_OUTCOMES = ["present", "modified", "absent"] as const;
export type ConnectorRefProbeOutcome = (typeof CONNECTOR_REF_PROBE_OUTCOMES)[number];

/**
 * The reference state a verification/sync outcome maps to. A PURE function of
 * the outcome (the outcomes are mutually exclusive per probe), so the state is
 * total and path-independent: a `dangling` pointer whose upstream is
 * re-created reports `present` and returns to `linked`; a `linked` pointer
 * whose upstream is deleted reports `absent` and moves to `dangling`.
 */
export function connectorRefStateForOutcome(outcome: ConnectorRefProbeOutcome): ConnectorRefState {
  switch (outcome) {
    case "present":
      return "linked";
    case "modified":
      return "stale";
    case "absent":
      return "dangling";
  }
}

// ---------------------------------------------------------------------------
// The persisted pointer shape (`objects.data.connectorRef`).
//
// BARE identity + light display metadata ONLY. Heavy fields (the document
// body, the rendered HTML, large media) are NEVER stored here — they are read
// on demand through the connector facade (`ConnectorRefFacade.resolveContent`).
// This is the CRM pointer-row precedent (`ObjectSyncAdapter` doc: cinatra holds
// only a pointer row per record; the canonical store is the third party).
//
// `url` stays the FIRST key (backward-compatible with the pre-existing
// `ArtifactObjectData.connectorRef = { url }` contract + `connectorRefDeeplink`
// / the artifact-service `sourceUrl` projection, which read `connectorRef.url`
// and ignore the additive lifecycle fields).
// ---------------------------------------------------------------------------

export const connectorRefPointerSchema = z
  .strictObject({
    /** Absolute http(s) URL that opens the target in its source application. */
    url: z.string().min(1),
    /** The connector that OWNS this pointer (e.g. `wordpress-mcp-connector`).
     * Soft correlation provenance — never an FK, never load-bearing for
     * read/pin/delete/GC. */
    connectorId: z.string().min(1),
    /** The provider-native id of the upstream target (post id, node id, file
     * id). Connector-scoped; used by the facade to resolve/probe. */
    externalId: z.string().min(1),
    /** Optional connector resolver id (a `connector-ref` type may name the
     * resolver the connector uses; resolved BY the connector, never a fn). */
    resolver: z.string().min(1).optional(),
    /** The mime the connector resolves the target to (e.g.
     * `application/vnd.google-apps.document`). Display/routing hint only. */
    resolvedMimeType: z.string().min(1).optional(),
    /** Current reference state (see CONNECTOR_REF_STATES). Moved ONLY by
     * {@link applyConnectorRefVerification}. */
    state: z.enum(CONNECTOR_REF_STATES),
    /** ISO timestamp of the last successful verification/sync probe. */
    lastVerifiedAt: z.string().min(1).optional(),
    /** Opaque upstream version/etag from the last probe — lets the next probe
     * classify `present` vs `modified` without re-fetching the body. */
    remoteVersion: z.string().min(1).optional(),
    /** Light display title (safe to project; NOT the body). */
    title: z.string().optional(),
    /** Light display excerpt (safe to project; NOT the body). */
    excerpt: z.string().optional(),
  })
  .strict();

export type ConnectorRefPointer = z.infer<typeof connectorRefPointerSchema>;

/**
 * Validate a persisted pointer value (fail-closed, never throws). The catalog
 * / sync read paths use this before trusting a row: an invalid pointer shape
 * returns an error list rather than a partially-typed object.
 */
export function parseConnectorRefPointer(
  value: unknown,
): { ok: true; pointer: ConnectorRefPointer } | { ok: false; errors: string[] } {
  const parsed = connectorRefPointerSchema.safeParse(value);
  if (parsed.success) return { ok: true, pointer: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
  };
}

// ---------------------------------------------------------------------------
// URL safety — the ONE http(s) validator the pointer builder + the deeplink
// resolver share. `objects.data` is org-supplied JSONB that ends up in an
// `<a href>`, so only absolute http:/https: URLs pass; the canonical parsed
// `URL.href` is returned, never the raw string (`javascript:`, `data:`,
// relative, and malformed shapes all return null).
// ---------------------------------------------------------------------------

function safeHttpUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.href;
}

/**
 * The validated "Open in source application" deeplink for a pointer, read from
 * a raw `objects.data` value's `connectorRef.url`. Null for any non-pointer
 * row (blob/dashboard artifacts) and any unsafe/malformed URL.
 *
 * This is the PURE canonical resolver for open-in-provider hrefs; it accepts
 * the whole `objects.data` object (not just the pointer) so a renderer / read
 * projection can call it directly on a row. Structurally identical to the
 * server-only `connectorRefSourceUrl` accessor in the artifact service, which
 * predates this leaf; converging that call site onto this resolver is a
 * downstream cleanup (this leaf is import-safe from anywhere, that file is
 * `server-only`).
 */
export function connectorRefDeeplink(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const ref = (data as { connectorRef?: unknown }).connectorRef;
  if (typeof ref !== "object" || ref === null) return null;
  return safeHttpUrl((ref as { url?: unknown }).url);
}

// ---------------------------------------------------------------------------
// Pointer-row write path (the `objects.data` builder).
// ---------------------------------------------------------------------------

export type NewConnectorRefPointerInput = {
  url: string;
  connectorId: string;
  externalId: string;
  resolver?: string;
  resolvedMimeType?: string;
  title?: string;
  excerpt?: string;
  /** ISO timestamp of the sync that materialized this pointer (defaults absent). */
  verifiedAt?: string;
  remoteVersion?: string;
};

/** The `objects.data` payload for an external-pointer artifact row. A superset
 * of the pre-existing `ArtifactObjectData` connectorRef contract: `mime` /
 * `originKind` / `title` mirror the generic artifact projection, and
 * `connectorRef` carries the full lifecycle pointer. Heavy fields are absent by
 * construction. */
export type ConnectorRefArtifactData = {
  artifactType: typeof CONNECTOR_REF_ARTIFACT_TYPE;
  originKind: "external_link";
  mime: string;
  title?: string;
  excerpt?: string;
  connectorRef: ConnectorRefPointer;
};

/**
 * Build a fresh external-pointer's `objects.data`. The pointer starts `linked`
 * (a sync just materialized it). Fail-closed on both axes so the write path can
 * NEVER persist a pointer the read path (`parseConnectorRefPointer`) would
 * reject:
 *   - {@link ConnectorRefUrlError} if the url is not an absolute http(s) URL
 *     (an unopenable / unsafe href);
 *   - {@link ConnectorRefPointerError} if any completed pointer field is
 *     structurally invalid (e.g. an empty `connectorId`/`externalId`).
 * Returns the SCHEMA-CANONICAL pointer (parsed), never the raw draft.
 */
export function buildConnectorRefArtifactData(
  input: NewConnectorRefPointerInput,
): ConnectorRefArtifactData {
  const url = safeHttpUrl(input.url);
  if (url == null) {
    throw new ConnectorRefUrlError(input.url);
  }
  const draft: ConnectorRefPointer = {
    url,
    connectorId: input.connectorId,
    externalId: input.externalId,
    ...(input.resolver !== undefined ? { resolver: input.resolver } : {}),
    ...(input.resolvedMimeType !== undefined ? { resolvedMimeType: input.resolvedMimeType } : {}),
    state: "linked",
    ...(input.verifiedAt !== undefined ? { lastVerifiedAt: input.verifiedAt } : {}),
    ...(input.remoteVersion !== undefined ? { remoteVersion: input.remoteVersion } : {}),
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.excerpt !== undefined ? { excerpt: input.excerpt } : {}),
  };
  const checked = connectorRefPointerSchema.safeParse(draft);
  if (!checked.success) {
    throw new ConnectorRefPointerError(
      checked.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  const pointer = checked.data;
  return {
    artifactType: CONNECTOR_REF_ARTIFACT_TYPE,
    originKind: "external_link",
    mime: input.resolvedMimeType ?? "text/uri-list",
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.excerpt !== undefined ? { excerpt: input.excerpt } : {}),
    connectorRef: pointer,
  };
}

export class ConnectorRefUrlError extends Error {
  constructor(public readonly rawUrl: unknown) {
    super(
      `[connector-ref] pointer url must be an absolute http(s) URL, got ${JSON.stringify(rawUrl)}`,
    );
    this.name = "ConnectorRefUrlError";
  }
}

export class ConnectorRefPointerError extends Error {
  constructor(public readonly errors: string[]) {
    super(`[connector-ref] invalid pointer: ${errors.join("; ")}`);
    this.name = "ConnectorRefPointerError";
  }
}

// ---------------------------------------------------------------------------
// Verification / sync — the ONLY state mover.
// ---------------------------------------------------------------------------

/** What a connector probe returns from checking one pointer's upstream target. */
export type ConnectorRefProbeResult = {
  outcome: ConnectorRefProbeOutcome;
  /** ISO timestamp the probe ran. */
  checkedAt: string;
  /** Opaque upstream version/etag observed (drives `present` vs `modified`
   * next time). Omitted for `absent`. */
  remoteVersion?: string;
};

export type ConnectorRefVerificationResult = {
  /** The next persisted pointer (a NEW object; the input is not mutated). */
  pointer: ConnectorRefPointer;
  /** The prior state, for audit / logging. */
  previousState: ConnectorRefState;
  /** The resulting state. */
  nextState: ConnectorRefState;
  /** True iff the reference state actually changed (lets the caller skip a
   * write when only the verification timestamp advanced). */
  stateChanged: boolean;
  /** True iff an upstream delete was just observed (a `linked`/`stale` pointer
   * moving to `dangling`) — the caller flags dangling, NEVER tombstones. */
  becameDangling: boolean;
};

/**
 * Apply a connector verification/sync probe to a pointer. This is the single
 * function that moves the reference state — a read/pin/GC path must never
 * mutate it. Returns a NEW pointer (immutable update) carrying the mapped
 * `state`, the advanced `lastVerifiedAt`, and the observed `remoteVersion`.
 *
 * `becameDangling` reports an upstream delete WITHOUT deleting anything: the
 * object row survives so history/correlations/snapshots persist and a later
 * `present` probe can re-link it (epic #1448: external deletion flags
 * `dangling`, never silently tombstones).
 */
export function applyConnectorRefVerification(
  current: ConnectorRefPointer,
  probe: ConnectorRefProbeResult,
): ConnectorRefVerificationResult {
  const previousState = current.state;
  const nextState = connectorRefStateForOutcome(probe.outcome);
  const pointer: ConnectorRefPointer = {
    ...current,
    state: nextState,
    lastVerifiedAt: probe.checkedAt,
  };
  // Only carry a remoteVersion forward when the probe observed one (an `absent`
  // target has no version). Preserve the prior version on `absent` so a
  // re-link probe can still diff against the last-known-good version.
  if (probe.remoteVersion !== undefined) {
    pointer.remoteVersion = probe.remoteVersion;
  }
  return {
    pointer,
    previousState,
    nextState,
    stateChanged: previousState !== nextState,
    becameDangling: previousState !== "dangling" && nextState === "dangling",
  };
}

// ---------------------------------------------------------------------------
// Connector facade — the on-demand heavy-read contract.
//
// A pointer row stores IDENTITY only. When a surface needs the actual content
// (to render a full preview, or to capture a snapshot) it goes through the
// connector facade, which resolves the third-party-canonical content live.
// This interface is pure (no impl here); the wordpress/drupal/gdrive connectors
// provide concrete facades from their `integration/module.ts`.
// ---------------------------------------------------------------------------

export type ConnectorRefResolvedContent = {
  mime: string;
  /** Text body for text-shaped targets (documents, posts, nodes). EXACTLY ONE
   * of `text` / `bytesBase64` must be present (a snapshot is a single-file
   * record). An empty string is a valid, present text body. */
  text?: string;
  /** Base64 bytes for binary targets (media, exported files). EXACTLY ONE of
   * `text` / `bytesBase64` must be present. A zero-length payload is valid. */
  bytesBase64?: string;
  sizeBytes?: number;
  title?: string;
};

export interface ConnectorRefFacade {
  /** The connector this facade serves (matches `ConnectorRefPointer.connectorId`). */
  readonly connectorId: string;
  /** Lightweight liveness/version check — feeds {@link applyConnectorRefVerification}. */
  probe(pointer: ConnectorRefPointer): Promise<ConnectorRefProbeResult>;
  /** Heavy on-demand content resolution (the body, never stored in the row). */
  resolveContent(pointer: ConnectorRefPointer): Promise<ConnectorRefResolvedContent>;
}

// ---------------------------------------------------------------------------
// Pin / context policy — external pointers are pinnable:false, never
// context-selectable. You pin the SNAPSHOT record instead.
// ---------------------------------------------------------------------------

/**
 * External-pointer types are NEVER context-selectable. Context resolution +
 * pinning flow through the (artifactId, representationRevisionId,
 * semanticAssertionId) triple over a concrete representation; a pointer has no
 * pinnable representation (its content is upstream). A constant, not a branch —
 * the honest signal is disposition-driven (`pinnable:false`), enforced by the
 * existing context-selection SQL guards.
 */
export function isConnectorRefContextSelectable(): false {
  return false;
}

/** The disposition invariant an `external` (connector-ref) claim MUST declare:
 * pointers are not pinnable (nothing local to snapshot at resolution time). */
export const EXTERNAL_POINTER_REQUIRED_PINNABLE = false as const;

/**
 * Validate that a claim disposition intended for an `external` pointer type
 * obeys the pointer invariant: `pinnable` MUST be false. Returns a flat error
 * list (empty = valid). Composes the real `parseClaimDispositions` union so a
 * pointer claim can never be minted pinnable — a pin attempt on a pointer type
 * is then rejected by the SAME `dispositions->>'pinnable' = 'true'` guard every
 * context-selection / content-snapshot path already applies.
 *
 * A disposition that fails the base union is reported as-is (fail-closed);
 * an ABSENT payload (`undefined` — the manifest omits the optional field) is
 * valid and defers to platform defaults. `null` is NOT absence — it is a
 * malformed value, so it falls through to `parseClaimDispositions` and fails
 * closed (the manifest's optional field is `undefined`/omitted, never `null`).
 */
export function externalPointerDispositionErrors(dispositions: unknown): string[] {
  if (dispositions === undefined) return [];
  const parsed = parseClaimDispositions(dispositions);
  if (!parsed.ok) return parsed.errors;
  if (parsed.dispositions.pinnable !== EXTERNAL_POINTER_REQUIRED_PINNABLE) {
    return [
      "external connector-ref pointer types must declare pinnable:false — " +
        "pin the captured snapshot record instead of the pointer",
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Snapshot / export — capture pointer content into a NEW record-class artifact.
//
// The explicit "snapshot / export" action reads the pointer's content through
// the facade and materializes it as a NEW, INDEPENDENT record-class artifact
// (file form). Atomicity (epic #1448 principle 2): the snapshot embeds NO
// artifact-ID reference to the pointer and carries NO FK — provenance is
// CORRELATION fields (soft strings) only, so the snapshot stays fully servable
// after the pointer row is deleted. This builder is PURE: it produces the
// neutral spec; the caller maps it onto the canonical artifact creation input
// and performs the write (which reads content through the facade first).
// ---------------------------------------------------------------------------

/** The origin kind a captured snapshot carries (it originated from an external
 * link). A member of the built-in `ArtifactOriginKind` union. */
export const CONNECTOR_REF_SNAPSHOT_ORIGIN_KIND = "external_link" as const;

/** Correlation-only provenance for a captured snapshot — soft strings, never
 * an artifact id, never an FK. Missing/tombstoned targets never affect the
 * snapshot's read/pin/delete/GC behavior. */
export type ConnectorRefSnapshotCorrelation = {
  connectorId: string;
  externalId: string;
  /** The validated source deeplink at capture time (null if it was unsafe). */
  sourceUrl: string | null;
  /** ISO timestamp the snapshot was captured. */
  capturedAt: string;
  /** The pointer's reference state at capture time (audit only). */
  capturedFromState: ConnectorRefState;
  /** The upstream version captured, when known. */
  remoteVersion?: string;
};

export type ConnectorRefSnapshotArtifact = {
  /** Record-class artifacts take the `file` representation form (self-contained). */
  representationForm: "file";
  originKind: typeof CONNECTOR_REF_SNAPSHOT_ORIGIN_KIND;
  mime: string;
  title: string;
  /** Text body (for text targets) OR base64 bytes (for binary targets) — the
   * resolved content, now OWNED by this independent artifact. */
  bodyText?: string;
  bytesBase64?: string;
  sizeBytes?: number;
  /** Soft provenance only — CORRELATION fields, no FK / no artifact-ID ref. */
  correlation: ConnectorRefSnapshotCorrelation;
};

export type BuildConnectorRefSnapshotInput = {
  pointer: ConnectorRefPointer;
  resolved: ConnectorRefResolvedContent;
  capturedAt: string;
  /** Optional explicit title override; defaults to the resolved/pointer title. */
  title?: string;
};

/**
 * Build the NEW record-class artifact spec for a captured pointer snapshot.
 * Pure — no I/O. The caller resolves `input.resolved` through the facade first,
 * then maps the returned spec onto the canonical creation input and writes it.
 *
 * Guarantees:
 *   - materialized: EXACTLY ONE of the resolved content's `text` /
 *     `bytesBase64` must be present, else {@link ConnectorRefSnapshotContentError}
 *     — a snapshot with no independent content (or two ambiguous ones) is never
 *     produced, so the record is genuinely servable after pointer delete;
 *   - self-contained: content lives in `bodyText`/`bytesBase64`, never a
 *     reference back to the pointer;
 *   - correlation-only provenance: {@link ConnectorRefSnapshotCorrelation}
 *     carries no artifact id and no FK, so the record survives pointer delete;
 *   - a deeplink is captured only if it is a safe http(s) URL.
 */
export function buildConnectorRefSnapshotArtifact(
  input: BuildConnectorRefSnapshotInput,
): ConnectorRefSnapshotArtifact {
  const { pointer, resolved } = input;
  // Exactly one materialized representation — presence (not truthiness), so an
  // empty string / zero-length payload is valid but "neither" and "both" are not.
  const hasText = resolved.text !== undefined;
  const hasBytes = resolved.bytesBase64 !== undefined;
  if (hasText === hasBytes) {
    throw new ConnectorRefSnapshotContentError(hasText && hasBytes ? "both" : "neither");
  }
  const title = input.title ?? resolved.title ?? pointer.title ?? pointer.externalId;
  const correlation: ConnectorRefSnapshotCorrelation = {
    connectorId: pointer.connectorId,
    externalId: pointer.externalId,
    sourceUrl: safeHttpUrl(pointer.url),
    capturedAt: input.capturedAt,
    capturedFromState: pointer.state,
    ...(pointer.remoteVersion !== undefined ? { remoteVersion: pointer.remoteVersion } : {}),
  };
  return {
    representationForm: "file",
    originKind: CONNECTOR_REF_SNAPSHOT_ORIGIN_KIND,
    mime: resolved.mime,
    title,
    ...(resolved.text !== undefined ? { bodyText: resolved.text } : {}),
    ...(resolved.bytesBase64 !== undefined ? { bytesBase64: resolved.bytesBase64 } : {}),
    ...(resolved.sizeBytes !== undefined ? { sizeBytes: resolved.sizeBytes } : {}),
    correlation,
  };
}

export class ConnectorRefSnapshotContentError extends Error {
  constructor(public readonly reason: "neither" | "both") {
    super(
      reason === "neither"
        ? "[connector-ref] snapshot resolved content has neither text nor bytesBase64 — a captured record must materialize its content"
        : "[connector-ref] snapshot resolved content has both text and bytesBase64 — a captured record is a single file, provide exactly one",
    );
    this.name = "ConnectorRefSnapshotContentError";
  }
}
