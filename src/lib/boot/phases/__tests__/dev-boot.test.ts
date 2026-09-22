/**
 * THE AWAITED GIT-NATIVE AGENT INGEST PHASE (cinatra#3626).
 *
 * The phase is what makes one start enough. In development the whole boot is
 * detached from `register()`, so the development server serves either way; what
 * awaiting this phase moves is the READY marker — it completes before
 * `markBootReady()`, so a poller that waits for `/api/health` to leave
 * `starting` gets an instance whose agent rows are on file.
 *
 * Its claims here are the phase's own — the walk is mocked, because the walk has
 * its own suite and the rows have the real-database tier:
 *
 *   - it is declared the way the orchestrator needs it (a `dev-only` phase, so
 *     production never runs it and a failure never blocks boot);
 *   - it reports what it read in, on one line, naming what it declined, what it
 *     could not read, and what its budget did not reach;
 *   - an instance with no extension source tree records a SKIP, not a failure —
 *     a minimal deployment has nothing to read in;
 *   - a failure REACHES the runner, so the phase is recorded and logged rather
 *     than swallowed here; readiness and `/api/health` are untouched, which is
 *     the `dev-only` policy's whole point;
 *   - the budget's expiry is reported as a failure that NAMES the definitions
 *     still pending, so a stuck loader is this phase's answer instead of the
 *     boot-stall watchdog exiting the development server.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { ingestGitNativeAgentDefinitions, resolveDevExtensionSourceRoot } = vi.hoisted(() => ({
  ingestGitNativeAgentDefinitions: vi.fn(),
  resolveDevExtensionSourceRoot: vi.fn(),
}));

vi.mock("@/lib/git-native-agent-ingest", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/git-native-agent-ingest")>();
  return {
    GIT_NATIVE_AGENT_INGEST_BUDGET_MS: actual.GIT_NATIVE_AGENT_INGEST_BUDGET_MS,
    ingestGitNativeAgentDefinitions,
  };
});
vi.mock("@cinatra-ai/agents/agent-runtime-mount", () => ({ resolveDevExtensionSourceRoot }));

import { devAgentIngestPhases } from "@/lib/boot/phases/dev-boot";
import { GIT_NATIVE_AGENT_INGEST_BUDGET_MS } from "@/lib/git-native-agent-ingest";

let sourceRoot = "";
let info: ReturnType<typeof vi.spyOn>;
const lines: string[] = [];

function report(overrides: Record<string, unknown> = {}) {
  return {
    sourceRoot,
    found: 3,
    imported: 3,
    alreadyOnFile: 0,
    declined: 0,
    pending: [],
    failures: [],
    ...overrides,
  };
}

/** The single phase, as the orchestrator receives it. */
function thePhase() {
  const phases = devAgentIngestPhases();
  expect(phases).toHaveLength(1);
  return phases[0]!;
}

beforeEach(async () => {
  lines.length = 0;
  sourceRoot = await mkdtemp(path.join(tmpdir(), "dev-agent-ingest-"));
  resolveDevExtensionSourceRoot.mockReturnValue(sourceRoot);
  ingestGitNativeAgentDefinitions.mockReset();
  ingestGitNativeAgentDefinitions.mockResolvedValue(report());
  info = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
});

afterEach(async () => {
  info.mockRestore();
  vi.restoreAllMocks();
  await rm(sourceRoot, { recursive: true, force: true });
});

describe("devAgentIngestPhases", () => {
  it("is a dev-only phase the orchestrator can await", () => {
    const phase = thePhase();
    expect(phase.name).toBe("dev-agent-ingest");
    expect(phase.policy).toBe("dev-only");
  });

  it("walks the extension source tree and reports what it read in", async () => {
    await expect(thePhase().run()).resolves.toBeUndefined();

    expect(ingestGitNativeAgentDefinitions).toHaveBeenCalledWith({ sourceRoot });
    expect(lines).toEqual([
      "[agent-builder] git-native agent definitions: 3 found, 3 read in, 0 already on file",
    ]);
  });

  it("reports a second boot as nothing to do", async () => {
    ingestGitNativeAgentDefinitions.mockResolvedValue(report({ imported: 0, alreadyOnFile: 3 }));

    await thePhase().run();

    expect(lines).toEqual([
      "[agent-builder] git-native agent definitions: 3 found, 0 read in, 3 already on file",
    ]);
  });

  it("names what the loader declined apart from what it could not read", async () => {
    ingestGitNativeAgentDefinitions.mockResolvedValue(
      report({
        found: 4,
        imported: 2,
        alreadyOnFile: 0,
        declined: 1,
        failures: [{ definitionPath: "cinatra-ai/broken-agent/cinatra/oas.json", reason: "x" }],
      }),
    );

    await thePhase().run();

    expect(lines).toEqual([
      "[agent-builder] git-native agent definitions: 4 found, 2 read in, 0 already on file, " +
        "1 declined, 1 not read in",
    ]);
  });

  it("records a SKIP, not a failure, when the instance has no extension source tree", async () => {
    resolveDevExtensionSourceRoot.mockReturnValue(path.join(sourceRoot, "no-such-tree"));

    await expect(thePhase().run()).resolves.toEqual({
      skipped: "no extension source tree to read agent definitions from",
    });
    expect(ingestGitNativeAgentDefinitions).not.toHaveBeenCalled();
    expect(lines).toEqual([]);
  });

  it("lets a genuine failure reach the runner, so the phase is recorded", async () => {
    ingestGitNativeAgentDefinitions.mockRejectedValue(new Error("the tree could not be read"));

    await expect(thePhase().run()).rejects.toThrow("the tree could not be read");
  });

  it("reports the budget's expiry as a failure that names the definitions still pending", async () => {
    ingestGitNativeAgentDefinitions.mockResolvedValue(
      report({
        found: 3,
        imported: 1,
        alreadyOnFile: 0,
        pending: ["cinatra-ai/b-agent/cinatra/oas.json", "cinatra-ai/c-agent/cinatra/oas.json"],
      }),
    );

    // The line still goes out — what was read in is not lost because the rest
    // was not reached.
    await expect(thePhase().run()).rejects.toThrow(
      /2 definition\(s\) still pending: cinatra-ai\/b-agent\/cinatra\/oas\.json, cinatra-ai\/c-agent\/cinatra\/oas\.json/,
    );
    expect(lines).toEqual([
      "[agent-builder] git-native agent definitions: 3 found, 1 read in, 0 already on file, " +
        `2 still pending at the ${GIT_NATIVE_AGENT_INGEST_BUDGET_MS} ms budget`,
    ]);
  });
});
