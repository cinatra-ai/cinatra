// -----------------------------------------------------------------------------
// THE GIT-NATIVE AGENT INGEST — the walk the boot phase runs.
//
// The agent definitions committed under the extension source tree become
// database rows through `ensureAgentPackageFromGitFile`, one definition at a
// time. The walk that FINDS those definitions used to be the opening half of the
// development boot's DETACHED block, so it finished some seconds after the boot
// had reached its ready marker: an instance that had just been prepared reported
// itself ready while its agent rows were still filling in, and the way to get a
// complete one was to start it a second time (cinatra#3626).
//
// It is a plain function over a directory now, so the boot can AWAIT it as its
// own phase (`devAgentIngestPhases`, `src/lib/boot/phases/dev-boot.ts`) while
// the rest of that block — the skill-package load, the catalog rebuild, the
// hot-reload watcher — keeps the detachment it was given. Anything else that
// must read the same definitions calls this walk rather than re-deriving the
// layout rules; a layout added here is found by every caller.
//
// IDEMPOTENT, because the loader is — with one cost a restart still pays, and
// the report below is careful not to hide it. The loader's version-skip guard
// covers the TEMPLATE ROW only: a package's declared tables (its database role
// and its tables) are activated INDEPENDENTLY of that skip, above the guard
// (`packages/agents/src/ensure-agent-package.ts:616-621`, cinatra#3462), so a
// table-declaring package is runnable on a database created from nothing. A
// restart therefore costs one read per table-declaring package to confirm its
// activation is current — nothing is re-created and no privilege is re-granted
// while it is.
//
// BOUNDED, because a boot phase that can hang is one the boot-stall watchdog
// eventually EXITS (`src/lib/boot/boot-stall-watchdog.ts:33`: 180 s, and its
// development arm calls `process.exit(1)`). A development-only convenience must
// never be the reason a development server dies, so the walk carries its own
// budget and reports what it did not reach instead of waiting forever. Same
// shape as the boot's other bounded step, the execution-plane live probe
// (`src/lib/boot/phases/execution-plane-health.ts:131-168`): one documented
// constant, no operator override, an `unref`'d timer that is always cleared.
//
// NO RUNTIME GATE HERE, deliberately. This module walks a directory and calls a
// loader; which runtimes may do that is the caller's question. The boot phase is
// gated by the orchestrator's development-mode guard and by its own `dev-only`
// policy — a second gate in here would answer that question on behalf of callers
// it does not speak for.
//
// A DEFINITION THE LOADER CANNOT READ is logged with the definition it was
// reading, recorded in the report, and the walk continues with the next one.
// The loader is handed a path and answers with row counts, so neither the log
// nor the report can carry the instance's connection string.
// -----------------------------------------------------------------------------

/**
 * The whole walk's budget. Generous next to what the work costs (a first ingest
 * of the shipped tree is seconds) and well under the boot-stall watchdog's
 * 180 s, so a stuck loader is reported by THIS phase rather than collected by a
 * watchdog that exits the development server.
 *
 * No environment override, matching the precedent this follows
 * (`LIVE_PROBE_TIMEOUT_MS`): an operator-supplied ceiling above the watchdog's
 * would restore exactly the failure this bound exists to remove.
 */
export const GIT_NATIVE_AGENT_INGEST_BUDGET_MS = 60_000;

/** A definition the loader could not read, named so an operator can find it. */
export type GitNativeAgentIngestFailure = {
  /** The definition's path, relative to the source root that was walked. */
  definitionPath: string;
  reason: string;
};

export type GitNativeAgentIngestReport = {
  /** The tree that was walked. */
  sourceRoot: string;
  /** Definitions found on disk. */
  found: number;
  /** Definitions the loader imported. */
  imported: number;
  /**
   * Definitions the loader left standing: a row is already on file, either at
   * the manifest's version (the version-skip guard) or at a NEWER one the
   * loader preserved (the downgrade guard,
   * `packages/agents/src/ensure-agent-package.ts:710-715`).
   */
  alreadyOnFile: number;
  /**
   * Definitions the loader DECLINED — it wrote nothing and there is no row: an
   * unreadable sibling manifest, no package name, or a reserved workspace slug
   * (`ensure-agent-package.ts:568-573`, `:584-590`, `:596-601`). Each one logged
   * its own reason when it declined.
   */
  declined: number;
  /**
   * Definitions the walk never resolved because the budget ran out, relative to
   * the source root. Empty on every run that finished.
   */
  pending: string[];
  failures: GitNativeAgentIngestFailure[];
};

/** The per-definition loader, as this walk uses it. The test seam. */
export type GitNativeAgentDefinitionLoader = (opts: {
  oasSourcePath: string;
  licenseAcknowledged?: boolean;
}) => Promise<{ templateId: string; upserted: boolean; skipped: boolean }>;

export type GitNativeAgentIngestOptions = {
  /** Defaults to the extension source root (`resolveDevExtensionSourceRoot()`). */
  sourceRoot?: string;
  /** Defaults to `GIT_NATIVE_AGENT_INGEST_BUDGET_MS`. */
  budgetMs?: number;
  /** Test seam — defaults to `ensureAgentPackageFromGitFile`. */
  loadDefinition?: GitNativeAgentDefinitionLoader;
};

/** The budget ran out while a definition was in the loader's hands. */
class IngestBudgetExpired extends Error {}

/**
 * Race a promise against a hard deadline. The timer is `unref`'d (a pending load
 * must never be the reason a process stays alive) and always cleared (a walk of
 * thirty definitions must not leak thirty timers). Mirrors `withDeadline` in
 * `src/lib/boot/phases/execution-plane-health.ts:154`, which is private to that
 * phase; only the rejection type differs, because this caller has to tell its
 * own budget apart from a loader that threw.
 */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new IngestBudgetExpired(`the definition did not load within ${ms} ms`)),
      ms,
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Every git-native agent definition under `sourceRoot`, in the order the boot
 * scan always probed the layouts:
 *
 *   1. the vendor namespace, `<vendor>/<slug>/cinatra/oas.json` (or the
 *      transitional `…/cinatra/agent.json` beside it). A vendor directory that
 *      yields at least one definition is not probed further.
 *   2. `<slug>/cinatra/agent.json`.
 *   3. `<slug>/agent.json`.
 *
 * A source root that cannot be read at all THROWS — that is a question about the
 * tree, and each caller answers it its own way. An unreadable directory BELOW
 * the root is skipped, as it always was.
 */
async function collectDefinitions(sourceRoot: string): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { existsSync } = await import("node:fs");

  const definitions: string[] = [];
  const entries = await readdir(sourceRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const entryPath = join(sourceRoot, entry.name);

    // Vendor-namespace probe first
    // (e.g., extensions/cinatra-ai/<slug>-agent/cinatra/oas.json).
    let foundInside = false;
    try {
      const subEntries = await readdir(entryPath, { withFileTypes: true });
      for (const sub of subEntries) {
        if (!sub.isDirectory()) continue;
        const oasJson = join(entryPath, sub.name, "cinatra", "oas.json");
        const transitional = join(entryPath, sub.name, "cinatra", "agent.json");
        const target = existsSync(oasJson)
          ? oasJson
          : existsSync(transitional)
            ? transitional
            : null;
        if (target) {
          definitions.push(target);
          foundInside = true;
        }
      }
    } catch {
      // Non-fatal — skip unreadable subdirectories
    }
    if (foundInside) continue;

    // Fallback layout — entry/<cinatra/agent.json> or entry/agent.json.
    const cinatraAgentJson = join(entryPath, "cinatra", "agent.json");
    const firstLevelAgentJson = join(entryPath, "agent.json");
    if (existsSync(cinatraAgentJson)) definitions.push(cinatraAgentJson);
    else if (existsSync(firstLevelAgentJson)) definitions.push(firstLevelAgentJson);
  }
  return definitions;
}

/** Read every git-native agent definition under `sourceRoot` into the database. */
export async function ingestGitNativeAgentDefinitions(
  options?: GitNativeAgentIngestOptions,
): Promise<GitNativeAgentIngestReport> {
  const { relative } = await import("node:path");

  const loadDefinition =
    options?.loadDefinition ??
    (await import("@cinatra-ai/agents")).ensureAgentPackageFromGitFile;
  const sourceRoot =
    options?.sourceRoot ??
    (await import("@cinatra-ai/agents/agent-runtime-mount")).resolveDevExtensionSourceRoot();
  const budgetMs = options?.budgetMs ?? GIT_NATIVE_AGENT_INGEST_BUDGET_MS;

  const definitions = await collectDefinitions(sourceRoot);
  const report: GitNativeAgentIngestReport = {
    sourceRoot,
    found: definitions.length,
    imported: 0,
    alreadyOnFile: 0,
    declined: 0,
    pending: [],
    failures: [],
  };

  const expiresAt = Date.now() + budgetMs;
  for (let i = 0; i < definitions.length; i += 1) {
    const oasSourcePath = definitions[i]!;
    const definitionPath = relative(sourceRoot, oasSourcePath);

    const remainingMs = expiresAt - Date.now();
    if (remainingMs <= 0) {
      report.pending = definitions.slice(i).map((p) => relative(sourceRoot, p));
      break;
    }

    try {
      // The operator owns the definitions in this tree, so a copyleft license
      // needs no interactive acknowledgement — the loader honours that request
      // for a verified first-party agent only.
      const outcome = await withDeadline(
        loadDefinition({ oasSourcePath, licenseAcknowledged: true }),
        remainingMs,
      );
      // `skipped` is the loader's OWN word for "I wrote nothing", and it is the
      // one to read. `upserted` distinguishes an update from a create inside the
      // import that did run, so a definition reaching the database for the FIRST
      // time answers `{ upserted: false, skipped: false }` — counting on that
      // field would report a whole first ingest as "already current".
      //
      // A skip is then two different answers, and the template id tells them
      // apart: the loader's three REFUSALS return no id at all, while both roads
      // that leave a row standing return the row's id.
      if (!outcome.skipped) report.imported += 1;
      else if (outcome.templateId === "") report.declined += 1;
      else report.alreadyOnFile += 1;
    } catch (fileErr) {
      if (fileErr instanceof IngestBudgetExpired) {
        report.pending = definitions.slice(i).map((p) => relative(sourceRoot, p));
        break;
      }
      console.warn(`[agent-builder] git agent load skipped (${definitionPath}):`, fileErr);
      report.failures.push({
        definitionPath,
        reason: fileErr instanceof Error ? fileErr.message : String(fileErr),
      });
    }
  }

  return report;
}
