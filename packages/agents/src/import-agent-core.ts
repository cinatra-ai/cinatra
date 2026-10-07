// No "use server" — safe to import from instrumentation.node.ts and other
// server-startup paths that run outside a request scope.
//
// Contains the auth-free core of importAgentTemplate so it can be called from:
//   1. importAgentTemplate (server action, after requireAdminSession())
//   2. ensureAgentPackage / ensureAgentPackageFromGitFile (startup, no request)

import { createHash, randomUUID } from "node:crypto";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, sep } from "node:path";
import { tmpdir } from "node:os";
import { redirect } from "next/navigation";
import {
  createAgentTemplate,
  createAgentVersion,
  updateAgentTemplate,
  updateAgentTemplateOrigin,
} from "./store";
import type { CreateAgentTemplateInput } from "./store";
// cinatra#2616 — this path claims a package-name identity too (it upserts by
// package name directly, never through installAgentFromPackage).
import {
  agentTemplateIdentityClaimOrgToRecord,
  deriveAgentTemplateIdentityClaim,
  resolveAgentTemplateIdentityClaim,
} from "./agent-template-identity";
// resolvePublishDestination is the gated loader for publish destination routing.
// resolvePublishDestination is called after auth gate in importAgentTemplate (the public
// server action); importAgentTemplateCore itself is auth-free (called from startup paths too).
// Origin is persisted after successful create/update to track package coordinates.
import { resolvePublishDestination } from "@cinatra-ai/extensions/destination-resolver";
import { readInstanceIdentity } from "@/lib/instance-identity-store";
import {
  readManifestLifecycle,
  serializeLifecycleConfig,
} from "@/lib/lifecycle/lifecycle-policy";
import { readZipFiles } from "./zip-helpers";
import { compileOasAgentJson } from "./oas-compiler";
import { serializeArtifactBindingDeclaration } from "./artifact-binding";
import {
  detectSpdxLicense,
  LicenseDetectionRejectedError,
  LicenseAcknowledgementRequiredError,
} from "@cinatra-ai/extensions/license-detection";
// cinatra#3493 — TYPE-ONLY imports of the runtime-mount collaborators. The
// modules themselves are pulled in with `await import(...)` on the
// supplied-install branch only (see `requireRuntimeMount`): this file is
// deliberately importable from `instrumentation.node.ts` and the other
// server-startup paths, and those paths must not gain the runtime mount's
// extension-data-root -> database edge just to seed an agent at boot. A type
// import is erased, so the module graph of every existing caller is unchanged.
import type { MaterializeResult } from "./materialize-agent-package";
import type { ReloadResult } from "./wayflow-reload-client";

// agent.json is a compact OAS Flow document. Per-step approval policy,
// inputSchema, outputSchema, prompt, and
// packageName are DERIVED by compileOasAgentJson() rather than read as literal
// fields. This type intentionally models only the Flow envelope consumed here.
type AgentJsonOas = {
  component_type?: "Flow";
  id?: string;
  name?: string;
  description?: string | null;
  sourceNl?: string | null;
  metadata?: {
    cinatra?: {
      type?: string; // "leaf" | "orchestrator"
      hitlScreens?: string[];
    };
  };
};

export async function importAgentTemplateCore(
  zipBase64: string,
  nameOverride?: string,
  options?: {
    redirect?: boolean;
    status?: "draft" | "published";
    /** Destination chosen via PublishDestinationPicker; callers use it to call
     *  resolvePublishDestination(destination) before registering. */
    destination?: "private" | "public";
    /** Set true after user acknowledges LicenseWarningDialog for copyleft.
     *  The server re-validates this flag before registering the template. */
    licenseAcknowledged?: boolean;
    /** User id of the import actor. Set as the new agent template's creator_id
     *  so per-template ownership checks have a starting point. Undefined for
     *  legacy callers (back-compat). */
    creatorId?: string;
    /** Does this ZIP's `package.json` carry the AUTHOR's lifecycle declaration?
     *  (cinatra#2044 GAP 2 — codex round 1.)
     *
     *  Defaults TRUE, which is right for every user-uploaded ZIP: that
     *  `package.json` IS the author's manifest, so a MISSING `cinatra.lifecycle`
     *  in it means "the author dropped the block" and is projected as an
     *  explicit clear.
     *
     *  `ensureAgentPackageFromGitFile` SYNTHESIZES the ZIP's `package.json`
     *  (identity plus whatever it copied off the sibling manifest), so for that
     *  caller the same absence is ambiguous — it means "the author dropped the
     *  block" only when a sibling manifest was actually READ. With no sibling on
     *  disk the loader has no declaration to speak for, and projecting its own
     *  hollow synthesis as an explicit clear would WIPE a correct
     *  `lifecycle_config` off an installed row (e.g. one the registry path wrote)
     *  on the next boot scan. It passes false in that case and the absence
     *  degrades to `undefined` — leave the column exactly as it is. */
    lifecycleDeclarationAuthoritative?: boolean;
    /** The organization that OWNS the template this import creates
     *  (cinatra#2619). Threaded to `createAgentTemplate`, where
     *  `withDeterminateInstallScope` turns it into the canonical determinate
     *  anchor (`org_id` + `owner_level='organization'` + `owner_id=<org>`).
     *
     *  Undefined means "no owning org is resolvable" — a genuinely org-less
     *  instance (nothing has been set up yet), or an instance with SEVERAL orgs
     *  where an instance-wide bundled agent has no determinate owner. The row is
     *  then born ownerless exactly as before and the boot/org-bootstrap
     *  reconcile picks it up once an owner IS determinate. Never guessed here.
     *
     *  This is the going-forward half of #2619: with it, a seed written on an
     *  instance that already has its organization is never damaged in the first
     *  place, so the reconcile only ever has pre-existing rows to heal. */
    orgId?: string;
    /** cinatra#2616: the organization on whose behalf this import runs — the
     *  IDENTITY CLAIMANT for the package name it writes. This path never rode
     *  `installAgentFromPackage`; it reads by package name and calls
     *  `updateAgentTemplate` directly, so it was a second, unguarded route to
     *  the same takeover. The authenticated ZIP-import action threads its
     *  session's active organization; boot seeding has none and claims as the
     *  instance operator. Defaults to `orgId` when omitted. */
    claimantOrgId?: string | null;
    /** cinatra#3493 — mark this import as a SUPPLIED INSTALL: a package a
     *  person uploaded through the import screen's File tab (or `agent_import`),
     *  which must be RUNNABLE the moment the screen says it is installed.
     *
     *  This path used to write the template row and report success while
     *  writing NOTHING to the agent runtime mount — it never called
     *  `materializeAgentPackageToDisk` and never called `triggerWayflowReload`.
     *  On a production instance the runtime therefore mounted nothing, the
     *  agent card answered 404 and the run could not start, while the screen
     *  reported "installed and published".
     *
     *  With this flag the import MATERIALIZES the uploaded package under
     *  `<extension-data-root>/.agent-mount/<vendor>/<slug>/` — the deploy-owned
     *  tree every runtime reader scans — BEFORE the template row is written,
     *  RELOADS the runtime after the row commits, and REFUSES to report success
     *  when either step leaves the agent unmounted.
     *
     *  The startup seeding callers (`ensureAgentPackage`,
     *  `ensureAgentPackageFromGitFile`) leave it unset and are byte-identical to
     *  before: they run before the runtime is necessarily reachable, and the
     *  `agent-mount-projection` boot phase owns their projection. */
    requireRuntimeMount?: boolean;
  },
): Promise<{ templateId: string; upserted: boolean }> {
  // cinatra#2616 — WHO is claiming the package name this import writes.
  const claim = deriveAgentTemplateIdentityClaim({
    claimantOrgId: options?.claimantOrgId ?? null,
    orgId: options?.orgId ?? null,
  });
  // …and the org that claim RECORDS on the row. A refusal predicate alone is
  // not a claim: the authenticated import action supplies `claimantOrgId` but
  // no `orgId`, so without this an import would leave the name `org_id NULL` —
  // still UNCLAIMED, and the next organization's import would take it. Same
  // treatment as the install path, on BOTH branches (fresh create and the
  // adoption of an org-less row). `options.orgId`, when the caller supplies it,
  // still wins verbatim.
  const effectiveOrgId =
    options?.orgId ?? agentTemplateIdentityClaimOrgToRecord(claim, options?.orgId);
  const zipBuf = Buffer.from(zipBase64, "base64");
  const files = readZipFiles(zipBuf);

  const agentRaw = files.get("agent.json");
  if (!agentRaw) throw new Error("Invalid archive: agent.json not found.");

  const manifestRaw = files.get("manifest.json");
  if (manifestRaw) {
    const m = JSON.parse(manifestRaw) as { version?: number };
    if (m.version !== 1) throw new Error(`Unsupported manifest version: ${m.version}`);
  }

  const agent = JSON.parse(agentRaw) as AgentJsonOas;
  const importedName = nameOverride?.trim() || agent.name || "Imported Agent";

  // Compile the OAS Flow to derive DB column values.
  // The compiler reads the agent.json via a temp-dir fixture (callers already
  // resolved the ZIP into base64). To avoid re-serializing, we write the ZIP
  // contents to a tmp agents/<slug>/cinatra/agent.json path and let the compiler
  // resolve via packageName.
  // The ZIP payload does NOT carry the sibling package.json; we need to derive
  // packageName/packageVersion some other way. Search the ZIP for a package.json.
  const siblingPkgRaw = files.get("package.json");
  let siblingPkgName: string | null = null;
  let siblingPkgVersion: string | null = null;
  let siblingAgentDependencies: Record<string, string> | undefined;
  // The compiled `cinatra.lifecycle` declaration this ZIP's manifest carries
  // (cinatra#2044 GAP 2 / the loader-path half of cinatra#2047 D-1).
  //
  // `undefined` and `null` are DIFFERENT here, and the difference is the whole
  // contract:
  //   - `undefined` = this ZIP carries NO manifest at all (no `package.json` —
  //     an explicitly OPTIONAL member of the agent-ZIP shape, see the format
  //     contract in import-export-actions.ts). There is nothing to project, so
  //     the column is left UNCHANGED (the patch field is omitted).
  //   - `null` = the ZIP DOES carry a manifest and that manifest declares no
  //     (or a malformed) lifecycle block. The declaration is then re-projected
  //     EXPLICITLY as null so a version that DROPS the block CLEARS the column
  //     instead of leaving a stale `repairCapable` routing repairs to a producer
  //     that no longer claims the capability — the same explicit-clear rule
  //     `installAgentFromPackage` applies on all three of its install branches
  //     (install-from-package.ts:491/596/632). An import re-projects every other
  //     compiled column off the uploaded package the same way.
  let manifestLifecycleConfig: string | null | undefined;
  if (siblingPkgRaw) {
    try {
      const parsed = JSON.parse(siblingPkgRaw) as {
        name?: string;
        version?: string;
        cinatra?: { agentDependencies?: Record<string, string> };
      };
      siblingPkgName = typeof parsed.name === "string" ? parsed.name : null;
      siblingPkgVersion = typeof parsed.version === "string" ? parsed.version : null;
      siblingAgentDependencies = parsed.cinatra?.agentDependencies;
      // readManifestLifecycle is the fail-soft reader ("quietly empty on bad
      // input, never throws"), so a hostile/legacy manifest can never crash an
      // import — it simply declares nothing.
      manifestLifecycleConfig = serializeLifecycleConfig(readManifestLifecycle(parsed));
      // …but "declares nothing" is only an authoritative CLEAR when this
      // `package.json` is the author's manifest. A caller that SYNTHESIZED it
      // without an author manifest to read (the git-file loader with no sibling
      // on disk) opts out, and the absence degrades to "leave the column
      // unchanged". A block that IS present still lands normally.
      if (
        manifestLifecycleConfig === null &&
        options?.lifecycleDeclarationAuthoritative === false
      ) {
        manifestLifecycleConfig = undefined;
      }
    } catch {
      // Malformed package.json — treated as no manifest at all (the identity
      // fields below already fall through this way), so the column is left
      // unchanged rather than cleared off unparseable input.
    }
  }

  // Stage a temp directory so the compiler's filesystem-based resolution works.
  // Layout: <tmp>/agents/<slug>/cinatra/agent.json + <tmp>/agents/<slug>/package.json
  const slug = siblingPkgName ? siblingPkgName.split("/").pop() ?? "imported" : "imported";
  const tmpRoot = join(tmpdir(), `oas-import-${randomUUID()}`);
  const cinatraDir = join(tmpRoot, "agents", slug, "cinatra");
  await mkdir(cinatraDir, { recursive: true });
  // cinatra#3493 — the staged document is named `cinatra/oas.json`, THE one
  // name the runtime mount is keyed by: `installed-oas-path.ts` resolves
  // `<root>/<vendor>/<slug>/cinatra/oas.json` and deliberately offers no
  // `agent.json` fallback, and `materializeAgentPackageToDisk` refuses a source
  // directory that lacks it. The compiler is handed this path explicitly, so it
  // reads exactly the bytes it always did; the rename is what lets this very
  // staging directory be materialized into the mount below.
  const tmpOasJson = join(cinatraDir, "oas.json");
  await writeFile(tmpOasJson, agentRaw, "utf8");
  if (siblingPkgRaw) {
    await writeFile(join(tmpRoot, "agents", slug, "package.json"), siblingPkgRaw, "utf8");
  }
  // cinatra#3493 (convergence round 1) — stage the archive's REMAINING members
  // at their own relative paths. The materializer copies an allowlist out of
  // this directory (`cinatra/` whole, `skills/`, README, NOTICE, the declared
  // logo — materialize-agent-package.ts `_copyRuntimeFiles`) and atomically
  // REPLACES the mounted directory with the result, so anything the archive
  // carried that was never staged here would simply be absent from the mount.
  // Staging only `agent.json` + `package.json` would have materialized a
  // three-file reduction of the uploaded package. Entries whose path escapes
  // the package directory are refused rather than written.
  const stagedAgentRoot = join(tmpRoot, "agents", slug);
  for (const [entryName, entryContent] of files) {
    if (entryName === "agent.json" || entryName === "package.json") continue;
    if (entryName.endsWith("/")) continue;
    const stagedPath = join(stagedAgentRoot, entryName);
    if (isAbsolute(entryName) || !stagedPath.startsWith(stagedAgentRoot + sep)) {
      await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
      throw new Error(
        `Invalid archive: entry ${JSON.stringify(entryName)} escapes the package directory.`,
      );
    }
    await mkdir(dirname(stagedPath), { recursive: true });
    await writeFile(stagedPath, entryContent, "utf8");
  }

  // SPDX license detection gate.
  // Write any LICENSE / LICENSE.md / COPYING / .spdx files from the ZIP into the
  // temp agent dir so detectSpdxLicense can find them alongside package.json.
  // Runs BEFORE compile so detection failures abort early. The server
  // re-validates licenseAcknowledged flag here; client cannot bypass the modal.
  const tmpAgentDir = join(tmpRoot, "agents", slug);
  for (const licenseFile of ["LICENSE", "LICENSE.md", "COPYING", ".spdx"]) {
    const licenseContent = files.get(licenseFile);
    if (licenseContent) {
      await writeFile(join(tmpAgentDir, licenseFile), licenseContent, "utf8");
    }
  }
  const licenseResult = await detectSpdxLicense(tmpAgentDir);
  if (licenseResult.tier === "reject") {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    throw new LicenseDetectionRejectedError(licenseResult.reason);
  }
  if (licenseResult.tier === "copyleft" && !options?.licenseAcknowledged) {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    throw new LicenseAcknowledgementRequiredError(licenseResult.spdxId);
  }

  let compiled;
  try {
    const compileResult = await compileOasAgentJson({
      packageName:
        siblingPkgName ??
        `@cinatra-ai/${slug.endsWith("-agent") ? slug : `${slug}-agent`}`,
      oasSourcePath: tmpOasJson,
    });
    if (!compileResult.ok) {
      throw new Error(
        `failed to compile OAS agent.json for ${siblingPkgName ?? slug}: ${compileResult.error}`,
      );
    }
    compiled = compileResult.value;
  } catch (compileErr) {
    // cinatra#3493 — the staging directory used to be removed on EVERY compile
    // outcome, which is precisely why there was never anything left to
    // materialize. It now survives a SUCCESSFUL compile and is cleaned up by
    // the `finally` of the transaction below, once the runtime files have been
    // copied out of it.
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    throw compileErr;
  }

  // Install-time dynamic object-type minting is RETIRED (cinatra#1788, epic
  // #1785): agent packages no longer register `active` types from OAS output
  // annotations. Typed output exists only by installing the artifact-kind
  // extension that CLAIMS the type; the typed-production contract (publish gate
  // + install preflight) enforces that the required artifact-kind closure
  // provides every `cinatra.produces` type, fail-closed, before any write.

  // taskSpec DB shape is `taskSpec: string | null` (store.ts:58). We narrow
  // compiled.prompt (string | null) into the same shape.
  const effectivePrompt: string | null = compiled.prompt;
  const effectivePackageName = compiled.packageName ?? siblingPkgName;
  const effectivePackageVersion = compiled.packageVersion ?? siblingPkgVersion;
  const effectiveAgentDeps = {
    ...(siblingAgentDependencies ?? {}),
    ...compiled.agentDependencies,
  };
  const effectiveType = compiled.type;

  // cinatra#3493 — the supplied-install transaction state. `materializeResult`
  // stays null on every other caller, and every branch below is then exactly
  // what it was.
  const requireRuntimeMount = options?.requireRuntimeMount === true;
  let materializeResult: MaterializeResult | null = null;
  let materializeCommitted = false;

  /** cinatra#3493 — the LAST durable step of a supplied install: finalize the
   *  materialize (drop the prior-version backup) and tell the runtime to mount
   *  what was just written, then REFUSE to report success unless the runtime
   *  actually mounted it. Every other install road in this repository reloads
   *  here too — after the durable writes, exactly once per operation
   *  (`wayflow-reload-client.ts`'s caller contract). The difference is that
   *  those roads report a failed reload as `installed_pending_reload`; a person
   *  who just uploaded an archive gets an honest failure instead, because an
   *  unmounted agent is not an installed one. */
  const finalizeRuntimeMount = async (): Promise<void> => {
    if (!materializeResult || !materializeResult.materialized) return;
    const { triggerWayflowReload } = await import("./wayflow-reload-client");
    const reload = await triggerWayflowReload();
    const unmounted = runtimeMountFailureReason(
      reload,
      effectivePackageName,
      materializeResult.wasReinstall,
    );
    if (unmounted) {
      // cinatra#3493 (convergence round 1) — the reload verdict is read BEFORE
      // the materialize is committed. Committing first dropped the prior
      // version's backup, so a RE-import whose reload failed left the new files
      // on disk with no way back to the version the runtime is still serving.
      // Throwing here with the commit NOT taken lets the catch below restore
      // exactly what the mount held before this import.
      throw new Error(
        `[importAgentTemplateCore] '${effectivePackageName}' was written to the agent runtime ` +
          `mount, but the runtime did not mount it (${unmounted}). The agent is NOT installed and ` +
          "cannot run — upload the archive again once the runtime is reachable.",
      );
    }
    const { commitMaterialize } = await import("./materialize-agent-package");
    await commitMaterialize(materializeResult);
    materializeCommitted = true;
  };

  /** cinatra#3493 (convergence round 1) — write the uploaded package into the
   *  agent runtime mount.
   *
   *  Called AFTER the package name's identity claim has been resolved and
   *  BEFORE the first durable write of either branch.
   *  `resolveAgentTemplateIdentityClaim` refuses a name held by another
   *  organization by THROWING, and agent-template-identity.ts states the
   *  doctrine that refusal must land in the INERT window — before the disk
   *  materialize. Materializing ahead of it would let an upload from another
   *  organization replace an owned package's runtime files (and a concurrent
   *  reload mount those bytes) before the refusal, with a rollback that cannot
   *  unmount them again.
   *
   *  Idempotent: the second call on a path that already materialized is a
   *  no-op. */
  const ensureRuntimeMaterialized = async (): Promise<void> => {
    if (!requireRuntimeMount || materializeResult) return;
    if (!effectivePackageName) return;
    const { materializeAgentPackageToDisk } = await import("./materialize-agent-package");
    const { resolveAgentRuntimeMountDir } = await import("./agent-runtime-mount");
    materializeResult = await materializeAgentPackageToDisk({
      extractedTempDir: tmpAgentDir,
      packageName: effectivePackageName,
      agentInstallDir: resolveAgentRuntimeMountDir(),
    });
    if (!materializeResult.materialized) {
      throw new Error(
        `[importAgentTemplateCore] '${effectivePackageName}' could not be materialized under the ` +
          `agent runtime mount (${materializeResult.reason}), so the runtime could never mount it. ` +
          "The agent is NOT installed.",
      );
    }
  };

  try {
    // cinatra#3493 — MATERIALIZE BEFORE THE DB WRITE, the same ordering
    // `installAgentFromPackage` uses (install-from-package.ts): the runtime
    // files are the prerequisite for the reload, and a refusal here mutates
    // nothing, so a package that can never be mounted leaves no row behind
    // claiming it was installed. On a DB failure the catch below rolls the
    // materialize back; on success `finalizeRuntimeMount` commits it.
    //
    // This does NOT go through `resolvePublishDestination` /
    // `loadDeploymentRegistryConfig`: a LOCAL upload writes its own runtime
    // files and needs no registry identity to do it, so the loader's
    // fail-closed throw on a production build without registry env is not on
    // this road's critical path at all. The origin-persistence block further
    // down still calls the resolver and still degrades to a warning — that is
    // best-effort package-coordinate METADATA, and nothing about the install
    // reads through it.
    if (requireRuntimeMount && !effectivePackageName) {
      // Inert refusal: nothing has been written yet, and a package with no
      // `@vendor/slug` name has no mount path the runtime could ever read.
      throw new Error(
        "[importAgentTemplateCore] this archive declares no package name, so it could not be " +
          "materialized under the agent runtime mount and the runtime could never mount it. Add a " +
          "`package.json` carrying a scoped `@vendor/slug` name to the archive and upload it again.",
      );
    }

    // --- Upsert path: if packageName is present, check for an existing template ---
    if (effectivePackageName) {
      // cinatra#2616 — resolve the claim instead of a bare name lookup: a name
      // held by another organization REFUSES here rather than being adopted.
      const resolved = await resolveAgentTemplateIdentityClaim({
        packageName: effectivePackageName,
        claim,
      });
      const existing = resolved.outcome === "owned" ? resolved.row : null;
      if (existing) {
        // The claim rides the WRITE — the authoritative guard, as on the
        // install path.
        // cinatra#3493 — the claim above resolved; the runtime files go in
        // before the first durable write of this branch.
        await ensureRuntimeMaterialized();

        const updated = await updateAgentTemplate(existing.id, {
          name: importedName,
          // compiledPlan is always [] for OAS flows — never overwrite existing DB value.
          compiledPlan: undefined,
          inputSchema: compiled.inputSchema as CreateAgentTemplateInput["inputSchema"],
          outputSchema: (compiled.outputSchema ?? undefined) as CreateAgentTemplateInput["outputSchema"] | undefined,
          approvalPolicy: compiled.approvalPolicy as CreateAgentTemplateInput["approvalPolicy"],
          // taskSpec DB column sources from Agent.system_prompt via the compiler.
          taskSpec: effectivePrompt ?? undefined,
          description: agent.description ?? undefined,
          sourceNl: agent.sourceNl ?? "",
          packageVersion: effectivePackageVersion ?? undefined,
          hitlScreens: compiled.hitlScreens,
          status: options?.status,
          type: effectiveType === "orchestrator" ? "orchestrator" : "leaf",
          agentDependencies:
            Object.keys(effectiveAgentDeps).length > 0 ? effectiveAgentDeps : undefined,
          // cinatra#2044 GAP 2: re-project the manifest LIFECYCLE declaration on
          // re-import, exactly as installAgentFromPackage's upsert branch does.
          // `undefined` (manifest-less ZIP) leaves the column untouched;
          // an explicit null clears a dropped block. See the derivation above.
          lifecycleConfig: manifestLifecycleConfig,
          // cinatra#2498: re-project the OAS compiler's own binding-presence
          // result on re-import, exactly as installAgentFromPackage's upsert
          // branch does.
          hasArtifactBindings: compiled.hasArtifactBindings,
          // cinatra#3208: and the DECLARATION that presence flag is about, from
          // the same compile, in the same patch as packageVersion. The two move
          // together or the row contradicts itself — claiming bindings exist
          // while offering no way to read the ones THIS version compiled, which
          // reads as "unknown" and sends run completion back to the registry
          // re-read #3208 removes. `null` is a real compile result here (no
          // readable sibling manifest), not "leave unchanged": it is exactly the
          // case where `hasArtifactBindings` is false too.
          //
          // Written ONLY when this import carries a package VERSION to pair the
          // declaration with. `packageVersion` above is `effectivePackageVersion
          // ?? undefined`, so a re-import with no version (package.json absent,
          // or present without a `version`) deliberately LEAVES the existing
          // version in place; writing this compile's declaration beside an
          // unchanged version would pair a NEW declaration with an OLD pin, and
          // the materializer's guard compares only the version — it would hand a
          // run pinned to that old version a declaration it never executed,
          // which is the two-authority defect #3208 removes, reintroduced in
          // miniature. With no version to confirm against the declaration is
          // OMITTED and the column keeps whatever the last version-paired write
          // set, exactly as the MCP recompile writer already does.
          artifactBindings:
            effectivePackageVersion === undefined || effectivePackageVersion === null
              ? undefined
              : compiled.artifactBindings
                ? serializeArtifactBindingDeclaration(compiled.artifactBindings)
                : null,
          // cinatra#2616 — RECORD the claim when adopting an org-less row, so the
          // name does not stay up for grabs.
          orgId: effectiveOrgId,
        }, claim);
        // A null result is a REFUSAL, not a shrug — never write a version after
        // one (cinatra#2616).
        if (!updated) {
          throw new Error(
            `[importAgentTemplateCore] the identity claim on '${effectivePackageName}' could not ` +
              "be applied — the template row moved or was removed mid-import. Retry the import.",
          );
        }

        const snapshotObj = {
          compiledPlan: [],
          inputSchema: compiled.inputSchema,
          taskSpec: effectivePrompt,
        };
        await createAgentVersion({
          id: randomUUID(),
          templateId: existing.id,
          contentHash: createHash("sha256").update(JSON.stringify(snapshotObj)).digest("hex"),
          snapshot: snapshotObj as Record<string, unknown>,
        });

        // Persist origin coordinates after successful upsert.
        // Skips if no packageName (startup ensureAgentPackage paths may omit it).
        if (effectivePackageName && options?.destination) {
          try {
            const zipIdentity = readInstanceIdentity();
            const zipVendorName = zipIdentity
              ? ((zipIdentity as { vendorName?: string; instanceNamespace?: string }).vendorName ??
                 (zipIdentity as { vendorName?: string; instanceNamespace?: string }).instanceNamespace)
              : undefined;
            const zipScope = zipVendorName ? `@${zipVendorName}` : "@cinatra-ai";
            const zipConfig = await resolvePublishDestination(options.destination);
            await updateAgentTemplateOrigin(effectivePackageName, {
              packageName: effectivePackageName,
              version: effectivePackageVersion ?? "0.0.0",
              destinationId: options.destination === "private"
                ? (zipConfig as { destinationId?: string }).destinationId ?? null
                : null,
              scope: zipScope,
              visibility: options.destination,
              registryUrl: zipConfig.registryUrl,
              importedFrom: { source: "zip", updatePolicy: "manual" },
            }, claim);
          } catch (originErr) {
            console.warn("[importAgentTemplateCore:upsert] Origin persistence failed:", originErr);
          }
        }

        // cinatra#3493 — mount and reload before this import can claim success.
        await finalizeRuntimeMount();

        if (options?.redirect !== false) {
          redirect("/agents");
        }
        return { templateId: existing.id, upserted: true };
      }
    }

    // --- Create path ---
    const newId = randomUUID();

    // cinatra#3493 — the claim (when this archive carries a package name) was
    // resolved above; the runtime files go in before the first durable write of
    // this branch.
    await ensureRuntimeMaterialized();

    await createAgentTemplate({
      id: newId,
      // cinatra#2619: the owning org, when the caller could resolve one. Omitted
      // (undefined) leaves the row ownerless exactly as before —
      // `withDeterminateInstallScope` early-returns on a missing orgId and
      // stamps nothing, so no scope is ever guessed at write time.
      // cinatra#2616 — the RECORDED claim (options.orgId when the caller
      // supplies one, else the claimant). Omitted only for a genuinely
      // organization-less import (boot seeding on an un-set-up instance).
      ...(effectiveOrgId ? { orgId: effectiveOrgId } : {}),
      name: importedName,
      description: agent.description ?? undefined,
      sourceNl: agent.sourceNl ?? "",
      compiledPlan: [] as CreateAgentTemplateInput["compiledPlan"],
      inputSchema: compiled.inputSchema as CreateAgentTemplateInput["inputSchema"],
      outputSchema: (compiled.outputSchema ?? undefined) as CreateAgentTemplateInput["outputSchema"] | undefined,
      approvalPolicy: compiled.approvalPolicy as CreateAgentTemplateInput["approvalPolicy"],
      taskSpec: effectivePrompt ?? undefined,
      packageName: effectivePackageName ?? undefined,
      packageVersion: effectivePackageVersion ?? undefined,
      hitlScreens: compiled.hitlScreens,
      // Thread the import actor's userId so the new
      // template row gets its creator_id populated. Falls through to NULL on
      // legacy callers (e.g. internal MCP-initiated installs that don't
      // resolve a session user).
      creatorId: options?.creatorId,
      agentDependencies:
        Object.keys(effectiveAgentDeps).length > 0 ? effectiveAgentDeps : undefined,
      type: effectiveType === "orchestrator" ? "orchestrator" : "leaf",
      status: options?.status ?? "draft",
      // cinatra#2044 GAP 2: the manifest LIFECYCLE declaration rides the fresh
      // create too, so a first install through the loader/ZIP path lands the
      // same column value a registry install does (createAgentTemplate
      // normalizes undefined to NULL — there is no prior value to preserve).
      lifecycleConfig: manifestLifecycleConfig,
      // cinatra#2498: the OAS compiler's own binding-presence result rides
      // the fresh create too, for the same reason.
      hasArtifactBindings: compiled.hasArtifactBindings,
      // cinatra#3208: the executed declaration rides the fresh create too, so a
      // first install through the loader / ZIP path (dev-boot git-file scan,
      // hot-reload watcher, `cinatra setup`, the data/downloads system-agent
      // path, the UI and MCP ZIP imports) lands the same column value a registry
      // install does, and run completion resolves the declaration the run
      // executed instead of re-reading the registry.
      artifactBindings: compiled.artifactBindings
        ? serializeArtifactBindingDeclaration(compiled.artifactBindings)
        : null,
    });

    const snapshotObj = {
      compiledPlan: [],
      inputSchema: compiled.inputSchema,
      taskSpec: effectivePrompt,
    };
    await createAgentVersion({
      id: randomUUID(),
      templateId: newId,
      contentHash: createHash("sha256").update(JSON.stringify(snapshotObj)).digest("hex"),
      snapshot: snapshotObj as Record<string, unknown>,
    });

    // Persist origin coordinates after successful create.
    // Skips if no packageName (startup ensureAgentPackage paths may omit it).
    if (effectivePackageName && options?.destination) {
      try {
        const createIdentity = readInstanceIdentity();
        const createVendorName = createIdentity
          ? ((createIdentity as { vendorName?: string; instanceNamespace?: string }).vendorName ??
             (createIdentity as { vendorName?: string; instanceNamespace?: string }).instanceNamespace)
          : undefined;
        const createScope = createVendorName ? `@${createVendorName}` : "@cinatra-ai";
        const createConfig = await resolvePublishDestination(options.destination);
        await updateAgentTemplateOrigin(effectivePackageName, {
          packageName: effectivePackageName,
          version: effectivePackageVersion ?? "0.0.0",
          destinationId: options.destination === "private"
            ? (createConfig as { destinationId?: string }).destinationId ?? null
            : null,
          scope: createScope,
          visibility: options.destination,
          registryUrl: createConfig.registryUrl,
          importedFrom: { source: "zip", updatePolicy: "manual" },
        }, claim);
      } catch (originErr) {
        console.warn("[importAgentTemplateCore:create] Origin persistence failed:", originErr);
      }
    }

    // cinatra#3493 — mount and reload before this import can claim success.
    await finalizeRuntimeMount();

    if (options?.redirect !== false) {
      redirect("/agents");
    }
    return { templateId: newId, upserted: false };
  } catch (err: unknown) {
    // cinatra#3493 — a failure anywhere after the materialize would leave the
    // runtime mount holding files no template row points at, so roll it back
    // (restoring any prior version) unless the install already committed.
    // `redirect()` raises its own control-flow error from INSIDE this block on
    // the success path, which is exactly why the guard is the commit flag and
    // not the presence of an error.
    if (materializeResult && !materializeCommitted) {
      const { rollbackMaterialize } = await import("./materialize-agent-package");
      await rollbackMaterialize(materializeResult);
    }
    if (
      err instanceof Error &&
      err.message.includes("agent_templates_package_name_idx")
    ) {
      throw new Error(
        `Package name "${effectivePackageName}" is already registered. Use a different package name or update the existing template.`,
      );
    }
    throw err;
  } finally {
    // cinatra#3493 — the staging directory the compiler read and the
    // materializer copied out of. Removed on every outcome, including the
    // `redirect()` control-flow throw.
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * cinatra#3493 — did a runtime reload leave THIS package unmounted?
 *
 * The reload report (docker/wayflow/agent_loader.py) carries what CHANGED —
 * `added` / `changed` / `removed` / `failed`, each label `<vendor>/<slug>` —
 * plus `agents`, the total the runtime has mounted. It does NOT enumerate the
 * labels that were already mounted and unchanged, so a re-import of an
 * identical package is named by neither `added` nor `changed`. This predicate
 * therefore reports only what it can actually SEE to be a failure and never
 * guesses at the rest:
 *
 *   - the reload did not happen at all (no runtime configured, HTTP, timeout,
 *     network) — nothing confirms a mount;
 *   - the runtime tried this very label and FAILED it;
 *   - the runtime finished with ZERO agents mounted — the symptom measured on
 *     the instance in #3493 — so this one is certainly not among them.
 *
 * Returns the reason to report to the person, or null when the runtime reports
 * the package as mounted.
 */
function runtimeMountFailureReason(
  reload: ReloadResult,
  packageName: string | null,
  wasReinstall: boolean,
): string | null {
  if (!reload.ok) {
    return `the runtime reload did not succeed: ${reload.reason}${
      reload.detail ? ` — ${reload.detail}` : ""
    }`;
  }
  // The mount label is the package name without its leading `@`: the mount is
  // `<mount>/<vendor>/<slug>` and the loader labels it `<vendor>/<slug>`.
  const label = packageName?.startsWith("@") ? packageName.slice(1) : packageName;
  const failedHere = label
    ? reload.report.failed.find((entry) => entry.label === label)
    : undefined;
  if (failedHere) {
    return `the runtime refused to mount ${label}: ${failedHere.error}`;
  }
  if (label && reload.report.removed.includes(label)) {
    return `the runtime UNMOUNTED ${label} on this reload`;
  }
  if (reload.report.agents === 0) {
    return "the runtime reports 0 mounted agents";
  }
  // cinatra#3493 (convergence round 1) — POSITIVE confirmation where the report
  // can give it. A FRESH mount (nothing was there before this import) is new to
  // the runtime, so the loader must name it in `added`; a non-zero total that
  // never names this label means the runtime is serving OTHER agents and not
  // this one — the aggregate count alone proves nothing about this package. A
  // RE-install cannot be held to that bar: the report enumerates what changed,
  // and a re-import of byte-identical content is named by neither `added` nor
  // `changed`, so there the checks above are all the report can support.
  if (!wasReinstall && label && !reload.report.added.includes(label)) {
    return `the runtime did not report ${label} among the agents it mounted`;
  }
  return null;
}
