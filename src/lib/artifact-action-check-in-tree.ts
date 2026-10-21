import "server-only";

import type { ArtifactActionCheckProvider, ArtifactActionIdentity } from "@cinatra-ai/sdk-extensions";
import { ARTIFACT_ACTION_CHECK_CAPABILITY } from "@cinatra-ai/sdk-extensions/internal";
import { readDeclaredDelegatedChatClass } from "@cinatra-ai/mcp-server/delegated-chat-tool-policy";
import { readDeclaredOutward } from "@cinatra-ai/mcp-server/capability-plan";
import {
  bindLoadedCapabilityProvider,
  isLoadedExtensionIdentityCurrent,
  type LoadedExtensionIdentity,
} from "@/lib/extension-capabilities-registry";

// cinatra#3745: the host's in-tree `artifact-action-check/v1` provider.
//
// On an agent run every guarded leaf needs exactly one CHECK provider for the
// loaded identity that executes. An extension that ships none would leave every
// tool it registers unavailable to runs, read-only tools included. This provider
// answers for exactly one class of call and refuses everything else:
//
//   - the tool's install is digest-pinned: the guarded leaf was bound with a
//     loaded identity the host's loader stamped from a verified install id and
//     digest, and that identity is still the current one;
//   - the registration that this identity bound declares the read class
//     (`delegatedChat: "read"`), declares nothing outward, and carries no
//     annotation that contradicts a read (`readOnlyHint: false`,
//     `destructiveHint: true`).
//
// The declaration is read once, at binding, from the digest-pinned package's
// own registration; it is never read from the call. Its CHECK covers no
// outward action, so a call that reaches the person gate through it refuses.
// A legacy or dev load without an install id or digest has no loaded identity:
// its leaf refuses before any provider is resolved. An extension's own provider
// always decides for its identity; with two providers the call stays ambiguous.

type BoundReading = "read-only" | "other" | "conflict";
const READINGS_KEY = Symbol.for("@cinatra-ai/host:in-tree-action-check-readings/v1");
const readingsHolder = globalThis as unknown as { [READINGS_KEY]?: Map<string, BoundReading> };
const readings = (readingsHolder[READINGS_KEY] ??= new Map<string, BoundReading>());

function readingKey(identity: LoadedExtensionIdentity, toolName: string): string {
  return JSON.stringify([identity.packageName, identity.version, identity.installId, identity.digest,
    identity.generation, toolName]);
}

function digestPinned(identity: unknown): identity is LoadedExtensionIdentity {
  if (!identity || typeof identity !== "object") return false;
  const v = identity as Partial<LoadedExtensionIdentity>;
  return typeof v.installId === "string" && v.installId.length > 0 &&
    typeof v.digest === "string" && v.digest.length > 0 &&
    typeof v.generation === "number" && isLoadedExtensionIdentityCurrent(v as LoadedExtensionIdentity);
}

/** Whether one registration declares the read class and nothing that contradicts it. */
function registrationDeclaresReadOnly(registration: unknown): boolean {
  if (typeof registration !== "object" || registration === null) return false;
  if (readDeclaredOutward(registration) !== null) return false;
  if (readDeclaredDelegatedChatClass(registration) !== "read") return false;
  try {
    const annotations: unknown = (registration as { annotations?: unknown }).annotations;
    if (annotations === undefined || annotations === null) return true;
    if (typeof annotations !== "object") return false;
    const a = annotations as { readOnlyHint?: unknown; destructiveHint?: unknown };
    return a.readOnlyHint !== false && a.destructiveHint !== true;
  } catch {
    return false;
  }
}

/** Host only: the guarded leaf's binding records its registration's reading once.
 * A second binding of the same identity and tool with another reading admits nothing. */
export function recordBoundToolDeclaration(identity: LoadedExtensionIdentity | undefined,
  toolName: string, registration: unknown): void {
  if (!digestPinned(identity) || typeof toolName !== "string" || toolName.length === 0) return;
  const key = readingKey(identity, toolName);
  const reading: BoundReading = registrationDeclaresReadOnly(registration) ? "read-only" : "other";
  const prior = readings.get(key);
  readings.set(key, prior === undefined || prior === reading ? reading : "conflict");
}

/** The in-tree provider answers only for a digest-pinned primitive whose bound registration reads read-only. */
export function inTreeActionCheckAdmits(action: ArtifactActionIdentity): boolean {
  if (!action || action.wrapper !== "primitive" || !digestPinned(action)) return false;
  return readings.get(readingKey(action, action.toolName)) === "read-only";
}

const inTreeProvider: ArtifactActionCheckProvider = {
  classify: ({ action }) => ({ kind: inTreeActionCheckAdmits(action) ? "read-only" : "outward" }),
  check: () => ({ kind: "refused", reason: "in_tree_check_covers_no_outward_action" }),
};

const CHECKER_KEY = Symbol.for("@cinatra-ai/host:in-tree-action-checker/v1");
const checkerHolder = globalThis as unknown as { [CHECKER_KEY]?: ArtifactActionCheckProvider };
/** The one in-tree provider, bound on first use exactly as the capability registry binds an
 * `artifact-action-check/v1` provider (its methods validated, its namespace frozen). */
export function inTreeArtifactActionChecker(): ArtifactActionCheckProvider {
  return (checkerHolder[CHECKER_KEY] ??= bindLoadedCapabilityProvider(
    { packageName: "@cinatra-ai/host", impl: inTreeProvider }, undefined, ARTIFACT_ACTION_CHECK_CAPABILITY,
  ).impl as ArtifactActionCheckProvider);
}
