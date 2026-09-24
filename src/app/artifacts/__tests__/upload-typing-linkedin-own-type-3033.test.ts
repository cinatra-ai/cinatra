/**
 * cinatra#3033 (CELL4, the confirmation) — confirming the picker's LinkedIn
 * post-draft entry on a markdown upload writes the person's own meaning
 * assertion and hands the promotion road the owned type
 * `@cinatra-ai/linkedin:post-draft` with no matcher threshold, so the upload is
 * retyped into the LinkedIn post-draft type.
 *
 * The pack's ONLY road to its type is a cross-namespace claim: the host
 * registers the type without provenance and the pinned
 * `@cinatra-ai/linkedin-artifacts` manifest claims it. The pack declares no
 * matcher. Built on the harness of `upload-typing-actions.test.ts` (its mocks
 * copied here, never imported across files); the registries are the real
 * singletons, set up per case and cleared after it.
 */
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { matcherManifestRegistry, objectTypeRegistry } from "@cinatra-ai/objects/registry";
import { semanticRendererRegistry } from "@cinatra-ai/objects/artifact-renderer-registry";
import { registerAllObjectTypes as registerObjectsPackageObjectTypes } from "@cinatra-ai/objects/register-object-types";
import {
  registerArtifactExtensionDir,
  registerParsedArtifactManifest,
} from "@cinatra-ai/objects/register-artifact-extensions";
import type { SemanticArtifactManifest } from "@cinatra-ai/objects";

/** Reconcile a pack away: a re-registration that declares nothing drops every
 *  bridge registration the pack held, its cross-namespace claims included. */
function reconcileAway(packageName: string): void {
  registerParsedArtifactManifest({} as SemanticArtifactManifest, packageName);
}

const getAuthSession = vi.fn();
const getActorContext = vi.fn();
const isPlatformAdmin = vi.fn();
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: (...a: unknown[]) => getAuthSession(...a),
  getActorContext: (...a: unknown[]) => getActorContext(...a),
  isPlatformAdmin: (...a: unknown[]) => isPlatformAdmin(...a),
}));

const listInstalledMeaningTypesAcceptingMime = vi.fn();
vi.mock("@/lib/artifacts/installed-type-picker", () => ({
  listInstalledMeaningTypesAcceptingMime: (...a: unknown[]) =>
    listInstalledMeaningTypesAcceptingMime(...a),
}));

const resolveActiveInstallForActor = vi.fn();
vi.mock("@/lib/extension-install-resolution", () => ({
  resolveActiveInstallForActor: (...a: unknown[]) => resolveActiveInstallForActor(...a),
}));

const assertSemanticType = vi.fn();
vi.mock("@/lib/artifacts/semantic-assertion-store", () => ({
  assertSemanticType: (...a: unknown[]) => assertSemanticType(...a),
}));

const readArtifactForDetail = vi.fn();
const readArtifactForMeaningWrite = vi.fn();
vi.mock("@/lib/artifacts/artifact-service", () => ({
  readArtifactForDetail: (...a: unknown[]) => readArtifactForDetail(...a),
  readArtifactForMeaningWrite: (...a: unknown[]) => readArtifactForMeaningWrite(...a),
}));

const resolveRecipientToUserIds = vi.fn();
vi.mock("@cinatra-ai/notifications/server", () => ({
  resolveRecipientToUserIds: (...a: unknown[]) => resolveRecipientToUserIds(...a),
}));

const createNotificationForRecipient = vi.fn();
vi.mock("@/lib/notifications", () => ({
  createNotificationForRecipient: (...a: unknown[]) => createNotificationForRecipient(...a),
}));

const loadMarketplaceBrowse = vi.fn();
vi.mock("@/lib/marketplace-browse", () => ({
  loadMarketplaceBrowse: (...a: unknown[]) => loadMarketplaceBrowse(...a),
}));

const isSystemExtension = vi.fn();
vi.mock("@cinatra-ai/extensions/system-extension-inventory", () => ({
  isSystemExtension: (...a: unknown[]) => isSystemExtension(...a),
}));
const isArtifactExtensionWriteAllowed = vi.fn();
vi.mock("@/lib/artifacts/artifact-extension-access", () => ({
  isArtifactExtensionWriteAllowed: (...a: unknown[]) =>
    isArtifactExtensionWriteAllowed(...a),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const promoteMatchedArtifactType = vi.fn();
vi.mock("@/lib/artifacts/typed-promotion-store", () => ({
  promoteMatchedArtifactType: (...a: unknown[]) => promoteMatchedArtifactType(...a),
}));
const verifySessionAuthority = vi.fn();
vi.mock("@/lib/org-write/authority", () => ({
  verifySessionAuthority: (...a: unknown[]) => verifySessionAuthority(...a),
}));

// The registry warm is this case's own setup (below), so the action's warm is a
// no-op here: the registries hold exactly what each case registered.
vi.mock("@/lib/artifacts/ensure-artifact-registry", () => ({
  ensureArtifactTypesRegistered: vi.fn(),
  ensureArtifactTypesRegisteredWithStore: vi.fn(async () => undefined),
}));

const MOCKED_MODULES = [
  "@/lib/auth-session",
  "@/lib/artifacts/installed-type-picker",
  "@/lib/extension-install-resolution",
  "@/lib/artifacts/semantic-assertion-store",
  "@/lib/artifacts/artifact-service",
  "@cinatra-ai/notifications/server",
  "@/lib/notifications",
  "@/lib/marketplace-browse",
  "@cinatra-ai/extensions/system-extension-inventory",
  "@/lib/artifacts/artifact-extension-access",
  "next/cache",
  "@/lib/artifacts/typed-promotion-store",
  "@/lib/org-write/authority",
  "@/lib/artifacts/ensure-artifact-registry",
];

const ACTOR = { principalId: "u1", organizationId: "org-1" };
const PACK = "@cinatra-ai/linkedin-artifacts";
const LINKEDIN_TYPE = "@cinatra-ai/linkedin:post-draft";
const MARKDOWN_BASE = "@cinatra-ai/markdown-artifact:artifact";
const PINNED_LINKEDIN_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "extensions",
  "cinatra-ai",
  "linkedin-artifacts",
);

function clearRegistries(): void {
  reconcileAway(PACK);
  objectTypeRegistry._clearForTests();
  matcherManifestRegistry._clearForTests();
  semanticRendererRegistry._clearForTests();
}

describe("assertUploadMeaning — the LinkedIn post draft retypes a markdown upload into its own type (cinatra#3033)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAuthSession.mockResolvedValue({
      user: { id: "u1", name: "Dana", email: "dana@x.io" },
      session: { activeOrganizationId: "org-1" },
    });
    getActorContext.mockResolvedValue(ACTOR);

    clearRegistries();
    // The host-registered LinkedIn type, then the pinned pack's claim over it.
    registerObjectsPackageObjectTypes();
    registerArtifactExtensionDir(PINNED_LINKEDIN_DIR);
    // THE POINT OF THE CASE: the pack is in NO matcher channel.
    matcherManifestRegistry._clearForTests();

    readArtifactForMeaningWrite.mockReturnValue({
      kind: "ok",
      artifact: { mime: "text/markdown", objectType: MARKDOWN_BASE },
    });
    listInstalledMeaningTypesAcceptingMime.mockReturnValue([
      {
        objectTypeId: LINKEDIN_TYPE,
        extension: PACK,
        displayName: "Post Draft",
        extensionLabel: "LinkedIn",
      },
    ]);
    isSystemExtension.mockReturnValue(false);
    resolveActiveInstallForActor.mockResolvedValue({
      id: "inst-li",
      isDefault: true,
      version: "0.1.0",
    });
    assertSemanticType.mockReturnValue({ blockedByPrecedence: false });
    verifySessionAuthority.mockResolvedValue({ kind: "org-write" });
    promoteMatchedArtifactType.mockResolvedValue({
      ok: true,
      representationRevisionId: "rep_li",
      revision: 2,
      toType: LINKEDIN_TYPE,
      retyped: true,
    });
  });
  afterEach(() => {
    clearRegistries();
    vi.resetModules();
  });
  // The file restores what it mocked, so the package's full run stays clean.
  afterAll(() => {
    for (const m of MOCKED_MODULES) vi.doUnmock(m);
    vi.resetModules();
  });

  it("hands the promotion road the owned LinkedIn type with no threshold, after the person's own assertion", async () => {
    const { assertUploadMeaning } = await import("../upload-typing-actions");
    const res = await assertUploadMeaning({ artifactId: "a1", extension: PACK });

    // The person's own meaning is written first — the promotion rides it.
    expect(assertSemanticType).toHaveBeenCalledWith(
      expect.objectContaining({ artifactId: "a1", extension: PACK, assertedBy: "user" }),
    );
    expect(promoteMatchedArtifactType).toHaveBeenCalledTimes(1);
    expect(promoteMatchedArtifactType).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactId: "a1",
        extension: PACK,
        ownType: expect.objectContaining({ typeId: LINKEDIN_TYPE }),
        threshold: null,
        confirmed: true,
        principal: "u1",
      }),
    );
    expect(
      assertSemanticType.mock.invocationCallOrder[0]!,
    ).toBeLessThan(promoteMatchedArtifactType.mock.invocationCallOrder[0]!);
    expect(res).toEqual({
      ok: true,
      promotion: {
        promoted: true,
        toType: LINKEDIN_TYPE,
        representationRevisionId: "rep_li",
        revision: 2,
      },
    });
  });

  it("completes an interrupted promotion on re-confirmation of a row already carrying the claimed LinkedIn type", async () => {
    // The row an earlier confirmation retyped: its CURRENT type is the claimed
    // LinkedIn type, so the picker's list (which excludes the current type's
    // extension) offers no LinkedIn entry and the converging branch decides.
    readArtifactForMeaningWrite.mockReturnValue({
      kind: "ok",
      artifact: { mime: "text/markdown", objectType: LINKEDIN_TYPE },
    });
    listInstalledMeaningTypesAcceptingMime.mockReturnValue([]);

    const { assertUploadMeaning } = await import("../upload-typing-actions");
    const res = await assertUploadMeaning({ artifactId: "a1", extension: PACK });

    // No second assertion is stacked; the road runs for the claimed own type.
    expect(assertSemanticType).not.toHaveBeenCalled();
    expect(promoteMatchedArtifactType).toHaveBeenCalledTimes(1);
    expect(promoteMatchedArtifactType).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactId: "a1",
        extension: PACK,
        ownType: expect.objectContaining({ typeId: LINKEDIN_TYPE }),
        threshold: null,
      }),
    );
    expect(res).toEqual({
      ok: true,
      promotion: {
        promoted: true,
        toType: LINKEDIN_TYPE,
        representationRevisionId: "rep_li",
        revision: 2,
      },
    });
  });
});
