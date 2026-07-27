// Per-agent execution CONFIGURATION model — exec-plane S3 slice B
// (cinatra#1708; epic #1705).
//
// Slice B is the authoring half of L1 declared environments: the per-agent
// configuration surface where a human declares "this agent does not work
// without tool X" (execution on/off + the declared environment + the promotion
// affordance). This module is its PURE core — no I/O, no React, no DB — so the
// load-bearing rules are unit-testable on their own:
//
//   - ONE internal type, TWO authoring surfaces (the epic invariant). Both the
//     packaged-agent manifest claim and the project-agent config column resolve
//     through `parseExecutionEnvironment` (@cinatra-ai/sdk-extensions), so two
//     same-recipe agents share one L1 cache entry regardless of where the
//     recipe was authored.
//   - AUTHORITY, not merge (epic D8). A packaged agent's environment is owned
//     by its manifest and edits ride the extension review/lock choreography —
//     the app surface renders it READ-ONLY. Only a project agent's environment
//     is editable in-app (config approval). The two are never blended.
//   - FAIL-CLOSED submissions. A submitted declaration is accepted only if it
//     passes the same strict parser the trusted builder's recipe is hashed
//     from; a malformed entry is refused with the parser's own errors, never
//     sanitized or dropped.
//   - HONEST CONTRADICTION. "Execution off" + "declares an environment" is a
//     configuration that cannot mean anything at run time: the declared
//     recipe would be silently unused. It is refused at authoring time, so
//     the run seam never has to choose between a silent L0 downgrade and a
//     surprise refusal.
//
// Nothing here knows whether the execution plane is switched ON. Dormancy is a
// RENDERING concern (the surface must be honest that a stored declaration is
// not executing today) and is resolved by the app-side view model, not by
// silently rewriting the stored config.

import {
  EXECUTION_ENVIRONMENT_MANAGERS,
  canonicalExecutionEnvironmentJson,
  isEmptyExecutionEnvironment,
  parseExecutionEnvironment,
  type ExecutionEnvironmentManager,
  type ExecutionEnvironmentSpec,
} from "@cinatra-ai/sdk-extensions";

// ---------------------------------------------------------------------------
// The stored per-agent execution config
// ---------------------------------------------------------------------------

/**
 * The per-agent execution configuration as it is STORED.
 *
 * `executionEnabled` is three-valued on purpose (mirrors the nullable column):
 * `null` inherits the instance/org posture (epic D4 availability default),
 * `true` / `false` are explicit per-agent decisions.
 */
export type AgentExecutionConfig = {
  executionEnabled: boolean | null;
  environment: ExecutionEnvironmentSpec;
};

/** WHO owns an agent's declared environment — never both (epic D8). */
export type ExecutionEnvironmentAuthority =
  /** The packaged agent's manifest owns it: read-only here, edits ride the
   *  extension review/lock choreography. */
  | "manifest"
  /** The in-app agent config owns it: editable here, edits ride config
   *  approval and land in the next immutable version snapshot. */
  | "config";

export type ResolvedAgentEnvironment = {
  authority: ExecutionEnvironmentAuthority;
  /** The canonical spec, or `null` when the declaration is INVALID. */
  spec: ExecutionEnvironmentSpec | null;
  /** Parser errors when `spec` is null — never silently swallowed. */
  errors: string[];
  /** True when the resolved declaration is absent/empty ⇒ the agent runs L0. */
  empty: boolean;
};

/**
 * Resolve which declaration the surface must render, and whether it is
 * editable. Fail-closed in BOTH directions:
 *
 *  - a PRESENT manifest declaration always wins (a packaged agent's recipe is
 *    reviewed in its package, never re-authored in the app);
 *  - a manifest that could not be READ (`manifestReadFailed`) also resolves to
 *    `manifest` authority — an unreadable package must never silently hand
 *    edit rights to the app surface;
 *  - a declaration that fails the strict parser resolves with `spec: null` +
 *    the parser's errors, never with a partially-salvaged recipe.
 */
export function resolveAgentEnvironmentAuthority(input: {
  /** RAW `cinatra.execution.environment` claim from the package manifest. */
  manifestEnvironment?: unknown;
  /** RAW declared environment stored on the agent template row. */
  templateEnvironment?: unknown;
  /** The package manifest could not be read — fail closed to read-only. */
  manifestReadFailed?: boolean;
}): ResolvedAgentEnvironment {
  if (input.manifestReadFailed) {
    // UNKNOWN, not empty (codex round-2). An unreadable manifest must never
    // present as "declares nothing": that would render a confident empty recipe
    // for a package that may well declare one, and would hand the promotion
    // affordance an empty baseline to suggest against. `spec: null` is the
    // "no trustworthy declaration" state every consumer already handles.
    return {
      authority: "manifest",
      spec: null,
      errors: [
        "the package manifest could not be read, so this agent's declared " +
          "environment is UNKNOWN (it is not treated as empty)",
      ],
      empty: false,
    };
  }
  const manifestDeclared =
    input.manifestEnvironment !== undefined && input.manifestEnvironment !== null;
  if (manifestDeclared) {
    return {
      authority: "manifest",
      ...describeDeclaration(input.manifestEnvironment),
    };
  }
  return { authority: "config", ...describeDeclaration(input.templateEnvironment) };
}

function describeDeclaration(
  raw: unknown,
): Omit<ResolvedAgentEnvironment, "authority"> {
  if (raw === undefined || raw === null) {
    return { spec: {}, errors: [], empty: true };
  }
  const parsed = parseExecutionEnvironment(raw);
  if (!parsed.ok) return { spec: null, errors: parsed.errors, empty: false };
  return { spec: parsed.spec, errors: [], empty: isEmptyExecutionEnvironment(parsed.spec) };
}

// ---------------------------------------------------------------------------
// Starter templates ("start from a template")
// ---------------------------------------------------------------------------

/**
 * A named starting point for a declared environment. Authoring an L1 recipe
 * from an empty box means guessing package names; a starter template turns the
 * common cases into one click that then stays fully editable.
 *
 * These are ordinary declarations — they carry NO privilege, get NO special
 * cache treatment, and are validated by the same parser as hand-typed entries
 * (`assertStarterTemplatesValid` locks that at test time). Picking one is a
 * pure client-side prefill; nothing is stored until the human saves.
 */
export type ExecutionEnvironmentStarterTemplate = {
  id: string;
  label: string;
  description: string;
  spec: ExecutionEnvironmentSpec;
};

export const EXECUTION_ENVIRONMENT_STARTER_TEMPLATES: readonly ExecutionEnvironmentStarterTemplate[] =
  [
    {
      id: "empty",
      label: "Empty",
      description: "No packages — the agent runs on the platform base image alone.",
      spec: {},
    },
    {
      id: "documents",
      label: "Document conversion",
      description: "Convert between document formats (pandoc + a PDF engine).",
      spec: { os: ["pandoc", "poppler-utils", "texlive-xetex"] },
    },
    {
      id: "data-analysis",
      label: "Data analysis",
      description: "Tabular analysis and charts in Python.",
      spec: { pip: ["matplotlib", "numpy", "openpyxl", "pandas"] },
    },
    {
      id: "web-fetch",
      label: "Web fetching",
      description: "Fetch and parse pages over the egress gateway.",
      spec: { pip: ["beautifulsoup4", "httpx", "lxml"] },
    },
    {
      id: "media",
      label: "Media processing",
      description: "Transcode and inspect audio/video and images.",
      spec: { os: ["ffmpeg", "imagemagick"] },
    },
    {
      id: "node-tooling",
      label: "Node tooling",
      description: "Run Node-based formatters and linters over produced files.",
      spec: { npm: ["prettier", "typescript"] },
    },
  ];

/** Every starter template must itself pass the fail-closed parser — a starter
 *  that cannot be saved by hand must never be offered. Exported so the gate is
 *  a test, not a comment. */
export function assertStarterTemplatesValid(): void {
  for (const template of EXECUTION_ENVIRONMENT_STARTER_TEMPLATES) {
    const parsed = parseExecutionEnvironment(template.spec);
    if (!parsed.ok) {
      throw new Error(
        `starter template "${template.id}" is not a valid declaration:\n- ${parsed.errors.join("\n- ")}`,
      );
    }
    if (canonicalExecutionEnvironmentJson(parsed.spec) !== canonicalExecutionEnvironmentJson(template.spec)) {
      throw new Error(
        `starter template "${template.id}" is not in canonical form — it would hash ` +
          `differently from the same recipe typed by hand`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Submission parsing (the editor's contract)
// ---------------------------------------------------------------------------

/**
 * What the editor submits: the three manager lists as free text (one entry per
 * line — the shape a human actually types) plus the tri-state toggle.
 */
export type AgentExecutionConfigSubmission = {
  /** "inherit" | "on" | "off" — the tri-state per-agent posture. */
  executionEnabled: "inherit" | "on" | "off";
  os?: string;
  pip?: string;
  npm?: string;
};

export type ParseAgentExecutionConfigResult =
  | { ok: true; config: AgentExecutionConfig }
  | { ok: false; errors: string[] };

/**
 * Split a textarea into trimmed, non-empty entries — ONE PER LINE, newlines only.
 *
 * Deliberately NOT comma-separated: a comma is a legal character INSIDE a pip
 * requirement specifier (`pandas>=2,<3`), which the shared parser accepts. A
 * comma split would make a whole class of valid declarations unauthorable here
 * and quietly shred them into two invalid entries — the exact
 * one-parser/one-recipe-language contract this surface exists to uphold
 * (codex round-1 finding c2).
 */
export function splitEnvironmentEntries(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Parse + validate an editor submission fail-closed. The declaration goes
 * through the SAME parser the trusted builder hashes its recipe from, so what
 * the surface accepts is exactly what the builder can build.
 *
 * The one rule this layer adds on top of the parser is the CONTRADICTION rule:
 * an agent explicitly opted OUT of execution cannot also declare an
 * environment. Storing that pair would mean either silently ignoring a
 * declared recipe at run time or refusing every run — both are worse than
 * refusing the save with an explanation.
 */
export function parseAgentExecutionConfigSubmission(
  submission: AgentExecutionConfigSubmission,
): ParseAgentExecutionConfigResult {
  const raw: Record<string, string[]> = {};
  for (const manager of EXECUTION_ENVIRONMENT_MANAGERS) {
    const entries = splitEnvironmentEntries(submission[manager]);
    if (entries.length > 0) raw[manager] = entries;
  }
  const parsed = parseExecutionEnvironment(raw);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };

  // An UNRECOGNIZED posture is refused, never coerced to "inherit": the value
  // arrives from a form submission, and silently rewriting an unknown posture
  // into the permissive default is exactly the silent-degrade this slice's
  // fail-closed discipline forbids (codex round-1 finding b4).
  if (!["inherit", "on", "off"].includes(submission.executionEnabled)) {
    return {
      ok: false,
      errors: [
        `"${String(submission.executionEnabled)}" is not a valid execution posture ` +
          `(expected inherit, on, or off)`,
      ],
    };
  }
  const executionEnabled =
    submission.executionEnabled === "on"
      ? true
      : submission.executionEnabled === "off"
        ? false
        : null;

  if (executionEnabled === false && !isEmptyExecutionEnvironment(parsed.spec)) {
    return {
      ok: false,
      errors: [
        "Execution is switched OFF for this agent, so a declared environment could " +
          "never be built or mounted. Remove the declared packages, or switch " +
          "execution back to on/inherit.",
      ],
    };
  }
  return { ok: true, config: { executionEnabled, environment: parsed.spec } };
}

/**
 * The value written to `agent_templates.execution_environment`. An EMPTY
 * declaration is stored as `null`, not `"{}"` — "declares nothing" and "has no
 * declaration" must be one state, so an agent never version-snapshots an empty
 * recipe object and drifts its content hash.
 */
export function serializeExecutionEnvironmentForStorage(
  spec: ExecutionEnvironmentSpec,
): string | null {
  if (isEmptyExecutionEnvironment(spec)) return null;
  return canonicalExecutionEnvironmentJson(spec);
}

/** Render a canonical spec back into the editor's per-manager text areas. */
export function environmentToEditorText(
  spec: ExecutionEnvironmentSpec | null,
): Record<ExecutionEnvironmentManager, string> {
  const out = {} as Record<ExecutionEnvironmentManager, string>;
  for (const manager of EXECUTION_ENVIRONMENT_MANAGERS) {
    out[manager] = (spec?.[manager] ?? []).join("\n");
  }
  return out;
}

/** Total declared entries across every manager — the surface's summary count. */
export function countDeclaredEntries(spec: ExecutionEnvironmentSpec | null): number {
  if (!spec) return 0;
  return EXECUTION_ENVIRONMENT_MANAGERS.reduce(
    (total, manager) => total + (spec[manager]?.length ?? 0),
    0,
  );
}
