/**
 * cinatra#3319 — `readArtifactSafeClaimWinnerForType`: the pack whose WINNING
 * artifact-safe claim is over one type in this organization.
 *
 * The upload picker and its confirmation ask it which pack owns a claim-backed
 * row type (the host registers such a type, so the object-type registry names
 * no pack for it). It runs the same arbitration as the write and read sides of
 * the artifact boundary. No database: the claims are handed in.
 *
 *   pnpm exec vitest run src/lib/artifacts/__tests__/resolve-bound-artifact-type-claim-winner-3319.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";
import type { ArbitrableClaim } from "@cinatra-ai/objects/claims";

vi.mock("@/lib/objects/artifact-claim-store", () => ({
  readArtifactTypeClaimsForOrg: () => {
    throw new Error("the claim store is not read in this suite");
  },
}));
vi.mock("@/lib/register-all-object-types", () => ({ registerAllObjectTypes: () => {} }));

const ORG = "org-3319-winner";
const T_HOST = "@cinatra-ai/hostns:memo";
const T_CONTESTED = "@cinatra-ai/hostns:contested";
const T_NOWHERE = "@cinatra-ai/nowhere:thing";
const EXT = "@cinatra-ai/hostns-artifacts";
const EXT_PLATFORM = "@cinatra-ai/hostns-platform-artifacts";

function claim(input: {
  id: string;
  type: string;
  ext: string;
  projection?: "artifact-safe" | "none";
  scope?: "platform";
}): ArbitrableClaim {
  return {
    id: input.id,
    scope: input.scope === "platform" ? "platform" : `org:${ORG}`,
    objectTypeId: input.type,
    claimKind: "dedicated",
    status: "active",
    extensionPackage: input.ext,
    extensionVersion: "1.0.0",
    generation: 1,
    dispositions:
      input.projection === "none"
        ? { projection: "none", pinnable: false, snapshotPolicy: "none" }
        : { projection: "artifact-safe", pinnable: true, snapshotPolicy: "content" },
  };
}

function registerHostShaped(type: string) {
  objectTypeRegistry.register({
    type,
    category: "report",
    schema: z.record(z.string(), z.unknown()),
    lifecycle: { sources: ["agent"], mutableBy: ["agent"] },
    renderers: { listRow: null, card: null, detail: null },
    dispositions: { projection: "artifact-safe" },
  } as never);
}

let mod: typeof import("@/lib/artifacts/resolve-bound-artifact-type");

beforeAll(async () => {
  mod = await import("@/lib/artifacts/resolve-bound-artifact-type");
  objectTypeRegistry._clearForTests();
  registerHostShaped(T_HOST);
  registerHostShaped(T_CONTESTED);
  // T_NOWHERE is registered nowhere.
});
afterAll(() => {
  objectTypeRegistry._clearForTests();
  vi.resetModules();
});

describe("cinatra#3319 — the claim winner of one type", () => {
  it("C2e-1: names the pack whose artifact-safe claim wins a registered host type", () => {
    const claims = [claim({ id: "c1", type: T_HOST, ext: EXT })];
    expect(mod.readArtifactSafeClaimWinnerForType(ORG, T_HOST, () => claims)).toBe(EXT);
  });

  it("C2e-2: answers null for a type no claim is over", () => {
    const claims = [claim({ id: "c1", type: T_CONTESTED, ext: EXT })];
    expect(mod.readArtifactSafeClaimWinnerForType(ORG, T_HOST, () => claims)).toBeNull();
  });

  it("C2e-3: answers null when the WINNER projects nothing, even though a losing claim is artifact-safe", () => {
    const claims = [
      claim({ id: "c-platform", type: T_CONTESTED, ext: EXT_PLATFORM, scope: "platform" }),
      claim({ id: "c-org", type: T_CONTESTED, ext: EXT, projection: "none" }),
    ];
    expect(mod.readArtifactSafeClaimWinnerForType(ORG, T_CONTESTED, () => claims)).toBeNull();
  });

  it("C2e-4: answers null for a claim over a type this process never registered", () => {
    const claims = [claim({ id: "c1", type: T_NOWHERE, ext: EXT })];
    expect(mod.readArtifactSafeClaimWinnerForType(ORG, T_NOWHERE, () => claims)).toBeNull();
  });

  it("C2e-5: a failed claim read throws, so no caller reads it as 'no claimant'", () => {
    expect(() => mod.readArtifactSafeClaimWinnerForType(ORG, T_HOST)).toThrow(
      "the claim store is not read in this suite",
    );
  });
});
