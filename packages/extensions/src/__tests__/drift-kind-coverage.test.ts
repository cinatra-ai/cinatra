// Kind-coverage invariant.
//
// CI fails when any kind in {agent, connector, artifact, skill, workflow}
// is missing from the surfaces below. New kinds added in the future must
// be wired into ALL of these places before this test suite passes.
import { describe, expect, it } from "vitest";

import { EXTENSION_KINDS } from "../canonical-types";
import { deriveTypeId } from "../utils";

const REQUIRED_KINDS = [...EXTENSION_KINDS] as const;

describe("kind-coverage invariants", () => {
  it("every kind resolves a typeId via deriveTypeId", () => {
    for (const kind of REQUIRED_KINDS) {
      expect(() => deriveTypeId(kind)).not.toThrow();
      expect(deriveTypeId(kind)).toBe(kind);
    }
  });

  it("handler-bootstrap imports a handler factory for every kind", async () => {
    // Read the bootstrap source synchronously so the gate doesn't depend on
    // a live DB / server-only context. The presence of the import is the
    // contract — handlers register themselves at module load.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const bootstrapPath = path.resolve(
      __dirname,
      "..",
      "handler-bootstrap.ts",
    );
    const src = fs.readFileSync(bootstrapPath, "utf8");

    const expected: Record<string, string> = {
      agent: "createAgentExtensionHandler",
      skill: "createSkillExtensionHandler",
      connector: "createConnectorExtensionHandler",
      artifact: "createArtifactExtensionHandler",
      workflow: "createWorkflowExtensionHandler",
    };
    for (const kind of REQUIRED_KINDS) {
      const factory = expected[kind];
      expect(
        src,
        `handler-bootstrap.ts must register ${factory} for kind '${kind}'`,
      ).toContain(factory);
    }
  });

  it("the canonical kind set is the single source of truth", () => {
    // Anyone adding a new kind must also extend EXTENSION_KINDS in
    // canonical-types.ts. This assertion exists to make the contract loud.
    expect(EXTENSION_KINDS).toEqual(["agent", "connector", "artifact", "skill", "workflow"]);
  });

  // Kind coverage extends to registry parser, package validator, MCP
  // metadata, marketplace, and purge.
  it("every kind is recognised by the Verdaccio packument parser", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "..", "..", "..", "registries", "src", "verdaccio", "client.ts"),
      "utf8",
    );
    for (const kind of REQUIRED_KINDS) {
      expect(
        src,
        `packages/registries/src/verdaccio/client.ts must recognise kind='${kind}'`,
      ).toContain(`kindRaw === "${kind}"`);
    }
  });

  it("naming-conformance test covers every kind", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "naming-conformance.test.ts"),
      "utf8",
    );
    for (const kind of REQUIRED_KINDS) {
      expect(
        src,
        `naming-conformance.test.ts must cover kind='${kind}'`,
      ).toContain(`"${kind}"`);
    }
  });

  it("marketplace UI covers every kind", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "..", "screens", "extensions-marketplace-client.tsx"),
      "utf8",
    );
    for (const kind of REQUIRED_KINDS) {
      expect(
        src,
        `extensions-marketplace-client.tsx must reference kind='${kind}'`,
      ).toContain(kind);
    }
  });

  it("purge resolves every kind via the canonical dispatcher (no kind drops to default)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "..", "purge.ts"),
      "utf8",
    );
    // Purge resolves typeId through deriveTypeId and refuses an unknown kind.
    // The presence of every kind name in purge.ts is the trail of "we
    // thought about this kind explicitly," not just letting it fall through.
    for (const kind of REQUIRED_KINDS) {
      expect(src, `purge.ts must reference kind='${kind}'`).toContain(`"${kind}"`);
    }
  });
});
