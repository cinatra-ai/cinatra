// cinatra#951 — the HOST config reader over a materialized store dir:
// kind-gating, fail-closed parse of a present cinatra/config.json (through
// the single SDK validator), absence-rule resolution (protected slugs resolve
// FORCED at install, never looser), and malformed-JSON refusal.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("server-only", () => ({}));

import { readConnectorAccessDeclarationFromStore } from "@/lib/connector-access-config-host";

let dir: string;

function writePkg(input: {
  name: string;
  kind?: string;
  config?: unknown | undefined;
  rawConfig?: string;
}): string {
  const manifest: Record<string, unknown> = { name: input.name, version: "1.0.0" };
  if (input.kind) manifest.cinatra = { kind: input.kind, apiVersion: "cinatra.ai/v1" };
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest));
  if (input.config !== undefined || input.rawConfig !== undefined) {
    mkdirSync(join(dir, "cinatra"), { recursive: true });
    writeFileSync(
      join(dir, "cinatra", "config.json"),
      input.rawConfig ?? JSON.stringify(input.config),
    );
  }
  return dir;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "access-config-host-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readConnectorAccessDeclarationFromStore (cinatra#951)", () => {
  it("resolves a declared file through the SDK validator", async () => {
    writePkg({
      name: "@cinatra-ai/github-connector",
      kind: "connector",
      config: { formatVersion: 1, access: { scope: { default: "user" } } },
    });
    await expect(readConnectorAccessDeclarationFromStore(dir)).resolves.toEqual({
      formatVersion: 1,
      mode: "default",
      scope: "user",
      source: "declared",
    });
  });

  it("returns null for non-connector kinds (even with a config file present)", async () => {
    writePkg({
      name: "@cinatra-ai/some-artifact",
      kind: "artifact",
      config: { formatVersion: 1, access: { scope: { default: "user" } } },
    });
    await expect(readConnectorAccessDeclarationFromStore(dir)).resolves.toBeNull();
  });

  it("absent file REFUSES at install for a non-protected slug (cinatra#955 — the W1 leniency is deleted)", async () => {
    writePkg({ name: "@cinatra-ai/github-connector", kind: "connector" });
    await expect(readConnectorAccessDeclarationFromStore(dir)).rejects.toThrow(
      /absence is not accepted at install/,
    );
  });

  it("absent file on a PROTECTED slug REFUSES at install, naming the forced declaration", async () => {
    writePkg({ name: "@cinatra-ai/openai-connector", kind: "connector" });
    await expect(readConnectorAccessDeclarationFromStore(dir)).rejects.toThrow(
      /protected slug "openai"/,
    );
  });

  it("FAIL-CLOSED: the misspelled nested key throws (never a silent default)", async () => {
    writePkg({
      name: "@cinatra-ai/github-connector",
      kind: "connector",
      config: { formatVersion: 1, access: { scpoe: { default: "user" } } },
    });
    await expect(readConnectorAccessDeclarationFromStore(dir)).rejects.toThrow(
      /connector-access-config/,
    );
  });

  it("FAIL-CLOSED: a protected slug declaring anything but only:admin throws", async () => {
    writePkg({
      name: "@cinatra-ai/anthropic-connector",
      kind: "connector",
      config: { formatVersion: 1, access: { scope: { default: "admin" } } },
    });
    await expect(readConnectorAccessDeclarationFromStore(dir)).rejects.toThrow(/protected slug/);
  });

  it("FAIL-CLOSED: malformed JSON in a PRESENT file throws (never the absence rule)", async () => {
    writePkg({
      name: "@cinatra-ai/github-connector",
      kind: "connector",
      rawConfig: "{ not json",
    });
    await expect(readConnectorAccessDeclarationFromStore(dir)).rejects.toThrow(/not valid JSON/);
  });

  it("returns null when there is no package.json (the materializer owns that failure)", async () => {
    await expect(readConnectorAccessDeclarationFromStore(dir)).resolves.toBeNull();
  });
});
