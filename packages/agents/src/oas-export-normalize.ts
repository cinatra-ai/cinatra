/**
 * Export-side OAS repair for the agent_export -> agent_import round trip
 * (cinatra#2645).
 *
 * The on-disk `cinatra/oas.json` an export ships is not always written by the
 * validated `agent_source_write` path. Wayflow-style writers (the Oracle
 * agent-spec exporter and documents that entered disk through proposal
 * materialization or dev mounts) serialize every absent optional field as an
 * explicit `null` and omit `metadata.cinatra.type` entirely. The importer's
 * compiler (`oas-compiler.ts`) rejects exactly those two artifacts:
 *
 *   - `flowSchema.metadata.cinatra.type` is a REQUIRED enum
 *     (`orchestrator|leaf|node|flow`) — an absent key fails compile.
 *   - Connection / port descriptions are `z.string().optional()` — a string
 *     or an ABSENT key, never `null`.
 *
 * `agent_export` therefore normalizes the document at the export boundary so
 * every archive it produces round-trips through `importAgentTemplateCore`:
 *
 *   1. A `component_type: "Flow"` document missing `metadata.cinatra.type`
 *      gets the type derived from its component_type (Flow -> "flow").
 *   2. Every `description` key whose value is exactly `null` is removed,
 *      recursively (root, edges of both kinds, ports, nodes, nested
 *      subflows). A `null` description carries no information — the compiler
 *      treats an absent description as the default everywhere, and the one
 *      schema that tolerates `null` (`parallelFlowNodeSchema.description`)
 *      treats it identically to absent.
 *
 * The compiler intentionally stays strict (the exporter emitting `null` for
 * an optional string is the defect — see #2645); this module fixes the
 * document at the only boundary the export path controls. Repairs are
 * deterministic and idempotent; a document that needs no repair is reported
 * `changed: false` so the caller can keep shipping the original bytes
 * byte-for-byte.
 */

const OAS_FLOW_TYPE_ENUM = new Set(["orchestrator", "leaf", "node", "flow"]);

export type OasExportNormalization = {
  /** The repaired document (a deep copy) — or the original reference when `changed` is false. */
  doc: Record<string, unknown>;
  /** True when at least one repair fired; false means "ship the original bytes". */
  changed: boolean;
  /** Human-readable record of each repair, for logging/diagnostics. */
  repairs: string[];
};

/** Recursively delete every `description` key whose value is exactly `null`. */
function stripNullDescriptions(value: unknown, path: string, repairs: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => stripNullDescriptions(item, `${path}[${i}]`, repairs));
    return;
  }
  if (value === null || typeof value !== "object") return;
  const rec = value as Record<string, unknown>;
  if ("description" in rec && rec.description === null) {
    delete rec.description;
    repairs.push(`removed null description at ${path || "<root>"}`);
  }
  for (const [key, child] of Object.entries(rec)) {
    stripNullDescriptions(child, path ? `${path}.${key}` : key, repairs);
  }
}

/**
 * Repair an OAS document for export so the archive compiles on import.
 * Pure and deterministic; the input object is never mutated.
 */
export function normalizeOasDocumentForExport(
  parsed: Record<string, unknown>,
): OasExportNormalization {
  const repairs: string[] = [];
  const doc = structuredClone(parsed);

  // (1) metadata.cinatra.type — required by flowSchema at the document root.
  // Derive from component_type (a Flow document is type "flow") when the key
  // is absent or null. An existing enum value is never overwritten.
  if (doc.component_type === "Flow") {
    const metadata =
      doc.metadata !== null && typeof doc.metadata === "object" && !Array.isArray(doc.metadata)
        ? (doc.metadata as Record<string, unknown>)
        : undefined;
    const cinatra =
      metadata &&
      metadata.cinatra !== null &&
      typeof metadata.cinatra === "object" &&
      !Array.isArray(metadata.cinatra)
        ? (metadata.cinatra as Record<string, unknown>)
        : undefined;
    const existingType = cinatra?.type;
    if (typeof existingType !== "string" || !OAS_FLOW_TYPE_ENUM.has(existingType)) {
      const target = cinatra ?? {};
      target.type = "flow";
      const metaTarget = metadata ?? {};
      metaTarget.cinatra = cinatra ?? target;
      doc.metadata = metadata ?? metaTarget;
      repairs.push(
        `derived metadata.cinatra.type: "flow" from component_type "Flow" (was ${JSON.stringify(existingType ?? null)})`,
      );
    }
  }

  // (2) description: null — recursively removed everywhere.
  stripNullDescriptions(doc, "", repairs);

  if (repairs.length === 0) {
    return { doc: parsed, changed: false, repairs };
  }
  return { doc, changed: true, repairs };
}
