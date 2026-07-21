// cinatra#1874 W1 — the assistant PRE-FINALIZE install gate threaded through
// the install pipeline (install choreography, seam 1): the fail-closed EARLY
// read (a malformed assistant block aborts fully inert, before any durable
// mutation), the XOR refusal (declaration ⊕ connector-executor content, AC#2),
// and the PLATFORM-SCOPE refusal (org/team/project target, AC#1). All refusals
// are pre-journal (beginInstallOp never runs) and GC the just-materialized dir.
// Pure DI tests — no registry, no DB, no filesystem.

import { describe, it, expect } from "vitest";

import {
  installExtensionFromRegistry,
  makeTestInstallPipelineDeps,
  type InstallPipelineDeps,
} from "@/lib/extension-install-pipeline";
import { sriForBytes } from "@/lib/extension-package-store-core";
import {
  parseAssistantDeclaration,
  AssistantDeclarationError,
} from "@cinatra-ai/sdk-extensions/assistant-declaration";

const REGISTRY = "https://registry.cinatra.ai";
const PKG = "@cinatra-ai/example-assistant";
const VER = "1.0.0";
const INTEGRITY = sriForBytes(Buffer.from("the-assistant-tarball"));

// A real, valid resolved assistant declaration (built through the shared parser
// so the fixture can never drift from the schema).
const VALID_DECLARATION = parseAssistantDeclaration(
  {
    formatVersion: 1,
    assistant: {
      abiVersion: 1,
      displayName: "Example",
      preferredTag: "example",
      persona: "An example assistant.",
      skillBundle: ["chat-assistant-core"],
      launch: { kind: "local" },
      delivery: { kind: "host-runtime" },
    },
  },
  { packageName: PKG },
)!;

function harness(overrides: Partial<InstallPipelineDeps> = {}) {
  const calls = {
    begun: [] as unknown[],
    gced: [] as string[],
  };
  const deps: InstallPipelineDeps = {
    ...makeTestInstallPipelineDeps(),
    resolveIntegrity: async () => ({ integrity: INTEGRITY, registryUrl: REGISTRY }),
    materialize: async () => ({
      storeDir: "/store/dir",
      digest: "dgst",
      integrity: INTEGRITY,
      contentHash: "ch",
    }),
    readRequestedPorts: async () => [],
    beginInstallOp: async (i) => {
      calls.begun.push(i);
    },
    gcStoreDir: async (dir) => {
      calls.gced.push(dir);
    },
    ...overrides,
  };
  return { deps, calls };
}

describe("install pipeline × assistant pre-finalize gate (cinatra#1874 W1)", () => {
  it("PLATFORM install: a valid assistant declaration at platform scope (orgId null) passes the gate", async () => {
    const { deps, calls } = harness({
      readAssistantInstallSignals: async () => ({
        declaration: VALID_DECLARATION,
        hasConnectorExecutor: false,
      }),
    });
    await installExtensionFromRegistry({ packageName: PKG, version: VER, orgId: null }, deps);
    expect(calls.begun).toHaveLength(1); // reached the journal — the gate allowed it
    expect(calls.gced).toHaveLength(0);
  });

  it("AC#1 PLATFORM-SCOPE: an org-target install is refused pre-journal with a directing error and GCs the dir", async () => {
    const { deps, calls } = harness({
      readAssistantInstallSignals: async () => ({
        declaration: VALID_DECLARATION,
        hasConnectorExecutor: false,
      }),
    });
    await expect(
      installExtensionFromRegistry({ packageName: PKG, version: VER, orgId: "org-123" }, deps),
    ).rejects.toThrow(/only be installed at PLATFORM scope/);
    expect(calls.begun).toHaveLength(0); // refused before beginInstallOp — fully inert
    expect(calls.gced).toEqual(["/store/dir"]);
  });

  it("AC#2 XOR: a package declaring BOTH an assistant block and connector-executor content is refused pre-journal", async () => {
    const { deps, calls } = harness({
      readAssistantInstallSignals: async () => ({
        declaration: VALID_DECLARATION,
        hasConnectorExecutor: true,
      }),
    });
    await expect(
      installExtensionFromRegistry({ packageName: PKG, version: VER, orgId: null }, deps),
    ).rejects.toThrow(/mutually exclusive/);
    expect(calls.begun).toHaveLength(0);
    expect(calls.gced).toEqual(["/store/dir"]);
  });

  it("XOR is checked BEFORE scope: a both-declaring org-target install surfaces the XOR error", async () => {
    const { deps } = harness({
      readAssistantInstallSignals: async () => ({
        declaration: VALID_DECLARATION,
        hasConnectorExecutor: true,
      }),
    });
    await expect(
      installExtensionFromRegistry({ packageName: PKG, version: VER, orgId: "org-123" }, deps),
    ).rejects.toThrow(/mutually exclusive/);
  });

  it("FAIL-CLOSED: a malformed assistant block (reader throws) aborts BEFORE any durable mutation and GCs the dir", async () => {
    const { deps, calls } = harness({
      readAssistantInstallSignals: async () => {
        throw new AssistantDeclarationError(
          `assistant block does not project to a valid assistant_config: persona: required`,
        );
      },
    });
    await expect(
      installExtensionFromRegistry({ packageName: PKG, version: VER, orgId: null }, deps),
    ).rejects.toThrow(/assistant-declaration/);
    expect(calls.begun).toHaveLength(0);
    expect(calls.gced).toEqual(["/store/dir"]);
  });

  it("a non-assistant package (declaration null) never triggers the gate — install proceeds", async () => {
    const { deps, calls } = harness({
      readAssistantInstallSignals: async () => ({ declaration: null, hasConnectorExecutor: false }),
    });
    await installExtensionFromRegistry({ packageName: PKG, version: VER, orgId: "org-123" }, deps);
    expect(calls.begun).toHaveLength(1); // no assistant → org scope is fine
    expect(calls.gced).toHaveLength(0);
  });

  it("no reader wired (older unit tests): the gate is a no-op", async () => {
    const { deps, calls } = harness();
    await installExtensionFromRegistry({ packageName: PKG, version: VER, orgId: "org-9" }, deps);
    expect(calls.begun).toHaveLength(1);
  });
});
