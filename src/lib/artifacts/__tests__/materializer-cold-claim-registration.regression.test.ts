/**
 * Regression: the run-completion materializer's registry-warm seam must register
 * host CLAIM object types (@cinatra-ai/email:body) in a COLD process — one that
 * never imported `@/lib/mcp-server` (the production worker / run-completion
 * path) — so `resolveBoundArtifactTarget` does NOT fail closed with
 * `declares: [none]` and drop every claim-typed artifact (cinatra#1866).
 *
 * Before the fix, `@cinatra-ai/email:body` was registered ONLY as a
 * module-top-level side effect of importing `@/lib/mcp-server`
 * (createObjectsModule() → objects-package registerAllObjectTypes). The
 * materializer self-calls the HOST `registerAllObjectTypes`
 * (src/lib/register-all-object-types.ts) which registered only host BASE types,
 * so a cold process had `email:body` unregistered and
 * `readEffectiveArtifactSafeTypeIdsForExtension` intersected the winning claim
 * with an empty registry → `[]` → zero materializations.
 *
 * This test drives the REAL host registry-warm seam (`registerAllObjectTypes`
 * exactly as the materializer's L387/L615 call sites and
 * `ensureArtifactTypesRegistered` invoke it) against the REAL objectTypeRegistry
 * singleton, and the REAL intersection seam
 * (`readEffectiveArtifactSafeTypeIdsForExtension`). It NEVER imports
 * `@/lib/mcp-server`; a tripwire mock throws if any code path pulls that barrel.
 * Only the heavy host-side leaf registrars (extension registrars / blog /
 * agent-builder / the FS-scanning artifact-extension bridge) and the DB claim
 * store are stubbed — the objects-package claim registration and the registry
 * run FOR REAL.
 *
 *   npx vitest run src/lib/artifacts/__tests__/materializer-cold-claim-registration.regression.test.ts
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Tripwire: the cold path must NOT drag in the MCP server barrel. If any module
// under test transitively imports it, this factory throws and the suite fails —
// proving the registration is an invariant of the host warm, not of the MCP
// HTTP surface having been imported first.
vi.mock("@/lib/mcp-server", () => {
  throw new Error(
    "cinatra#1866: cold registration path must not import @/lib/mcp-server",
  );
});

// Heavy host-side leaf registrars — stubbed to no-ops so the host
// `registerAllObjectTypes` is drivable in a unit process WITHOUT the filesystem
// extension scan / blog / agents deps. The objects-package claim registrar and
// the shared objectTypeRegistry singleton are deliberately NOT mocked.
vi.mock("@/lib/extension-object-type-registrars", () => ({
  runExtensionObjectTypeRegistrars: vi.fn(),
}));
vi.mock("@/lib/blog-project-store", () => ({
  registerBlogObjectTypes: vi.fn(),
}));
vi.mock("@cinatra-ai/agents/integration/register-object-types", () => ({
  registerAgentBuilderObjectTypes: vi.fn(),
}));
vi.mock("@cinatra-ai/objects/register-artifact-extensions", () => ({
  registerArtifactExtensions: vi.fn(),
}));

// The org-chain DB claim registry (winner arbitration reads these rows).
const { readClaimsMock } = vi.hoisted(() => ({ readClaimsMock: vi.fn() }));
vi.mock("@/lib/objects/artifact-claim-store", () => ({
  readArtifactTypeClaimsForOrg: readClaimsMock,
}));

import { objectTypeRegistry } from "@cinatra-ai/objects/registry";
import { registerAllObjectTypes } from "@/lib/register-all-object-types";
import { ensureArtifactTypesRegistered } from "../ensure-artifact-registry";
import { readEffectiveArtifactSafeTypeIdsForExtension } from "../resolve-bound-artifact-type";

const EMAIL_EXT = "@cinatra-ai/email-artifacts";
const EMAIL_BODY = "@cinatra-ai/email:body";

// The email-artifacts pack's real winning claim over its artifact-safe body
// type, as the org-chain claim store returns it.
function emailBodyClaim() {
  return [
    {
      id: "c1",
      scope: "platform",
      claimKind: "dedicated" as const,
      status: "active" as const,
      extensionPackage: EMAIL_EXT,
      extensionVersion: "0.1.0",
      generation: 1,
      installId: "inst-1",
      objectTypeId: EMAIL_BODY,
      dispositions: { projection: "artifact-safe" },
    },
  ];
}

describe("cold-process claim-type registration (cinatra#1866)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Force a genuinely COLD registry — as if this were a freshly booted worker
    // process that has served zero MCP requests.
    objectTypeRegistry._clearForTests();
    readClaimsMock.mockReturnValue(emailBodyClaim());
  });

  it("has email:body UNREGISTERED before any warm (cold baseline)", () => {
    expect(objectTypeRegistry.resolve(EMAIL_BODY)).toBeNull();
  });

  it("registers email:body via the host warm the materializer calls (no MCP import)", () => {
    // Exactly the call the materializer makes at L387/L615 before
    // resolveBoundArtifactTarget.
    registerAllObjectTypes();
    expect(objectTypeRegistry.resolve(EMAIL_BODY)).not.toBeNull();
  });

  it("registers email:body via the shared ensureArtifactTypesRegistered seam", () => {
    ensureArtifactTypesRegistered();
    expect(objectTypeRegistry.resolve(EMAIL_BODY)).not.toBeNull();
  });

  it("resolves the bound claim type instead of failing closed (declares: [none])", () => {
    // Cold registry: the intersection is empty → the exact #1866 fail-closed.
    expect(
      readEffectiveArtifactSafeTypeIdsForExtension("org-a", EMAIL_EXT),
    ).toEqual([]);

    // After the host warm the materializer performs, the winning claim
    // intersects a REGISTERED host type → email:body is declared, not [none].
    registerAllObjectTypes();
    expect(
      readEffectiveArtifactSafeTypeIdsForExtension("org-a", EMAIL_EXT),
    ).toEqual([EMAIL_BODY]);
  });
});
