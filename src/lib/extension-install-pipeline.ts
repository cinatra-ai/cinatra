import "server-only";

// The live install pipeline core (what the runtime loader's trusted
// anchor reads back). Given a registry coordinate it: resolves the tarball
// integrity → materializes the verified package into the on-disk store →
// records the REAL integrity + content hash on the canonical install row →
// records the requested host-port grant → AUTO-APPROVES the grant ONLY for a
// `trusted-signed` package (the capability split); everything else (incl.
// `trusted-bootstrap`) stays pending for an admin to approve.
//
// Dependency-injected so the orchestration is unit-testable without a registry
// or a DB; `makeDefaultInstallPipelineDeps` wires the real materializer +
// canonical store + grant store.

import type { ExtensionDependency } from "@cinatra-ai/extensions/canonical-types";

import { capturePriorOwnershipGrants, recordAndAutoApproveOwnershipGrants, unwindOwnershipGrants } from "@/lib/extension-capability-ownership-grants";
import { classifyExtensionTrust, UntrustedInstallRefusedError } from "@/lib/extension-trust";
import {
  readAccessDeclarationInertly,
  persistAccessDeclarationAtFinalize,
  restorePriorAccessDeclaration,
} from "@/lib/connector-access-config-host";
import {
  persistWidgetAuthTokenKeysAtFinalize,
  restorePriorWidgetAuthTokenKeys,
} from "@/lib/extension-install-canonical-row-deps";
import {
  enforceAssistantInstallGateInertly,
} from "@/lib/assistant-declaration-host";
import {
  enforceSkillPackagingGateInertly,
} from "@/lib/skill-packaging-install-gate";
import { resolveSignatureVerdict } from "@/lib/extension-signature";
import {
  computeClosureHash,
  parseMaterializationPlan,
  type MaterializationPlan,
} from "@/lib/extension-materialization-plan-core";
import { computeRequestedPortsHash } from "@/lib/extension-host-port-grants";
// cinatra#3204 D1/D2 — the supplied road: the leaf provenance grammar and the
// store SRI helper (a supplied SRI is COMPUTED over the delivered bytes).
import { isSuppliedPackageProvenance, type SuppliedPackageProvenance } from "@cinatra-ai/extension-types";
import { sriForBytes, METADATA_ONLY_STORE_KINDS } from "@/lib/extension-package-store-core";
import {
  trustedActivationHosts,
  allowMarketplaceBootstrapTrust,
} from "@/lib/extension-trust-config";
import {
  evaluateHostSdkCompat,
  formatHostSdkCompatRefusal,
} from "@/lib/extension-host-compat";

// cinatra#3204 — the type surface lives in a TYPE-ONLY sibling module (see
// its header). Both statements below are erased at build time, so every
// caller's import path is unchanged and no route graph moves.
import type {
  InstallPipelineInput,
  InstallPipelineDeps,
  InstallDurableRestoreFailureEvent,
  InstallPipelineResult,
} from "@/lib/extension-install-pipeline-types";
export type {
  InstallPipelineInput,
  InstallPipelineDeps,
  InstallDurableRestoreFailureEvent,
  InstallPipelineResult,
} from "@/lib/extension-install-pipeline-types";

/**
 * Emit a structured durable-restore-failure operational event (cinatra#158 (d)) and
 * mirror it to `console.error` (so a deployment without structured-event collection
 * still surfaces the loud signal). Best-effort: a throwing sink is swallowed so it
 * never masks the original install error.
 */
function emitDurableRestoreFailure(
  deps: Pick<InstallPipelineDeps, "emitOperationalEvent">,
  evt: Omit<InstallDurableRestoreFailureEvent, "event">,
): void {
  const event: InstallDurableRestoreFailureEvent = { event: "install_durable_restore_failed", ...evt };
  try {
    deps.emitOperationalEvent?.(event);
  } catch {
    /* sink must never mask the original error */
  }
  // eslint-disable-next-line no-console
  console.error(
    `[extension-install-pipeline] durable restore FAILED (${event.scope}/${event.step}) for ` +
      `${event.packageName} (org ${event.orgId ?? "(global)"}) — the previous install may be only ` +
      `PARTIALLY restored until a successful re-install: ${event.reason}`,
  );
}

// ---------------------------------------------------------------------------
// THE SOURCE-AGNOSTIC PIPELINE (cinatra#3204 D1)
//
// The pipeline used to BE the registry road: its single entry resolved integrity
// from the registry and then ran every gate. So "install a supplied package the
// same way the store installs one" was not implementable — there was no way in.
//
// It is split here into two phases with one seam:
//
//   ACQUIRE — road-specific. It answers "which exact bytes, and what do we know
//             about them?" and materializes them into the content-addressed
//             store. The registry road resolves integrity + signature +
//             materialization plan from the registry; the SUPPLIED road takes an
//             immutable snapshot the operator handed us plus the content digest
//             computed over it, and verifies that digest against the delivered
//             tree before anything durable moves.
//
//   CORE   — road-agnostic, and it is the SAME code for both, not an
//             abbreviated version of it: requested-port read, widget claims,
//             journal read, host-compat gate, dependency-edge read, access
//             declaration, assistant gate, skill-packaging gate, trust
//             classification, the untrusted-install refusal, the pre-finalize
//             activation probe, the journal begin/advance, grants, migrations,
//             provenance, the finalize cross-check, edge persistence, the
//             forward closure gate, finalize, and both unwind paths.
//
// What the acquire phase hands over is `AcquiredPackage`. Everything a gate
// needs is on it — INCLUDING the provenance writer, because provenance is the
// one thing the two roads must record DIFFERENTLY: a registry install records
// verdaccio provenance with the registry's sha512 SRI, a supplied install
// records local/github provenance with the content digest. Making the writer
// part of the acquisition is what keeps a supplied install from having to be
// dressed as a registry one in order to reach the gates.
// ---------------------------------------------------------------------------

/**
 * The provenance a road records on the canonical row at the finalize seam. The
 * shape is the registry writer's; a supplied road's writer ignores the fields
 * that mean nothing for it (`registryUrl`, `attestedSha256`, `signature`,
 * `closureHash`) and records its own honest source instead.
 */
type ProvenanceWrite = Parameters<InstallPipelineDeps["recordProvenance"]>[0];

/** The outcome of a road's ACQUIRE phase — the seam the shared core runs on. */
type AcquiredPackage = {
  /** The RESOLVED concrete version every gate, the signature payload and provenance bind. */
  resolvedVersion: string;
  /** The registry this package came from, or the supplied road's honest non-registry marker. */
  registryUrl: string;
  /** The sha512 SRI the materializer verified the bytes against. */
  integrity: string;
  /** Additive sha256 attestation, registry road only. */
  sha256?: string;
  /** Producer signature over the tarball, registry road only. */
  signature?: string | null;
  /** The verified materialization-plan closure hash (cinatra#181), or null. */
  closureHash: string | null;
  /** The signature verdict fed to the trust classifier. */
  signatureVerified: boolean | undefined;
  /**
   * Whether the bytes came from the OPERATOR-SUPPLIED road — an archive an admin
   * uploaded, or a repository this instance resolved and pinned. It is the
   * supplied entry's answer to the trust classifier's ORIGIN factor, the way a
   * deployment's marketplace host is the registry road's answer to it. Absent on
   * the registry road, which passes a real registry URL instead.
   */
  operatorSuppliedOrigin?: boolean;
  /** The materialized store payload. */
  mat: { storeDir: string; digest: string; integrity: string; contentHash: string };
  /** Road-specific provenance writer (see ProvenanceWrite). */
  writeProvenance: (input: ProvenanceWrite) => Promise<void>;
  /**
   * What the core does when the trust classifier does NOT admit this package.
   *
   * "refuse" — today's behaviour, and the REGISTRY road's only setting: an
   *   untrusted install is refused before any durable mutation. Its rationale is
   *   activation: an untrusted package can never be imported in this process, so
   *   finalizing one would leave a committed install that shadows the working
   *   bundled implementation and serves nothing.
   *
   * "finalize-without-activation" — for a package that IMPORTS NOTHING. The
   *   metadata-only kinds (agent, skill, artifact) ship no hot-loadable server
   *   module: the pipeline's in-process activation is already inert for them and
   *   their run surface is projected by the native handler. For those, the
   *   rationale above simply does not apply — the install is usable and no
   *   package code ever runs. This is what lets an unsigned SUPPLIED package
   *   install while staying untrusted (cinatra#3204 criterion 26), and it is the
   *   ONLY thing it does: the classifier is untouched, no host is added to any
   *   allowlist, the grant still stays `pending` (auto-approval needs
   *   `trusted-signed`), declared migrations still do not run, and in-process
   *   activation is FORCED OFF so untrusted bytes cannot be imported even if an
   *   activator is wired.
   *
   * A supplied CONNECTOR is not in that set — its install exists to run
   * `register(ctx)` in this process — so it is admitted the only honest way:
   * through the classifier, by the road's own activation standing
   * (`operatorSuppliedOrigin`), and never by this policy.
   */
  untrustedInstallPolicy: "refuse" | "finalize-without-activation";
};

/**
 * Run the install pipeline for a REGISTRY package. The grant is AUTO-APPROVED only
 * for a `trusted-signed`
 * package from a trusted activation host (the capability split — never a
 * merely `trusted-bootstrap` or untrusted package); everything else stays
 * `pending` until an admin approves it — so a bootstrap/untrusted package, even
 * when materialized, never self-grants host ports.
 */
export async function installExtensionFromRegistry(
  input: InstallPipelineInput,
  deps: InstallPipelineDeps,
): Promise<InstallPipelineResult> {
  const { integrity, registryUrl, sha256, signature, resolvedVersion: resolvedFromRegistry, materializationPlan } = await deps.resolveIntegrity(input.packageName, input.version);
  // The signature payload + provenance MUST bind the RESOLVED concrete version, not
  // the caller's input (which may be a dist-tag). Fall back to the input only when
  // the resolver doesn't surface one (legacy/test deps).
  const resolvedVersion = resolvedFromRegistry ?? input.version;

  // cinatra#181 — SIGNED MATERIALIZATION PLAN (library dependency closure).
  // Parse the raw packument transport FAIL-CLOSED (any malformed plan throws —
  // normalizing to "no plan" would silently downgrade the package to v1
  // semantics), bind the plan's self-declared identity to the RESOLVED
  // (name, version), and recompute the closureHash the v2 signature must bind.
  let plan: MaterializationPlan | null = null;
  let closureHash: string | null = null;
  if (materializationPlan !== null && materializationPlan !== undefined) {
    plan = parseMaterializationPlan(materializationPlan);
    if (plan.package.name !== input.packageName || plan.package.version !== resolvedVersion) {
      throw new Error(
        `[install-pipeline] ${input.packageName}@${resolvedVersion}: the served materialization plan ` +
          `identifies as ${plan.package.name}@${plan.package.version} — a plan must bind the exact ` +
          `resolved package; refusing`,
      );
    }
    closureHash = computeClosureHash(plan);
  }

  // SIGNATURE VERDICT — computed BEFORE materialize (PR-4 review HIGH 1): a
  // plan-bearing package whose v2 signature does not verify against the
  // host-recomputed closureHash is REFUSED before ANY fetch/write — the plan
  // must never EXECUTE (per-node fetches + store writes) on unverified trust.
  // The downgrade matrix makes the verdict hard boolean whenever a plan is
  // present (v1/absent/no-key/invalid all === false), and a closure package
  // could never activate anyway — installing it would only burn bytes and
  // leave an inert store dir. Closure-LESS packages keep today's semantics
  // byte-for-byte (the same verdict value feeds classifyExtensionTrust below;
  // untrusted closure-less installs still finalize with a pending grant).
  const signatureVerified = resolveSignatureVerdict({
    packageName: input.packageName,
    version: resolvedVersion,
    integrity,
    signature,
    closureHash,
  });
  if (plan && signatureVerified !== true) {
    throw new Error(
      `[install-pipeline] ${input.packageName}@${resolvedVersion}: carries a materialization plan but no ` +
        `VERIFIED v2 signature binding its closureHash (v1/absent/unknown-prefix signatures and missing ` +
        `trusted keys are hard refusals — cinatra#181 downgrade refusal). Refusing BEFORE any fetch or ` +
        `write: the signed plan must verify before it may execute.`,
    );
  }

  const mat = await deps.materialize({
    packageName: input.packageName,
    // The RESOLVED concrete version (a dist-tag input would otherwise name the
    // store dir + sidecar + plan-identity check against the tag, while the
    // signature/provenance bind the resolved version — codex round-0 finding 6).
    version: resolvedVersion,
    expectedIntegrity: integrity,
    registryUrl,
    storeRoot: input.storeRoot, expectedKind: input.expectedKind, // cinatra#791
    plan,
    expectedClosureHash: closureHash,
  });

  return runInstallPipelineCore(input, deps, {
    resolvedVersion,
    registryUrl,
    integrity,
    ...(sha256 ? { sha256 } : {}),
    ...(signature ? { signature } : {}),
    closureHash,
    signatureVerified,
    mat,
    writeProvenance: (provenance) => deps.recordProvenance(provenance),
    // The registry road's behaviour is unchanged: an untrusted registry install
    // is refused exactly as it always was.
    untrustedInstallPolicy: "refuse",
  });
}

// ---------------------------------------------------------------------------
// THE SUPPLIED ROAD (cinatra#3204 D1)
// ---------------------------------------------------------------------------

/** The non-registry marker recorded where a registry URL would go. Never a URL:
 *  a supplied package was on no registry, and writing one would be a claim. */
export const SUPPLIED_PACKAGE_ORIGIN = "supplied:operator" as const;

/** An immutable snapshot of what the operator supplied, plus the digest over it. */
export type SuppliedPackageSnapshot = {
  /**
   * The snapshot bytes — an npm-layout tarball, exactly as delivered. IMMUTABLE
   * by contract: the caller has already read it for preview, and the digest
   * below was computed over what it read. The pipeline never re-fetches it, so
   * there is no window in which a moving branch or a re-uploaded file can swap
   * the contents between preview and install.
   */
  tarball: Uint8Array;
  /**
   * Honest provenance for the canonical row — `local` or `github`, carrying the
   * content digest. This is what gets RECORDED; it is never rewritten into a
   * registry shape.
   */
  provenance: SuppliedPackageProvenance;
};

export type SuppliedInstallPipelineInput = InstallPipelineInput & {
  supplied: SuppliedPackageSnapshot;
};

export type SuppliedInstallPipelineDeps = InstallPipelineDeps & {
  /**
   * Materialize the SUPPLIED snapshot into the content-addressed store. Same
   * store, same extraction, same sidecar, same content hash as a registry
   * install — the ONLY difference is where the bytes came from, which is why
   * this takes the bytes instead of a registry coordinate.
   */
  materializeSupplied: (input: {
    packageName: string;
    version: string;
    tarball: Uint8Array;
    storeRoot?: string;
    expectedKind?: import("@/lib/extension-package-store-core").ExtensionStoreKind;
  }) => Promise<{ storeDir: string; digest: string; integrity: string; contentHash: string }>;
  /**
   * Recompute the content digest over the MATERIALIZED tree, so the digest can
   * be VERIFIED rather than believed. Recomputing over what actually landed on
   * disk — not over the tarball framing — is what makes the verification mean
   * "the bytes that were previewed are the bytes that were installed".
   */
  computeStoreTreeDigest: (storeDir: string) => Promise<string>;
  /**
   * Record honest supplied provenance on the canonical row at the finalize seam.
   * The registry writer cannot stand in here: it writes a verdaccio source, and
   * a supplied package on a verdaccio row is the exact untruth this deliverable
   * removes.
   */
  recordSuppliedProvenance: (input: {
    packageName: string;
    orgId: string | null;
    version: string;
    provenance: SuppliedPackageProvenance;
    /**
     * The sha512 SRI the pipeline COMPUTED over the delivered tarball. Recorded
     * on the row beside the content hash so the supplied install has the same
     * out-of-store anchor evidence a registry install has (cinatra#3204).
     */
    integrity: string;
    contentHash: string;
    digest?: string | null;
    storeRoot?: string;
  }) => Promise<void>;
};

/**
 * Install a package the OPERATOR SUPPLIED — an uploaded archive, or a repository
 * snapshot — through the SAME gate set a registry install runs.
 *
 * The acquire phase is short and its whole job is trust hygiene:
 *
 *   1. The snapshot is taken as given. It is not re-fetched, so nothing can swap
 *      it after preview.
 *   2. Its SRI is COMPUTED over those exact bytes (not asserted by anyone) and
 *      handed to the materializer, which re-checks it before writing — so the
 *      store's integrity contract holds identically on this road.
 *   3. The content digest is RECOMPUTED over the materialized tree and compared
 *      to the digest the caller declared. A mismatch refuses BEFORE the first
 *      durable mutation and GCs the bytes: nothing is journaled, granted or
 *      recorded, which is the same inertness contract every pre-finalize gate in
 *      the core already keeps.
 *
 * What it deliberately does NOT do is manufacture trust. There is no registry
 * signature, so `signatureVerified` is undefined and the classifier reaches its
 * untrusted/bootstrap verdict on its own terms: requested host ports stay
 * `pending` for an admin, and declared migrations do not auto-run. A supplied
 * package is unsigned and stays untrusted — the digest proves the bytes did not
 * change, and it proves nothing at all about who wrote them.
 *
 * A materialization plan is not accepted on this road: a plan is a SIGNED
 * artifact served by the registry, and there is nobody to have signed one here.
 */
export async function installExtensionFromSuppliedSnapshot(
  input: SuppliedInstallPipelineInput,
  deps: SuppliedInstallPipelineDeps,
): Promise<InstallPipelineResult> {
  const { provenance, tarball } = input.supplied;

  if (!isSuppliedPackageProvenance(provenance)) {
    throw new Error(
      `[install-pipeline] ${input.packageName}: a supplied install requires complete provenance ` +
        `(local or github) carrying a well-formed content digest — refusing before any fetch or write.`,
    );
  }

  // The SRI over the exact supplied bytes. Computed, never claimed: the
  // materializer re-verifies it before writing, so the store's "verify before
  // write" contract is the same one the registry road relies on.
  const integrity = sriForBytes(tarball, "sha512");

  const mat = await deps.materializeSupplied({
    packageName: input.packageName,
    version: input.version,
    tarball,
    ...(input.storeRoot ? { storeRoot: input.storeRoot } : {}),
    ...(input.expectedKind ? { expectedKind: input.expectedKind } : {}),
  });

  // VERIFY THE DIGEST over what actually landed. A mismatch is a refusal, and it
  // is fully inert: `beginInstallOp` has not run, no grant exists, no provenance
  // was written, and the just-materialized dir is GC'd.
  const actualDigest = await deps.computeStoreTreeDigest(mat.storeDir);
  if (actualDigest !== provenance.contentDigest) {
    if (deps.gcStoreDir) {
      try {
        await deps.gcStoreDir(mat.storeDir);
      } catch {
        /* best-effort GC — a leftover dir is recovered by a later retry's gate. */
      }
    }
    throw new Error(
      `[install-pipeline] ${input.packageName}@${input.version}: the supplied snapshot's content digest ` +
        `does not match the delivered tree (declared ${provenance.contentDigest}, materialized ` +
        `${actualDigest}) — refusing before any durable write. The bytes that were previewed are not ` +
        `the bytes that arrived.`,
    );
  }

  return runInstallPipelineCore(input, deps, {
    resolvedVersion: input.version,
    // A supplied package has no registry, and the marker says so rather than
    // inventing a URL. What answers the classifier's ORIGIN factor is the road
    // itself (`operatorSuppliedOrigin` below), never this string.
    registryUrl: SUPPLIED_PACKAGE_ORIGIN,
    integrity,
    // No registry attestation, no producer signature, no signed plan.
    closureHash: null,
    signatureVerified: undefined,
    // THE ROAD'S OWN ACTIVATION STANDING (cinatra#3204). An admin with install
    // rights supplied these exact bytes and this entry re-verified their content
    // digest over what materialized, so the origin factor is answered here the
    // way a deployment's marketplace host answers it for a store install — of the
    // same standing, and with no other factor relaxed: the package is unsigned,
    // so it reaches `trusted-bootstrap` at most, self-grants no privileged host
    // port and runs no host DDL. This is the ONLY caller that declares it; the
    // registry road never does.
    operatorSuppliedOrigin: true,
    mat,
    // THE KIND DECIDES. A metadata-only kind imports nothing, so an untrusted
    // supplied package of that kind installs and stays untrusted (criterion 26).
    // A connector's whole install exists to run `register(ctx)` in this process,
    // so an untrusted one is refused — which is the correct outcome, and the
    // reason the issue says success is not promised for every connector package.
    untrustedInstallPolicy:
      input.expectedKind !== undefined && METADATA_ONLY_STORE_KINDS.has(input.expectedKind)
        ? "finalize-without-activation"
        : "refuse",
    writeProvenance: (write) =>
      deps.recordSuppliedProvenance({
        packageName: write.packageName,
        orgId: write.orgId,
        version: write.version,
        provenance,
        integrity: write.integrity,
        contentHash: write.contentHash,
        digest: write.digest ?? null,
        ...(write.storeRoot ? { storeRoot: write.storeRoot } : {}),
      }),
  });
}

/**
 * THE SHARED PIPELINE CORE — road-agnostic, and the ONLY implementation of the
 * gate set. Both entries run it; there is no second, shorter installer.
 */
async function runInstallPipelineCore(
  input: InstallPipelineInput,
  deps: InstallPipelineDeps,
  acquired: AcquiredPackage,
): Promise<InstallPipelineResult> {
  const {
    resolvedVersion,
    registryUrl,
    integrity,
    sha256,
    signature,
    closureHash,
    signatureVerified,
    operatorSuppliedOrigin,
    mat,
    writeProvenance,
    untrustedInstallPolicy,
  } = acquired;
  // Minted from `input.version` exactly as the single entry minted it — the id is
  // an opaque journal key, and changing how it is spelled would change how a
  // retry resumes.
  const installOpId =
    input.installOpId ??
    `${input.packageName}@${input.version}:${Math.random().toString(36).slice(2, 10)}`;

  const requestedPorts = await deps.readRequestedPorts(mat.storeDir);

  // Widget-auth token keys + widget-stream metadata claims this manifest DECLARES (SRI-verified bytes); [] when unwired/none.
  const declaredTokenKeys = deps.readWidgetAuthTokenKeys ? await deps.readWidgetAuthTokenKeys(mat.storeDir) : [];
  const widgetMetadataClaims = deps.readWidgetStreamMetadataClaims ? await deps.readWidgetStreamMetadataClaims(mat.storeDir) : [];

  // Read the CURRENT (package, org) journal op EARLY — read-only. Two consumers:
  // (1) the HOST-COMPAT GATE's GC guard just below (a same-version re-install
  // materializes to the SAME digest/dir as the LIVE install — GC'ing it on
  // refusal would destroy the working install's store dir), and (2) the
  // journal-compensation capture before `beginInstallOp` overwrites the single
  // (package, org) row (see the capture comment further down).
  const priorOp = await deps.readInstallOp?.(input.packageName, input.orgId);

  // FAIL-SAFE same-digest guard, defined ONCE for every seam that may GC the
  // just-materialized dir on a refusal.
  //
  // A LEGACY finalized op recorded no digest (`digest: null`). On a same-bytes
  // re-install of such a package the just-materialized dir IS the live dir, so a
  // strict `priorOp.digest === mat.digest` comparison reads FALSE and would GC a
  // working install. An undeterminable prior digest is therefore treated as LIVE:
  // this never GCs when it cannot prove the dir is disposable. Over-keeping a dir
  // is recovered by a later retry's store gate; over-deleting one is not.
  //
  // Sharing it matters as much as its shape: two refusal seams with two spellings
  // of "is this dir disposable" is exactly how one of them ends up deleting a
  // live install.
  const materializedDirIsLive = (): boolean =>
    priorOp?.phase === "finalized" &&
    (priorOp.digest == null || priorOp.digest === mat.digest);

  // HOST-COMPAT GATE — the extension → host/SDK half of the compatibility
  // contract. The materialized (SRI-verified) manifest's `cinatra.sdkAbiRange`
  // must admit this host's frozen SDK ABI — the SAME verdict both loaders gate
  // activation on (`evaluateHostSdkCompat` wraps the SDK's own checker, so the
  // install gate can never drift from the activation gate). Runs BEFORE the
  // update probe / journal / grant / provenance — the FIRST durable mutation is
  // `beginInstallOp` below — so a refused install OR update is fully inert: a
  // prior install's journal row stays `finalized`, its grant + provenance are
  // untouched, and a fresh install leaves nothing behind. The just-materialized
  // dir is GC'd (best-effort) UNLESS it IS the live install's dir (the
  // same-digest re-install case above). An undeclared/"*" range is unpinned →
  // allowed (parity with the loaders; refusing would brick every published
  // unpinned extension); a declared-but-malformed or unsatisfied range fails
  // closed with an actionable error (declared range vs. this host's ABI).
  if (deps.readDeclaredCompat) {
    const declared = await deps.readDeclaredCompat(mat.storeDir);
    if (!evaluateHostSdkCompat(declared.sdkAbiRange).compatible) {
      const isLiveDigest = priorOp?.phase === "finalized" && priorOp.digest === mat.digest;
      if (deps.gcStoreDir && !isLiveDigest) {
        try {
          await deps.gcStoreDir(mat.storeDir);
        } catch {
          /* best-effort GC — a leftover dir is recovered by a later retry's gate. */
        }
      }
      throw new Error(
        formatHostSdkCompatRefusal({
          op: priorOp?.phase === "finalized" ? "update" : "install",
          packageName: input.packageName,
          version: resolvedVersion,
          sdkAbiRange: declared.sdkAbiRange,
        }),
      );
    }
  }

  // PARENT-SATISFIED CONTEXT-SLOT GATE (cinatra#3032, plan (C) item 0.29) — the
  // composite agent's declaration against the agents it embeds. Runs in the same
  // seam as the host-compat gate above and under the same inertness contract:
  // BEFORE the update probe / journal / grant / provenance, so a refused install
  // OR update is fully inert, and the just-materialized dir is GC'd unless it IS
  // the live install's dir. A package with no composed document, or one that
  // declares no lines, passes untouched — the gate only ever fires on a
  // declaration that promises an embedded agent something the parent's own slot
  // cannot deliver.
  if (deps.readComposedAgentOas) {
    const composedOas = await deps.readComposedAgentOas(mat.storeDir);
    if (composedOas !== null && composedOas !== undefined) {
      const { readContextSlotComposition, checkParentSatisfiedContextSlots, formatContextSlotCompatRefusal } =
        await import("@/lib/extension-host-compat");
      const verdict = checkParentSatisfiedContextSlots(
        readContextSlotComposition(composedOas),
      );
      if (!verdict.compatible) {
        // `materializedDirIsLive()` — NOT the inline digest equality — because a
        // finalized journal row whose digest was never recorded (`null`) fails
        // that equality and the GC would then delete the dir the LIVE install is
        // running from. The module defines this guard for exactly that case.
        if (deps.gcStoreDir && !materializedDirIsLive()) {
          try {
            await deps.gcStoreDir(mat.storeDir);
          } catch {
            /* best-effort GC — a leftover dir is recovered by a later retry's gate. */
          }
        }
        throw new Error(
          formatContextSlotCompatRefusal({
            op: priorOp?.phase === "finalized" ? "update" : "install",
            packageName: input.packageName,
            version: resolvedVersion,
            conflicts: verdict.conflicts,
          }),
        );
      }
    }
  }

  // DEPENDENCY-EDGE READ (#180) — the dual-read helper over the materialized
  // (SRI-verified) manifest. Runs EARLY, with the host-compat gate above and
  // the same inertness contract: a malformed `cinatra.dependencies` entry or a
  // canonical-vs-legacy `agentDependencies` conflict THROWS here, BEFORE the
  // first durable mutation (`beginInstallOp` below) — a prior install's
  // journal/grant/provenance are untouched and the just-materialized dir is
  // GC'd (unless it IS the live install's dir, the same-digest re-install
  // guard the host-compat gate uses). The edges themselves are PERSISTED late,
  // at the finalize seam below.
  let dependencyEdges: ExtensionDependency[] | null = null;
  if (deps.readDependencyEdges) {
    try {
      dependencyEdges = await deps.readDependencyEdges(mat.storeDir);
    } catch (err) {
      const isLiveDigest = priorOp?.phase === "finalized" && priorOp.digest === mat.digest;
      if (deps.gcStoreDir && !isLiveDigest) {
        try {
          await deps.gcStoreDir(mat.storeDir);
        } catch {
          /* best-effort GC — a leftover dir is recovered by a later retry's gate. */
        }
      }
      throw err;
    }
  }

  // ACCESS-DECLARATION READ (cinatra#951) — the fail-closed resolve of the
  // connector's `cinatra/config.json` over the materialized (SRI-verified)
  // bytes, through the single SDK validator. Same EARLY placement + inertness
  // contract as the dependency-edge read above (see the helper's contract);
  // the declaration PERSISTS late, at the finalize seam below.
  const accessDeclaration = await readAccessDeclarationInertly(
    deps,
    mat.storeDir,
    priorOp?.phase === "finalized" && priorOp.digest === mat.digest,
  );

  // ASSISTANT PRE-FINALIZE GATE (cinatra#1874 W1) — same EARLY placement +
  // inertness/GC contract as the access read above. Reads the assistant install
  // signals from the materialized (SRI-verified) shared config.json through the
  // shared parser (agent-kind only; a malformed `assistant` block throws), then
  // enforces the two pre-journal invariants BEFORE `beginInstallOp`:
  //   - XOR (AC#2): an `assistant` block + connector-executor content (`access`
  //     block / compilable OAS) are mutually exclusive;
  //   - PLATFORM-SCOPE (AC#1): an assistant installs only at platform scope
  //     (orgId === null) — an org/team/project target is refused with a
  //     directing error.
  // A non-assistant package is a no-op. A refusal here is fully inert (the just-
  // materialized dir is GC'd; nothing durable has mutated). The read + gate + GC
  // contract lives in assistant-declaration-host.ts (`enforceAssistantInstallGateInertly`);
  // `isLiveDigest` is a thunk so it is evaluated at the SAME points the inlined
  // gate evaluated it (reader, then constraint-catch).
  await enforceAssistantInstallGateInertly(deps, {
    storeDir: mat.storeDir,
    orgId: input.orgId,
    packageName: input.packageName,
    isLiveDigest: () => priorOp?.phase === "finalized" && priorOp.digest === mat.digest,
  });

  // SKILL-PACKAGING PRE-FINALIZE GATE (cinatra#2089, epic #2086 S2) — same EARLY
  // placement + inertness/GC contract as the reads above. Runs THE shared
  // verdict (scripts/audit/_lib/skill-packaging-verdict.mjs — the same module CI
  // runs and the extension repos' publish gate vendors) over the materialized
  // (SRI-verified) package, so a non-conforming extension is refused at store
  // install with the SAME verdict text it would get at publish and in CI:
  //   - kind:"skill"  → exactly one Anthropic-schema bundle, singular `-skill`
  //     package name, valid frontmatter, bundle-directory ≡ frontmatter name,
  //     router length, the fail-closed ONE-HOP reference lint (the enforcement
  //     half of #2088's `captureDiagnostics.danglingReferences` diagnostic) and
  //     the upload size boundary;
  //   - any other kind → NO `SKILL.md` at ANY path outside the shared fixture
  //     allowlist.
  // Non-conformance that the enumerated legacy ledger still records is WAIVED
  // and logged (the S3 migration wave, cinatra#2090, empties the ledger). A
  // refusal is fully inert: the just-materialized dir is GC'd unless it IS the
  // live install's dir, and nothing durable has mutated.
  await enforceSkillPackagingGateInertly(deps, {
    storeDir: mat.storeDir,
    packageName: input.packageName,
    // FAIL-SAFE same-digest guard. The sibling seams compare
    // `priorOp.digest === mat.digest`, which reads FALSE for a LEGACY finalized
    // op that recorded no digest (`digest: null`) — and on a same-bytes
    // re-install of such a package the just-materialized dir IS the live dir, so
    // GC'ing it would delete a working install. This gate therefore treats an
    // undeterminable prior digest as LIVE: it never GCs when it cannot prove the
    // dir is disposable. Over-keeping a dir is recovered by a later retry's
    // store gate; over-deleting one is not.
    isLiveDigest: materializedDirIsLive,
  });

  // Classify the in-process import trust tier (vendor-agnostic). The host
  // allowlist + bootstrap lever come from the trust-config seam (publicRegistryUrl
  // only — never the instance's own publish target). Computed PURELY (no mutation)
  // up front so the pre-finalize gate below can probe-register the new digest with
  // the ports it WOULD get, WITHOUT first mutating the persisted grant.
  const verdict = classifyExtensionTrust({
    packageName: input.packageName,
    registryUrl,
    integrityVerified: true,
    persistedTrustDecision: true,
    // When signing is configured/required, the install-time decision
    // respects it too (undefined = no signing → bootstrap/transition
    // behavior). Computed ONCE, above, BEFORE materialize — when the package
    // carries a plan the verdict is NEVER undefined and a non-true verdict
    // already refused the install before any write (cinatra#181).
    signatureVerified,
    // The supplied road's own activation standing (absent on the registry road,
    // where the deployment's host allowlist is the only origin answer).
    ...(operatorSuppliedOrigin ? { operatorSuppliedOrigin: true } : {}),
    trustedActivationHosts: (deps.trustedActivationHosts ?? trustedActivationHosts)(),
    allowMarketplaceBootstrapTrust: (
      deps.allowMarketplaceBootstrapTrust ?? allowMarketplaceBootstrapTrust
    )(),
  });

  // Capability split: auto-granting privileged host ports AND
  // running host DDL require `trusted-signed` (a verified signature) — never
  // `trusted-bootstrap` alone. A bootstrap-trusted multi-vendor package may import
  // in-process (the loader allows it), but its requested ports stay PENDING for an
  // admin and its declared migrations do NOT auto-run. An admin can later approve
  // the pending grant out-of-band.
  const autoGrantPrivileged = verdict.tier === "trusted-signed";

  // UNTRUSTED-INSTALL GATE. An install whose trust verdict is NOT trusted can
  // never activate in this process: the loader refuses the import. Letting it
  // continue is what produced the committed-but-unactivated state: the journal,
  // grant and provenance were all written, the row finalized live, and the
  // refusal only surfaced afterwards, leaving a package that shadowed the
  // working bundled implementation and served nothing.
  //
  // It refuses HERE instead, before `beginInstallOp` and therefore before any
  // durable mutation, with the SAME inertness contract as the host-compat gate
  // above: a prior install's journal stays `finalized`, its grant and provenance
  // are untouched, and the just-materialized dir is GC'd unless it IS the live
  // install's dir (the same-digest re-install guard).
  //
  // The failure names the EXACT verdict the classifier produced (an unverifiable
  // signature, an absent signature with bootstrap disabled, a registry host that
  // is not allow-listed). The generic "anchor-refused" summary hid which of those
  // it was, which is the one thing an operator needs in order to act.
  //
  // Nothing here loosens the classifier. The safe fallback for a package that
  // fails it is the implementation bundled in the image, never a weaker trust
  // decision for the new bytes.
  // A package the classifier does not admit, on a road whose kind imports
  // nothing, may still install — see `untrustedInstallPolicy`. It never
  // activates in process (forced below), never self-grants and never runs
  // migrations, so nothing about the trust boundary moves.
  // A kind that IMPORTS NOTHING never activates in this process — whatever the
  // verdict says. It is the kind that decides, so the two questions stay apart:
  // "may this code be imported here" (the classifier) and "does this kind import
  // anything at all" (the policy the road passes).
  const importsNothingByKind = untrustedInstallPolicy === "finalize-without-activation";
  if (!verdict.trusted && !importsNothingByKind) {
    const isLiveDigest = materializedDirIsLive();
    // Whether the materialized bytes are actually gone. The refusal SAYS what it
    // did, so a swallowed GC failure must not be reported as a removal: a
    // leftover dir is real state a later boot can trip over, and telling an
    // operator it was cleaned up when it was not is the kind of small lie that
    // costs an hour. A same-digest re-install never GCs (that dir IS the live
    // install's), so it is reported as retained too.
    let bytesRemoved = false;
    if (deps.gcStoreDir && !isLiveDigest) {
      try {
        await deps.gcStoreDir(mat.storeDir);
        bytesRemoved = true;
      } catch (gcErr) {
        console.warn(
          "[extension-install-pipeline] refused install left its materialized dir in place for %s: %s",
          input.packageName,
          gcErr instanceof Error ? gcErr.message : String(gcErr),
        );
      }
    }
    throw new UntrustedInstallRefusedError(
      input.packageName,
      resolvedVersion,
      verdict.reason,
      priorOp?.phase === "finalized" ? "update" : "install",
      bytesRemoved,
      isLiveDigest,
    );
  }

  // HOT-UPDATE pre-finalize activation gate. If the
  // just-materialized digest SUPERSEDES an existing one (an UPDATE), PROVE the new
  // digest activates (imports + integrity-verifies + register(ctx) succeeds)
  // BEFORE we mutate ANY shared (package, org) state — the install-op JOURNAL row,
  // the host-port GRANT, or the provenance. The probe
  // runs against the IN-FLIGHT integrity/contentHash + the EFFECTIVE ports the new
  // digest will ACTUALLY activate with:
  //   - `trusted-signed` (`autoGrantPrivileged`): `requestedPorts` — it self-grants
  //     them this install, so the activation has them.
  //   - otherwise (`trusted-bootstrap`/untrusted, NO auto-grant): the EXACT-scope
  //     admin-approved grant's ports for this (package, org) — but ONLY when that
  //     grant predicts what activation will ACTUALLY grant. The probe must mirror
  //     `recordRequestedGrant` (below) + the anchor's exact-scope resolution:
  //       (1) `recordRequestedGrant` resets an existing grant to `pending` when the
  //           requested-ports hash CHANGED (different ports) → activation gets [].
  //           Only an UNCHANGED requested-ports hash keeps the prior approval.
  //       (2) `resolveInstallAnchor` counts ports ONLY for a grant whose scope
  //           EXACTLY matches the install's org (NO global-fallback inheritance) and
  //           whose status is `approved`.
  //     So the EFFECTIVE bootstrap ports are the exact-(package, org)-scoped grant's
  //     approvedPorts IFF it exists AND its org matches AND it is `approved` AND its
  //     stored requestedPortsHash equals the in-flight requested ports' hash — ELSE
  //     []. Reading the EXACT-scope row (not `readApprovedPorts`, whose global
  //     fallback would leak a cross-scope grant the anchor refuses) keeps the probe ==
  //     activation's effective grant. Read-only — the intent (no AUTO-grant for
  //     bootstrap) is preserved: `approveGrant` below still runs ONLY for
  //     `autoGrantPrivileged`.
  //
  // CRITICAL ORDERING: this gate is the FIRST thing after
  // materialize, BEFORE beginInstallOp / recordRequestedGrant / approveGrant. For
  // a superseding UPDATE whose new digest fails the gate we GC the bad dir and
  // THROW immediately — having touched NOTHING shared:
  //   - the previous install's install-op journal row is still `finalized`, so the
  //     trust anchor still resolves it and the boot RuntimePackageLoader still
  //     activates the previous install;
  //   - the previous install's host-port grant is untouched — neither reset to
  //     `pending` nor re-approved against the new digest's ports;
  //   - the previous provenance + the old store dir are unchanged.
  // So a failed update is fully inert: the previous install is durably intact AND
  // boot-activatable AND keeps its exact prior access state.
  //
  // A fresh install (`supersedes:false`) is unaffected: there is no prior anchor /
  // grant to protect, the gate is a no-op, and the mutations below proceed.
  //
  // TRUST GATE on the probe (cinatra#181): the probe
  // IMPORTS the new digest and calls `register(ctx)` — executing package code.
  // An UNTRUSTED package (e.g. a closure package whose v1/absent signature the
  // downgrade-refusal matrix hard-refused, or any tampered signature) must
  // never get code execution out of the probe. Skipping it is safe: an
  // untrusted update's REAL safety boundary is unchanged — the post-commit
  // hot-update activation runs under the loader's trust gate (which refuses
  // the import) and the durable rollback restores the OLD install.
  if (deps.verifyActivatableBeforeFinalize) {
    // EFFECTIVE ports the new digest will activate with (see the block comment):
    // a `trusted-signed` install self-grants its requested ports; otherwise the
    // probe must equal what activation will grant AFTER `recordRequestedGrant` +
    // the anchor's exact-scope resolution. The exact-(package, org)-scoped grant's
    // approvedPorts count ONLY IF that grant exists, its org matches, it is
    // `approved`, and its stored requestedPortsHash still matches the in-flight
    // requested ports (an UNCHANGED request keeps the prior approval; a CHANGED
    // request will reset the grant to pending → no ports). Anything else → [].
    // No reader wired (older unit tests) → [] (the bootstrap/untrusted path).
    let effectiveBootstrapPorts: readonly string[] = [];
    if (!autoGrantPrivileged && deps.readGrantForScope) {
      const grant = await deps.readGrantForScope(input.packageName, input.orgId);
      if (
        grant &&
        (grant.orgId ?? null) === (input.orgId ?? null) &&
        grant.status === "approved" &&
        grant.requestedPortsHash === computeRequestedPortsHash(requestedPorts)
      ) {
        effectiveBootstrapPorts = grant.approvedPorts;
      }
    }
    const probeApprovedPorts = autoGrantPrivileged ? requestedPorts : effectiveBootstrapPorts;
    const gate = await deps.verifyActivatableBeforeFinalize({
      packageName: input.packageName,
      orgId: input.orgId,
      storeDir: mat.storeDir,
      integrity: mat.integrity,
      contentHash: mat.contentHash,
      approvedPorts: probeApprovedPorts,
      ...(input.storeRoot ? { storeRoot: input.storeRoot } : {}),
    });
    if (!gate.ok) {
      // GC the failed digest so two dirs never coexist for the boot duplicate-name
      // gate. GUARDED on `isLiveDigest`, the same guard the host-compat and
      // untrusted gates use: a same-version re-install materializes to the SAME
      // dir as the LIVE install, so deleting it on a probe failure would destroy
      // the working install this refusal is supposed to protect. That guard used
      // to be implicit here, because only a superseding UPDATE reached this branch
      // and a superseding digest is by definition not the live one; extending the
      // probe to fresh installs removed that guarantee, so the guard is explicit.
      const gcIsLiveDigest = materializedDirIsLive();
      let gcBytesRemoved = false;
      if (deps.gcStoreDir && !gcIsLiveDigest) {
        try {
          await deps.gcStoreDir(mat.storeDir);
          gcBytesRemoved = true;
        } catch (gcErr) {
          console.warn(
            "[extension-install-pipeline] refused install left its materialized dir in place for %s: %s",
            input.packageName,
            gcErr instanceof Error ? gcErr.message : String(gcErr),
          );
        }
      }
      // Do NOT journal this failed attempt. `beginInstallOp` deliberately has not
      // run yet (it runs below, AFTER the gate), so there is no install-op row for
      // this attempt — and the journal is one row per (package, org) that
      // `beginInstallOp` UPSERTs, so minting/advancing one here would RESET the
      // PREVIOUS install's `finalized` journal row and break the still-working old
      // version. The journal correctly stays the old `finalized` op;
      // the bad new digest is already GC'd above; the throw below is the
      // authoritative failure signal.
      // The message states what is actually on disk. A swallowed GC failure, or a
      // dir kept because it IS the live install's, must never be reported as a
      // removal.
      const bytesNote = gcBytesRemoved
        ? "the failed digest was GC'd"
        : gcIsLiveDigest
          ? "the materialized dir was kept because it is the live install's"
          : "the materialized bytes are still on disk and need clearing";
      throw new Error(
        gate.supersedes
          ? `update of ${input.packageName}@${input.version} could not activate the new digest ` +
            `(${gate.reason}): the previous install is left durably intact (journal, grant, ` +
            `provenance and store dir unchanged), ${bytesNote}; no finalize.`
          : `install of ${input.packageName}@${input.version} could not activate ` +
            `(${gate.reason}): nothing was committed. No install-op journal, grant or ` +
            `provenance was written, ${bytesNote}, and the implementation bundled in the ` +
            `image stays in service.`,
      );
    }
  }

  // `priorOp` (read EARLY, above the host-compat gate) captures the CURRENT
  // (package, org) journal op BEFORE `beginInstallOp` below overwrites the single
  // (package, org) row. On a hot-UPDATE this is the OLD install's `finalized` op
  // (its id + digest); on a FRESH install it is null (or a non-finalized
  // leftover). The single-row UPSERT means `beginInstallOp` for the NEW attempt
  // DESTROYS the old `finalized` op — so if any post-begin step throws on an
  // update, we re-create this prior op (the catch below) to keep the
  // previously-working install boot-anchorable (`resolveInstallAnchor` requires
  // `phase === 'finalized'`).

  // CAPTURE (UPDATE only): before the mutations below overwrite durable
  // state, snapshot what a post-commit DURABLE ROLLBACK needs to re-pin the OLD
  // install:
  //   (b) the prior canonical source/provenance (read BEFORE `recordProvenance`'s
  //       sourceSwitch overwrites it) — re-recorded on rollback;
  //   (c) the prior EXACT-(package, org)-scoped host-port grant row (status +
  //       approvedPorts + requestedPortsHash) — re-recorded + re-approved on rollback.
  // Only meaningful when a prior finalized install exists (a real UPDATE); a fresh
  // install captures null/none and never takes the rollback path.
  const isUpdate = priorOp?.phase === "finalized";
  const priorSource = isUpdate ? (await deps.readCurrentSource?.(input.packageName, input.orgId)) ?? null : null;
  const priorGrant = isUpdate ? (await deps.readGrantForScope?.(input.packageName, input.orgId)) ?? null : null;
  // Prior ownership + widget-metadata grants (per declared claim) for durable rollback of a failed update.
  const priorOwnershipGrants = await capturePriorOwnershipGrants(deps, { isUpdate, packageName: input.packageName, orgId: input.orgId, declaredTokenKeys, widgetMetadataClaims });
  // (d) the prior canonical row's persisted dependency EDGES (#180) — the NEW
  // manifest's edges land at the finalize seam below, so a failed update must
  // restore these on BOTH unwind paths or every closure gate reads the failed
  // version's edges against the still-live OLD install.
  const priorEdges = isUpdate
    ? (await deps.readCurrentDependencies?.(input.packageName, input.orgId)) ?? null
    : null;
  // (e) the prior canonical row's cached access DECLARATION (cinatra#951),
  // restored on BOTH unwind paths (see restorePriorAccessDeclaration).
  const priorAccessDeclaration = isUpdate
    ? (await deps.readCurrentAccessDeclaration?.(input.packageName, input.orgId)) ?? null
    : null;
  // (f) the prior canonical row's recorded widget-auth token keys (owner ruling
  // 2026-07-23), restored on BOTH unwind paths (see restorePriorWidgetAuthTokenKeys).
  const priorWidgetAuthTokenKeys = isUpdate
    ? (await deps.readCurrentWidgetAuthTokenKeys?.(input.packageName, input.orgId)) ?? null
    : null;

  let grantStatus: "approved" | "pending" = "pending";
  try {
    // Journal-begin at `materialized` — the row exists but is NOT yet finalized,
    // so the anchor gate refuses it until the LATE finalize below. Begins ONLY
    // after the pre-finalize gate above has PROVEN the new digest activatable (for
    // a superseding update), so a failed update never resets the previous install's
    // `finalized` journal row. For a fresh install the gate was a no-op.
    await deps.beginInstallOp?.({ installOpId, packageName: input.packageName, orgId: input.orgId, digest: mat.digest });

    // Record the requested grant + auto-approve AFTER the gate proved the new
    // digest activatable, so a failed update never resets/re-approves the previous
    // install's grant. Auto-approve follows the capability split:
    // only a `trusted-signed` package (`autoGrantPrivileged`) self-grants its
    // requested ports — a bootstrap/untrusted install records the request but stays
    // PENDING for an admin.
    await deps.recordRequestedGrant({ packageName: input.packageName, orgId: input.orgId, requestedPorts });

    if (autoGrantPrivileged) {
      await deps.approveGrant({
        packageName: input.packageName,
        orgId: input.orgId,
        approvedPorts: requestedPorts,
        requestedPorts,
        approvedBy: input.actorUserId ?? "system:auto-trusted-signed",
      });
      grantStatus = "approved";
    }
    // Record a PENDING ownership grant per declared token key, auto-approved ONLY
    // for `trusted-signed` (same split as ports/DDL) — widget METADATA claims pend with NO auto-approve on ANY tier.
    await recordAndAutoApproveOwnershipGrants(deps, { declaredTokenKeys, widgetMetadataClaims, autoGrantPrivileged, packageName: input.packageName, orgId: input.orgId, approvedBy: input.actorUserId ?? "system:auto-trusted-signed" });
    await deps.advanceInstallOpPhase?.({ installOpId, phase: "granted" });

    // Apply the extension's declared, host-run node-pg-migrate migrations
    // (`cinatra.migrationsDir`, #118) BEFORE finalize — a failed migration
    // THROWS here, so the journal never reaches `finalized` and the trust
    // anchor refuses the row (no partial install looks trusted). Gated on
    // `autoGrantPrivileged` (the capability split): running host DDL is a
    // privileged capability, so it requires `trusted-signed` — never a
    // bootstrap-only or untrusted install. A bootstrap / pending install
    // must NOT create extension-owned tables; its migrations run only once it
    // becomes signed-trusted+activated (the loader's trusted boot pass applies DDL
    // ONLY to signed records — see runtime-package-loader.ts). Only runs when wired
    // (the default factory does); a package that declares no migrationsDir is a
    // no-op (the common case), and the RETIRED legacy `cinatra.migrations`
    // JSON-DSL field throws fail-closed.
    if (deps.preflightMigrations) {
      // Validate-only, EVERY install: throws on the retired legacy field or a
      // malformed declaration; returns whether host migrations are declared.
      const declaresMigrations = await deps.preflightMigrations({
        storeDir: mat.storeDir,
        packageName: input.packageName,
      });
      if (declaresMigrations && !autoGrantPrivileged) {
        throw new Error(
          `[install-pipeline] ${input.packageName} declares host migrations (cinatra.migrationsDir) but this ` +
            `install is not trusted-signed — host DDL requires a verified signature (#118). Refusing to finalize: ` +
            `the migrations would never run and the install could never safely activate.`,
        );
      }
    }
    if (deps.applyMigrations && autoGrantPrivileged) {
      await deps.applyMigrations({
        storeDir: mat.storeDir,
        packageName: input.packageName,
        version: resolvedVersion,
        orgId: input.orgId,
      });
      await deps.advanceInstallOpPhase?.({ installOpId, phase: "preflighted" });
    }

    // Provenance is written LATE — AFTER the requested grant + the auto-approve
    // (and after the pre-finalize activation gate), as the last write before the
    // journal is finalized. So a crash anywhere above leaves the row WITHOUT real
    // provenance AND WITHOUT a `finalized` journal phase, and the anchor gate
    // refuses it. Provenance + finalize land together at the tail. Binds the
    // RESOLVED concrete version (never the caller's dist-tag).
    await writeProvenance({
      packageName: input.packageName,
      orgId: input.orgId,
      version: resolvedVersion,
      registryUrl,
      integrity: mat.integrity,
      contentHash: mat.contentHash,
      ...(sha256 ? { attestedSha256: sha256 } : {}),
      ...(signature ? { signature } : {}),
      ...(closureHash ? { closureHash } : {}),
      // cinatra#792: bind the DB-authoritative active digest at the outcome
      // seam — the SAME `mat.digest` `beginInstallOp` journaled above, so the
      // finalized journal digest confirms it at read time (selectActiveDigest).
      digest: mat.digest,
      ...(input.storeRoot ? { storeRoot: input.storeRoot } : {}),
    });

    // FINALIZE-TIME CROSS-CHECK (cinatra#792): the row's just-written
    // `source.activeDigest` must equal the digest this op journaled, or we
    // refuse to finalize (a torn `sourceSwitch` write, or a concurrent writer
    // clobbering the row mid-install, must not be promoted to the anchor). The
    // throw routes into the existing catch: the NEW op is terminalized and an
    // update's captured prior state is restored. Read-time selection
    // (`selectActiveDigest`) remains the enforcement backstop for anything
    // this in-flight check cannot see.
    if (deps.readActiveDigest) {
      const rowDigest = await deps.readActiveDigest(input.packageName, input.orgId);
      if (rowDigest !== mat.digest) {
        throw new Error(
          `install of ${input.packageName}@${resolvedVersion}: canonical row activeDigest ` +
            `${rowDigest ?? "(absent)"} does not match this install's journaled digest ${mat.digest} ` +
            `after recordProvenance — refusing to finalize (torn/clobbered provenance write).`,
        );
      }
    }

    // EDGE PERSISTENCE at the FINALIZE SEAM (#180): the
    // manifest's dependency edges (read EARLY above, fail-loud) land on the
    // canonical row together with the provenance, BEFORE the journal advances
    // to `finalized` — so a `finalized` install-op implies persisted edges.
    // Runs for fresh installs AND updates (an update's new manifest must
    // refresh the row's edges, or every downstream closure gate reads stale
    // truth). A throw here aborts the finalize: the catch below restores the
    // prior op on an update; a fresh install's non-finalized row is the
    // dispatcher's to roll back.
    if (dependencyEdges !== null && deps.persistDependencyEdges) {
      await deps.persistDependencyEdges({
        packageName: input.packageName,
        orgId: input.orgId,
        dependencies: dependencyEdges,
      });
    }

    // DECLARATION PERSISTENCE at the FINALIZE SEAM (cinatra#951) — same
    // guarantees as the dependency edges above; null (non-connector) skips.
    await persistAccessDeclarationAtFinalize(deps, {
      packageName: input.packageName,
      orgId: input.orgId,
      declaration: accessDeclaration,
    });

    // WIDGET-AUTH DECLARED TOKEN KEYS at the FINALIZE SEAM (owner ruling
    // 2026-07-23) — recorded AFTER recordProvenance so the column is
    // crash-consistent with the NEW source: a crash between here and the journal
    // finalize leaves the row un-anchorable (selectActiveDigest mismatch), so an
    // OLD finalized anchor can never pair with the NEW version's keys. Always
    // writes (incl []) so a re-install that DROPS a key clears the stale value;
    // a null column then reliably means "legacy row" (arm (c) fails closed).
    await persistWidgetAuthTokenKeysAtFinalize(deps, {
      packageName: input.packageName,
      orgId: input.orgId,
      tokenKeys: declaredTokenKeys,
    });

    // FORWARD INSTALL GATE (#180 item 5) — FRESH installs only: with the
    // candidate's edges persisted, refuse to finalize when an
    // install-blocking edge's target is not installed (edgeType-aware: peer
    // and optional edges never block). The throw routes into the existing
    // rollback (journal never `finalized`; the dispatcher drops the
    // placeholder row). An UPDATE is not gated here — the previous install
    // stays protected by the hot-update machinery, and update-time
    // constraint evaluation is the version-aware stage of #180.
    if (!isUpdate && deps.assertForwardInstallClosure) {
      await deps.assertForwardInstallClosure({
        packageName: input.packageName,
        orgId: input.orgId,
      });
    }

    // SUPERSESSION SEAM (cinatra#158): finalize through `finalizeInstallOp`, which
    // atomically demotes any prior `finalized` op for this (package, org) to
    // `superseded` and promotes THIS op — never a plain phase advance (that would
    // leave two `finalized` rows and violate the partial-unique invariant).
    await deps.finalizeInstallOp?.(installOpId);
  } catch (err) {
    // A post-begin step threw. cinatra#158 (append-only journal): `beginInstallOp`
    // above APPENDED a NEW non-finalized op for THIS attempt; it did NOT touch the
    // OLD install's `finalized` op (which still exists). So the OLD anchor is intact
    // with ZERO journal restore — we only TERMINALIZE the NEW op so it can never be
    // mistaken for the anchor and the boot sweep treats it as settled. THIS replaces
    // the deleted re-begin+re-finalize "restore choreography".
    //
    // On a FRESH install (no prior finalized op) terminalize-NEW also applies: the
    // non-finalized row is the dispatcher's to roll back via the journal-aware check;
    // terminalizing it here makes that explicit and keeps the boot sweep clean.
    try {
      await deps.advanceInstallOpPhase?.({ installOpId, phase: "failed" });
      await deps.advanceInstallOpPhase?.({ installOpId, phase: "rolled_back" });
    } catch (terminalizeErr) {
      // eslint-disable-next-line no-console
      console.error(
        `[extension-install-pipeline] failed to terminalize the aborted install-op ` +
          `${installOpId} for ${input.packageName} (boot sweep will compensate it): ` +
          `${terminalizeErr instanceof Error ? terminalizeErr.message : String(terminalizeErr)}`,
      );
    }
    // The OLD install's canonical state (provenance, host-port grant, dependency
    // edges) may have been OVERWRITTEN by this attempt's late writes BEFORE the
    // throw — those are SEPARATE durable state on the canonical row / grant row that
    // the append-only journal does NOT undo. So on an UPDATE (a prior finalized op
    // existed) RESTORE the captured OLD provenance/grant/edges. Best-effort +
    // isolated; each FAILED step emits a structured operational event (cinatra#158
    // (d)) AND logs, never masking the original error. A FRESH install captured none.
    // Undo this attempt's capability-grant writes (ownership + widget metadata) —
    // OUTSIDE the isUpdate guard: a fresh install auto-approved ownership grants
    // too and must revoke them, else a failed install leaves an approved owner.
    await unwindOwnershipGrants({
      deps,
      packageName: input.packageName,
      orgId: input.orgId,
      declaredTokenKeys, widgetMetadataClaims,
      priorOwnershipGrants,
      onFailure: (e) =>
        emitDurableRestoreFailure(deps, {
          packageName: input.packageName,
          orgId: input.orgId,
          step: "ownership-grant",
          scope: "pre-finalize",
          reason: e instanceof Error ? e.message : String(e),
        }),
    });
    if (isUpdate) {
      // ALSO restore the OLD host-port grant — `recordRequestedGrant`/`approveGrant`
      // may have reset/re-approved it against the new ports before the throw.
      if (priorGrant && deps.restoreGrant) {
        try {
          await deps.restoreGrant({
            packageName: input.packageName,
            orgId: input.orgId,
            status: priorGrant.status as "pending" | "approved" | "revoked",
            approvedPorts: priorGrant.approvedPorts,
            requestedPortsHash: priorGrant.requestedPortsHash,
            approvedBy: priorGrant.approvedBy ?? null,
          });
        } catch (restoreErr) {
          emitDurableRestoreFailure(deps, {
            packageName: input.packageName,
            orgId: input.orgId,
            step: "grant",
            scope: "pre-finalize",
            reason: restoreErr instanceof Error ? restoreErr.message : String(restoreErr),
          });
        }
      }
      // RESTORE THE OLD RECORDED WIDGET-AUTH TOKEN KEYS **BEFORE** the provenance
      // restore below (owner ruling 2026-07-23, codex round-2). Re-pinning the OLD
      // provenance makes the OLD digest anchorable again (its finalized journal op
      // still matches); if the column still held the NEW version's keys at that
      // instant, arm (c) could authorize the OLD signed provider for a key its OLD
      // manifest never declared. Restoring the keys FIRST (while the row is still
      // un-anchorable — NEW activeDigest vs OLD journal) guarantees the column is
      // OLD by the time the OLD source becomes resolvable. A captured NULL prior
      // (legacy row) restores to [] — arm (c) fail-closed, never a stale value.
      await restorePriorWidgetAuthTokenKeys(
        deps,
        { packageName: input.packageName, orgId: input.orgId, isUpdate, prior: priorWidgetAuthTokenKeys },
        (reason) =>
          emitDurableRestoreFailure(deps, {
            packageName: input.packageName,
            orgId: input.orgId,
            step: "widget-auth-token-keys",
            scope: "pre-finalize",
            reason,
          }),
      );
      // ALSO restore the OLD provenance + dependency EDGES (#180). The tail of the
      // try block is `recordProvenance` → `persistDependencyEdges` → forward gate →
      // finalize, so a throw in that window can leave the NEW version's source/edges
      // on the canonical row while the OLD journal op anchors the OLD install — a
      // contradiction the loader's digest binding (cinatra#158) refuses, but which we
      // still re-pin to keep the canonical row coherent. Idempotent same-value
      // rewrites when the corresponding write never ran.
      if (priorSource) {
        try {
          await deps.recordProvenance({
            packageName: input.packageName,
            orgId: input.orgId,
            version: priorSource.version,
            registryUrl: priorSource.registryUrl,
            integrity: priorSource.integrity,
            contentHash: priorSource.contentHash ?? "",
            ...(priorSource.attestedSha256 ? { attestedSha256: priorSource.attestedSha256 } : {}),
            ...(priorSource.signature ? { signature: priorSource.signature } : {}),
            // cinatra#181: the prior install's closureHash MUST ride every restore —
            // sourceSwitchExtension replaces the WHOLE source object.
            ...(priorSource.closureHash ? { closureHash: priorSource.closureHash } : {}),
            // cinatra#792: re-pin the OLD digest (row `activeDigest` + the
            // `current` mirror). A legacy prior source without a recorded
            // activeDigest falls back to the OLD finalized journal digest —
            // the same value read-time selection would pick — so the mirror
            // never stays pointed at the failed NEW digest.
            digest: priorSource.activeDigest ?? priorOp?.digest ?? null,
            ...(input.storeRoot ? { storeRoot: input.storeRoot } : {}),
          });
        } catch (restoreErr) {
          emitDurableRestoreFailure(deps, {
            packageName: input.packageName,
            orgId: input.orgId,
            step: "provenance",
            scope: "pre-finalize",
            reason: restoreErr instanceof Error ? restoreErr.message : String(restoreErr),
          });
        }
      }
      if (priorEdges !== null && deps.persistDependencyEdges) {
        try {
          await deps.persistDependencyEdges({
            packageName: input.packageName,
            orgId: input.orgId,
            dependencies: priorEdges,
          });
        } catch (restoreErr) {
          emitDurableRestoreFailure(deps, {
            packageName: input.packageName,
            orgId: input.orgId,
            step: "dependencies",
            scope: "pre-finalize",
            reason: restoreErr instanceof Error ? restoreErr.message : String(restoreErr),
          });
        }
      }
      // ALSO restore the OLD cached access declaration (cinatra#951) — the
      // helper owns the contract (keyed on isUpdate; a prior NULL is restored
      // to null).
      await restorePriorAccessDeclaration(
        deps,
        { packageName: input.packageName, orgId: input.orgId, accessDeclaration, isUpdate, prior: priorAccessDeclaration },
        (reason) =>
          emitDurableRestoreFailure(deps, {
            packageName: input.packageName,
            orgId: input.orgId,
            step: "access-declaration",
            scope: "pre-finalize",
            reason,
          }),
      );
    }
    throw err;
  }

  // POST-COMMIT in-process activation. The install is now FINALIZED — provenance
  // recorded, journal `finalized`, grant approved — so the trusted anchor resolves
  // the row and the loader will activate it. Pick it up in the CURRENT process
  // WITHOUT a restart.
  //
  // Routing:
  //   - FRESH install (no prior finalized op, or the new digest does NOT supersede
  //     one): plain best-effort `activateInProcess` — a throw is swallowed (the
  //     install already committed; the boot loader is the durable path). NO
  //     quarantine/rollback path. When no activator is wired (unit tests), no-op.
  //   - UPDATE (a prior finalized install exists AND the new digest differs):
  //     `activateUpdateWithRollback` — QUARANTINE the old digest, activate the NEW
  //     digest, and DURABLY ROLL BACK to the OLD version if the new digest fails
  //     live activation for ANY reason the pre-finalize probe could not predict.
  //     The pre-finalize probe is NOT the safety boundary; THIS rollback is.
  let activated = false;
  let rolledBack = false;
  // Default true so a non-rollback path (fresh install / good update) never emits a
  // spurious rollbackComplete:false. Only a rollback sets it from the activator's
  // verdict: a PARTIAL durable restore flips it to false.
  let rollbackComplete = true;
  let activationReason: string | undefined = "no-activator";

  const isSupersedingUpdate = isUpdate && priorOp!.digest !== mat.digest;

  if (isSupersedingUpdate && deps.activateUpdateWithRollback) {
    // Build the DURABLE ROLLBACK closure from the CAPTURED prior state. Runs (only)
    // when the NEW digest fails live activation: re-pins every durable axis to OLD —
    // provenance/source, the host-port grant, the dependency edges, and the install-op
    // JOURNAL. cinatra#158 (append-only): the NEW op's `finalizeInstallOp` above
    // DEMOTED the OLD finalized op to `superseded` and promoted NEW to `finalized`.
    // So the journal re-pin is NOT the deleted re-begin choreography — it is a single
    // phase flip of rows that STILL EXIST: terminalize NEW (failed→rolled_back) and
    // re-promote the OLD `superseded` row back to `finalized`. Each step is
    // best-effort + isolated; a FAILED restore step emits a structured operational
    // event (cinatra#158 (d)). The closure returns a CLEAN-vs-PARTIAL verdict (a
    // clean rollback requires EVERY applicable step to succeed); a not-applicable
    // step (no prior source / grant / dep) is NOT a failure.
    const restoreDurableAnchor = async (): Promise<{ complete: boolean; reason?: string }> => {
      const failedSteps: string[] = [];
      const recordFailure = (step: InstallDurableRestoreFailureEvent["step"], e: unknown) => {
        failedSteps.push(step);
        emitDurableRestoreFailure(deps, {
          packageName: input.packageName,
          orgId: input.orgId,
          step,
          scope: "post-commit-rollback",
          reason: e instanceof Error ? e.message : String(e),
        });
      };
      // (i-a) re-record the OLD provenance/source so the canonical row points to OLD.
      let sourceRepinnedToOld = false;
      if (priorSource) {
        try {
          await deps.recordProvenance({
            packageName: input.packageName,
            orgId: input.orgId,
            version: priorSource.version,
            registryUrl: priorSource.registryUrl,
            integrity: priorSource.integrity,
            contentHash: priorSource.contentHash ?? "",
            ...(priorSource.attestedSha256 ? { attestedSha256: priorSource.attestedSha256 } : {}),
            ...(priorSource.signature ? { signature: priorSource.signature } : {}),
            ...(priorSource.closureHash ? { closureHash: priorSource.closureHash } : {}),
            // cinatra#792: re-pin the OLD digest (row `activeDigest` + the
            // `current` mirror; journal-digest fallback for legacy sources).
            digest: priorSource.activeDigest ?? priorOp?.digest ?? null,
            ...(input.storeRoot ? { storeRoot: input.storeRoot } : {}),
          });
          sourceRepinnedToOld = true;
        } catch (e) {
          recordFailure("provenance", e);
        }
      }
      // (i-a2) RESTORE THE OLD WIDGET-AUTH TOKEN KEYS — AFTER the OLD provenance
      // re-record (i-a) but BEFORE the journal re-pin (i-b) (owner ruling
      // 2026-07-23, codex rounds 3-4). Post-commit the anchored state starts as
      // the consistent NEW (NEW source + NEW finalized journal + NEW keys); (i-a)
      // re-points the source to OLD, which makes the row UN-ANCHORABLE (row
      // activeDigest OLD vs the still-NEW finalized journal — selectActiveDigest
      // mismatch), so restoring the keys HERE has no exposure; (i-b) then
      // re-finalizes the OLD journal, re-anchoring an OLD source + OLD keys +
      // OLD journal that all agree.
      //
      // GATED on the source re-pin SUCCEEDING (codex round-4): if (i-a) failed —
      // or there was no prior source to restore — the row still anchors the NEW
      // source, so re-pinning the OLD keys would expose NEW source + OLD keys.
      // Leaving the keys as the NEW version's (which the finalize seam wrote)
      // keeps them CONSISTENT with the still-anchored NEW source (arm (c) then
      // honors the NEW provider for a key its NEW manifest actually declares —
      // correct, not fail-open); the journal re-pin below then either makes the
      // row un-anchorable (activeDigest NEW vs journal OLD → fail-closed) or, if it
      // too fails, leaves a fully-consistent NEW anchor. When (i-a) succeeded, the
      // key restore itself FAILS CLOSED to [] on a write error (see
      // restorePriorWidgetAuthTokenKeys) so a re-anchored OLD source never pairs
      // with stale NEW keys. A captured NULL prior (legacy row) restores to [].
      if (sourceRepinnedToOld) {
        await restorePriorWidgetAuthTokenKeys(
          deps,
          { packageName: input.packageName, orgId: input.orgId, isUpdate, prior: priorWidgetAuthTokenKeys },
          (reason) => recordFailure("widget-auth-token-keys", reason),
        );
      }
      // (i-b) JOURNAL re-pin (cinatra#158): terminalize the NEW op, then re-promote
      // the OLD `superseded` op back to `finalized`. With the append-only journal the
      // OLD row was never destroyed. Re-pin OLD through the ATOMIC supersession seam
      // `finalizeInstallOp(OLD)` as a SINGLE operation: in ONE transaction it demotes
      // the CURRENT finalized op for the scope (the NEW op, finalized just above) to
      // `superseded` and promotes OLD to `finalized` (with 23505 retry). This is
      // crash-atomic (codex refute finding): there is NEVER a window with ZERO
      // finalized anchors — either the transaction commits (OLD finalized, NEW
      // superseded) or it does not (NEW stays finalized — the SAFE direction; the NEW
      // digest's bytes are quarantined/restored by the activator and the loader's
      // digest binding refuses a NEW-op-vs-OLD-source mismatch). We deliberately do
      // NOT pre-terminalize NEW (that two-step left a zero-anchor crash window).
      // NEW's terminal end-state is `superseded`, which is non-anchorable + never swept.
      try {
        await deps.finalizeInstallOp?.(priorOp!.installOpId);
      } catch (e) {
        recordFailure("journal", e);
      }
      // (i-c) restore the OLD host-port grant's exact captured state.
      if (priorGrant && deps.restoreGrant) {
        try {
          await deps.restoreGrant({
            packageName: input.packageName,
            orgId: input.orgId,
            status: priorGrant.status as "pending" | "approved" | "revoked",
            approvedPorts: priorGrant.approvedPorts,
            requestedPortsHash: priorGrant.requestedPortsHash,
            approvedBy: priorGrant.approvedBy ?? null,
          });
        } catch (e) {
          recordFailure("grant", e);
        }
      }
      // (i-c2) unwind the capability grants (ownership + widget metadata): re-pin
      // each captured OLD row; revoke/delete any NEW key/slug this attempt added —
      // so the re-pinned OLD install keeps its exact prior grant state and no
      // failed key leaks authority.
      await unwindOwnershipGrants({
        deps,
        packageName: input.packageName,
        orgId: input.orgId,
        declaredTokenKeys, widgetMetadataClaims,
        priorOwnershipGrants,
        onFailure: (e) => recordFailure("ownership-grant", e),
      });
      // (i-d) restore the OLD dependency EDGES (#180): the finalize seam above
      // persisted the NEW manifest's edges; with the OLD version re-pinned,
      // leaving them would corrupt every closure gate that reads the canonical row.
      if (priorEdges !== null && deps.persistDependencyEdges) {
        try {
          await deps.persistDependencyEdges({
            packageName: input.packageName,
            orgId: input.orgId,
            dependencies: priorEdges,
          });
        } catch (e) {
          recordFailure("dependencies", e);
        }
      }
      // (i-e) restore the OLD cached access DECLARATION (cinatra#951) — with
      // the OLD version re-pinned, the NEW declaration would corrupt the W2
      // resolver's cached scope truth (helper contract as above).
      await restorePriorAccessDeclaration(
        deps,
        { packageName: input.packageName, orgId: input.orgId, accessDeclaration, isUpdate, prior: priorAccessDeclaration },
        (reason) => recordFailure("access-declaration", reason),
      );
      return failedSteps.length === 0
        ? { complete: true }
        : { complete: false, reason: `failed restore steps: ${failedSteps.join(", ")}` };
    };

    try {
      const res = await deps.activateUpdateWithRollback({
        packageName: input.packageName,
        orgId: input.orgId,
        storeDir: mat.storeDir,
        ...(input.storeRoot ? { storeRoot: input.storeRoot } : {}),
        priorDigest: priorSource?.activeDigest ?? priorOp?.digest ?? null, // cinatra#796
        restoreDurableAnchor,
      });
      activated = res.activated;
      rolledBack = res.rolledBack ?? false;
      // On a rollback, default completeness to true ONLY when the activator
      // explicitly says so; an absent flag on a rollback is treated as INCOMPLETE
      // (fail-closed — never claim a clean rollback we cannot confirm).
      rollbackComplete = rolledBack ? res.rollbackComplete === true : true;
      activationReason = res.reason;
    } catch (err) {
      // The rollback activator itself threw (it should not — it is best-effort
      // internally). Treat as a failed-but-rolled-back update: the durable state may
      // be partially restored, but we must NOT report update success. Run the
      // durable restore directly as a last resort so OLD is re-pinned, and honor its
      // completeness verdict (a partial restore here is NOT a clean rollback).
      let lastResortComplete = false;
      try {
        const outcome = await restoreDurableAnchor();
        lastResortComplete = outcome.complete;
      } catch {
        /* already logged inside; treat as incomplete */
        lastResortComplete = false;
      }
      activated = false;
      rolledBack = true;
      rollbackComplete = lastResortComplete;
      activationReason = `update-activate-threw:${err instanceof Error ? err.message : String(err)}`;
    }
  } else if (importsNothingByKind) {
    // The package imports nothing by kind, so the in-process activator is not
    // called at all, rather than called and expected to report a non-activation.
    // The reason says WHICH fact ended the activation half — the kind, or a
    // verdict that never admitted the bytes in the first place.
    activated = false;
    activationReason = verdict.trusted
      ? "metadata-only-no-in-process-activation"
      : "untrusted-no-in-process-activation";
  } else if (deps.activateInProcess) {
    try {
      const res = await deps.activateInProcess({
        packageName: input.packageName,
        orgId: input.orgId,
        storeDir: mat.storeDir,
        ...(input.storeRoot ? { storeRoot: input.storeRoot } : {}),
      });
      activated = res.activated;
      activationReason = res.reason;
    } catch (err) {
      activated = false;
      activationReason = `activate-threw:${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return {
    packageName: input.packageName,
    version: resolvedVersion,
    storeDir: mat.storeDir,
    digest: mat.digest,
    integrity: mat.integrity,
    contentHash: mat.contentHash,
    requestedPorts,
    grantStatus,
    installed: true,
    activated,
    ...(rolledBack ? { rolledBack: true, rollbackComplete } : {}),
    ...(activationReason ? { reason: activationReason } : {}),
  };
}

// InstallPipelineDeps CONSTRUCTION (file-size ratchet): the production seam
// writer `makeDefaultInstallPipelineDeps` and the fully-wired INERT
// `makeTestInstallPipelineDeps` are extracted VERBATIM into
// `extension-install-pipeline-deps.ts` and RE-EXPORTED here, so every caller's
// import path (`@/lib/extension-install-pipeline`) stays byte-for-byte
// unchanged. Pure code motion — see that module's header for the seam contract.
export {
  makeDefaultInstallPipelineDeps,
  makeTestInstallPipelineDeps,
} from "@/lib/extension-install-pipeline-deps";
