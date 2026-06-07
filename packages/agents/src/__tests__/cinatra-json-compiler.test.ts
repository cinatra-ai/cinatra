/**
 * Sibling cinatra.json reader.
 *
 * Tests readSiblingCinatraJson directly with a tmp fixture (avoids the full
 * compileOasAgentJson DB-touching path). The compile-time integration of
 * cinatraConfig into CompiledAgentOas.cinatraConfig is exercised in the
 * trigger-infer-side-effects.test.ts shape test and at runtime when
 * email-outreach reads the limit.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { readSiblingCinatraJson } from "../oas-compiler";

let tmpDir: string;

function setupAgent(layout: "cinatra" | "flat", configContent: string | null): string {
  const agentDir = fs.mkdtempSync(path.join(tmpDir, "agent-"));
  if (layout === "cinatra") {
    const cinatraSubdir = path.join(agentDir, "cinatra");
    fs.mkdirSync(cinatraSubdir);
    fs.writeFileSync(path.join(cinatraSubdir, "oas.json"), "{}");
    if (configContent !== null) {
      fs.writeFileSync(path.join(agentDir, "cinatra.json"), configContent);
    }
    return path.join(cinatraSubdir, "oas.json");
  } else {
    fs.writeFileSync(path.join(agentDir, "agent.json"), "{}");
    if (configContent !== null) {
      fs.writeFileSync(path.join(agentDir, "cinatra.json"), configContent);
    }
    return path.join(agentDir, "agent.json");
  }
}

describe("readSiblingCinatraJson", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cinatra-json-test-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads cinatra/ layout sibling cinatra.json", async () => {
    const agentJsonPath = setupAgent(
      "cinatra",
      JSON.stringify({
        limits: { maxRecipients: 200 },
        requiredConnections: [{ type: "email", preferred: "gmail" }],
        defaults: { senderName: null },
      }),
    );
    const cfg = await readSiblingCinatraJson(agentJsonPath);
    expect(cfg).toEqual({
      limits: { maxRecipients: 200 },
      requiredConnections: [{ type: "email", preferred: "gmail" }],
      defaults: { senderName: null },
    });
  });

  it("reads flat layout sibling cinatra.json", async () => {
    const agentJsonPath = setupAgent(
      "flat",
      JSON.stringify({ limits: { maxRecipients: 50 } }),
    );
    const cfg = await readSiblingCinatraJson(agentJsonPath);
    expect(cfg?.limits?.maxRecipients).toBe(50);
  });

  it("returns null when no sibling cinatra.json present", async () => {
    const agentJsonPath = setupAgent("cinatra", null);
    const cfg = await readSiblingCinatraJson(agentJsonPath);
    expect(cfg).toBeNull();
  });

  it("rejects non-positive maxRecipients", async () => {
    const agentJsonPath = setupAgent(
      "cinatra",
      JSON.stringify({ limits: { maxRecipients: 0 } }),
    );
    const cfg = await readSiblingCinatraJson(agentJsonPath);
    expect(cfg?.limits).toBeUndefined();
  });

  it("filters malformed requiredConnections entries", async () => {
    const agentJsonPath = setupAgent(
      "cinatra",
      JSON.stringify({
        requiredConnections: [
          { type: "email", preferred: "gmail" },
          { foo: "bar" }, // malformed — missing type
          null, // malformed — null entry
        ],
      }),
    );
    const cfg = await readSiblingCinatraJson(agentJsonPath);
    expect(cfg?.requiredConnections).toEqual([{ type: "email", preferred: "gmail" }]);
  });

  // NOTE: `cinatra.json` is a legacy sibling-config format. No extension ships
  // a cinatra.json anymore, so pinning a real on-disk file is obsolete. The
  // synthetic-fixture cases above still exercise the readSiblingCinatraJson
  // parser itself.
});
