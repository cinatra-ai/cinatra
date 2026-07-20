import "server-only";

// ---------------------------------------------------------------------------
// Host config reader + PRE-FINALIZE install gate for the assistant DECLARATION
// (cinatra#1874, Epic #1873 W1 — install choreography, seam 1).
//
// An assistant is an `agent`-kind extension whose materialized (SRI-verified)
// `cinatra/config.json` carries an `assistant` block. This module reads that
// config over the store dir through the SINGLE shared parser
// (`@cinatra-ai/sdk-extensions/assistant-declaration`) with INSTALL-surface
// semantics and enforces the two pre-journal invariants the install pipeline
// owns, BEFORE the first durable mutation (`beginInstallOp`), so a refused
// assistant install is fully inert:
//
//   - XOR (assistant ⊕ executor): a package that declares an `assistant`
//     block must NOT also carry connector-executor content (an `access` block
//     / compilable OAS) in the same shared config file — an assistant has no
//     executor of its own (its run surface is the host runtime). Both present
//     → refuse pre-journal (AC#2).
//   - PLATFORM-SCOPE: an assistant declaration installs ONLY at platform scope
//     (`orgId === null`). An org / team / project-target install (a non-null
//     org scope) is refused with a directing error pointing at the platform
//     install path (AC#1). The SAME rule holds on the direct agent-registry
//     path (packages/agents), so an assistant can never be adopted org-scoped.
//
// Both gates run in the pipeline's inert window with the same GC-on-refuse
// contract as `readAccessDeclarationInertly`. The resolved declaration STAMPS
// onto `installed_extension.assistant_declaration` at the LATE finalize seam
// (a separate slice); this module owns only the read + the pre-journal gate.
// ---------------------------------------------------------------------------

import {
  AssistantDeclarationError,
  hasAssistantBlock,
  parseAssistantDeclaration,
  type ResolvedAssistantDeclaration,
} from "@cinatra-ai/sdk-extensions/assistant-declaration";

export type { ResolvedAssistantDeclaration };

/**
 * The signals the install pipeline's pre-finalize gate needs from a
 * materialized package's shared config.json:
 *   - `declaration`: the resolved assistant declaration, or `null` when the
 *     package is not an assistant (non-agent kind, no config, or no `assistant`
 *     block). A present-but-MALFORMED block is a throw at read time (fail-closed
 *     — never a silent null).
 *   - `hasConnectorExecutor`: whether the SAME config.json ALSO carries
 *     connector-executor content (an `access` block / compilable OAS) — the XOR
 *     signal. Meaningful only when `declaration !== null`.
 */
export type AssistantInstallSignals = {
  declaration: ResolvedAssistantDeclaration | null;
  hasConnectorExecutor: boolean;
};

/**
 * Refusal raised by the pre-finalize assistant gate. Distinct from
 * `AssistantDeclarationError` (a parse/validation failure) — this is a
 * choreography refusal (XOR / scope) carrying a DIRECTING message so the caller
 * knows the correct install path.
 */
export class AssistantInstallConstraintError extends Error {
  constructor(message: string) {
    super(`[assistant-install] ${message}`);
    this.name = "AssistantInstallConstraintError";
  }
}

// ---------------------------------------------------------------------------
// Install-pipeline seam — the assistant-declaration vertical slice of
// `InstallPipelineDeps`: the EARLY fail-closed read (install refused fully
// inert). Mirrors `ConnectorAccessDeclarationInstallDeps`.
// ---------------------------------------------------------------------------

export type AssistantDeclarationInstallDeps = {
  /**
   * Resolve the assistant install signals from the materialized store dir — the
   * fail-closed read of `cinatra/config.json` through the shared SDK parser
   * (agent-kind only; a malformed `assistant` block THROWS). Returns
   * `{ declaration: null, hasConnectorExecutor: false }` for a non-assistant
   * package. Runs EARLY (with the host-compat / dependency-edge / access reads,
   * before any durable mutation, same inertness/GC contract) so a refused
   * assistant install is fully inert. OPTIONAL — omitted in unit tests (then no
   * assistant gate runs); the default factory always wires the host reader
   * (`readAssistantInstallSignalsFromStore`).
   */
  readAssistantInstallSignals?: (storeDir: string) => Promise<AssistantInstallSignals>;
};

type AssistantSignalsReadDeps = AssistantDeclarationInstallDeps & {
  gcStoreDir?: (storeDir: string) => Promise<void>;
};

/**
 * EARLY fail-closed read for the install pipeline: a malformed `assistant`
 * block (or an unreadable/corrupt config) THROWS — BEFORE the pipeline's first
 * durable mutation, so the install/update is refused fully inert — and the
 * just-materialized dir is GC'd best-effort UNLESS it IS the live install's dir
 * (`isLiveDigest`, the same-digest re-install guard). Returns the neutral
 * (no-assistant) signal when no reader is wired.
 */
export async function readAssistantInstallSignalsInertly(
  deps: AssistantSignalsReadDeps,
  storeDir: string,
  isLiveDigest: boolean,
): Promise<AssistantInstallSignals> {
  if (!deps.readAssistantInstallSignals) return { declaration: null, hasConnectorExecutor: false };
  try {
    return await deps.readAssistantInstallSignals(storeDir);
  } catch (err) {
    if (deps.gcStoreDir && !isLiveDigest) {
      try {
        await deps.gcStoreDir(storeDir);
      } catch {
        /* best-effort GC — a leftover dir is recovered by a later retry's gate. */
      }
    }
    throw err;
  }
}

/**
 * The PRE-FINALIZE gate (cinatra#1874, AC#1 + AC#2): enforce the assistant⊕
 * executor XOR and platform-scope BEFORE the first durable mutation. A
 * non-assistant package (`declaration === null`) is a no-op. A violation throws
 * {@link AssistantInstallConstraintError} with a directing message — the
 * pipeline's inert window turns that into a fully-inert refusal.
 */
export function assertAssistantInstallConstraints(input: {
  signals: AssistantInstallSignals;
  orgId: string | null;
  packageName: string;
}): void {
  const { declaration, hasConnectorExecutor } = input.signals;
  if (declaration === null) return; // not an assistant — no gate.

  // XOR (AC#2): declaration + a compilable executor (connector `access` block /
  // OAS) are mutually exclusive — an assistant has no executor of its own.
  if (hasConnectorExecutor) {
    throw new AssistantInstallConstraintError(
      `${input.packageName} declares BOTH an assistant block and connector-executor content ` +
        `(an \`access\` block / compilable OAS) in cinatra/config.json — these are mutually ` +
        `exclusive (an assistant runs on the host runtime and has no executor of its own). ` +
        `Ship the package as EITHER an assistant OR an executor-backed connector, not both.`,
    );
  }

  // PLATFORM-SCOPE (AC#1): an assistant installs ONLY at platform scope.
  if (input.orgId !== null) {
    throw new AssistantInstallConstraintError(
      `${input.packageName} declares an assistant block and can only be installed at PLATFORM scope ` +
        `(org ${input.orgId} was targeted). Install the assistant through the platform install path ` +
        `(a platform-admin, no org/team/project target) so it is adopted platform-wide; audience ` +
        `access is then granted per install, not by install scope.`,
    );
  }
}

/**
 * Resolve the assistant install signals for a materialized package dir (the
 * host reader wired into `makeDefaultInstallPipelineDeps`). Returns the neutral
 * (no-assistant) signal for a non-agent kind, an absent config, or an
 * agent package with no `assistant` block; THROWS on a malformed block or an
 * unreadable/corrupt config (the caller aborts the install fully inert).
 */
export async function readAssistantInstallSignalsFromStore(
  storeDir: string,
): Promise<AssistantInstallSignals> {
  const NONE: AssistantInstallSignals = { declaration: null, hasConnectorExecutor: false };
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");

  let manifestRaw: string;
  try {
    manifestRaw = await readFile(path.join(storeDir, "package.json"), "utf8");
  } catch {
    // No manifest → not a readable package; the materializer/loader owns that
    // failure. The assistant reader has nothing to declare on.
    return NONE;
  }
  let manifest: { name?: unknown; cinatra?: { kind?: unknown } };
  try {
    manifest = JSON.parse(manifestRaw) as typeof manifest;
  } catch {
    return NONE; // Malformed package.json is the materializer's fail domain.
  }
  // Only an agent-kind package can be an assistant.
  if (manifest.cinatra?.kind !== "agent") return NONE;
  const packageName = typeof manifest.name === "string" ? manifest.name : "";

  const configPath = path.join(storeDir, "cinatra", "config.json");
  let configRaw: string;
  try {
    configRaw = await readFile(configPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      // Genuinely absent → the agent declares no assistant.
      return NONE;
    }
    // Present but unreadable (permissions, IO) — fail closed, never neutral.
    throw new AssistantDeclarationError(
      `cinatra/config.json for ${packageName} exists but is unreadable: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(configRaw);
  } catch (err) {
    throw new AssistantDeclarationError(
      `cinatra/config.json for ${packageName} is not valid JSON: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }

  // The XOR signal derives from the SAME shared config file. The shared schema
  // is `{ formatVersion, access?, assistant? }`: the `access` block is the
  // CONNECTOR's declaration (its access/visibility scope — the executor half of
  // a connector; see access-config.ts). A well-formed ASSISTANT never carries
  // `access` — an assistant's audience lives in `assistant_audience`, not in the
  // connector `access` block — so a config that declares BOTH an `assistant`
  // block AND an `access` block is a package claiming to be an assistant AND a
  // (compilable-OAS-backed) connector executor at once: the exact contradiction
  // the assistant⊕executor XOR forbids. Read BEFORE the assistant parse so the
  // both-declaring case surfaces the XOR refusal at the gate (a directing
  // error), not an opaque parse error. (Codex convergence: this is the
  // config-level executor signal detectable at this seam; a deeper per-artifact
  // OAS walk is the runtime-loader/manifest-generator touchpoint's concern.)
  const hasConnectorExecutor =
    typeof parsed === "object" &&
    parsed !== null &&
    "access" in parsed &&
    (parsed as { access?: unknown }).access !== undefined &&
    (parsed as { access?: unknown }).access !== null;

  // A config with no `assistant` block resolves to null (fast path); a present
  // block is validated + projected (fail-closed).
  const declaration = hasAssistantBlock(parsed)
    ? parseAssistantDeclaration(parsed, { packageName })
    : null;

  return { declaration, hasConnectorExecutor };
}
