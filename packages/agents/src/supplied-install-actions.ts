"use server";

// ---------------------------------------------------------------------------
// supplied-install-actions.ts — the Upload screen's SERVER boundary
// (cinatra#3204 leg 3, criteria 9-15, 17-22).
//
// Both tabs submit here, and everything that decides anything happens on this
// side of the wire:
//
//   - the archive is RE-READ from the bytes (the browser's parse is a preview,
//     never evidence): the kind, the identity and the digest are resolved again;
//   - the chosen scope is VALIDATED and AUTHORIZED server-side through the same
//     `assertCanInstallAtTarget` the store road uses — a target the actor lacks
//     authority for is refused even when the client sends it;
//   - an ABSENT scope is refused fail-closed for every one of the four kinds
//     (the supplied road's recorded decision — see
//     @cinatra-ai/extensions/supplied-install-access);
//   - the chosen target becomes the canonical row ANCHOR through
//     `resolveInstallAccessTargetContract`, and the AUDIENCE half is persisted
//     through `setExtensionInstallAccess`, FAIL-CLOSED: a failed access write
//     rolls a FRESH install back rather than leaving the package at the broader
//     default. This replaces the old non-fatal upload-time policy write.
//
// The install itself is `extensionRegistry.install` — the same dispatcher the
// store road calls. There is no second installer on this road.
// ---------------------------------------------------------------------------

import { requireAdminSession } from "@/lib/auth-session";
import {
  InstallAccessTargetSchema,
  resolveInstallAccessTargetContract,
  isWorkspaceRowAnchor,
  type InstallAccessTarget,
} from "@cinatra-ai/extensions/install-access-target";
import {
  assertSuppliedInstallAccessTarget,
  resolveSuppliedInstallAccessResource,
} from "@cinatra-ai/extensions/supplied-install-access";
import type { SuppliedPackageKind } from "@cinatra-ai/extension-types";
import { adminFacingSuppliedInstallRefusal } from "./supplied-install-refusal-copy";

// ---------------------------------------------------------------------------
// Result shapes. Deliberately serializable and message-only: a thrown message is
// masked in production, so a refusal the operator must act on travels as data.
// ---------------------------------------------------------------------------

export type SuppliedInstallObservable = {
  /** What to look at to see that this kind actually landed (criterion 21). */
  label: string;
  href: string;
};

/**
 * The Anthropic upload-consent confirmation for a SKILL package (cinatra#2092),
 * carried on the preview so the screen shows the closure and the data-egress
 * advisory BEFORE anything is installed.
 *
 * THE ISSUE'S RECORDED DECISION, honoured here: "the upload-consent contract the
 * repository road already honours applies unchanged on both roads: consent is an
 * explicit act, never inferred from supplying a package." This leg replaces
 * `installGitHubSkillExtension` as the repository road's install call, so the
 * contract is honoured at THIS boundary or it is honoured nowhere.
 *
 * `consentApplies: false` means the workspace opt-in is OFF — nothing can egress,
 * so the screen says that instead of asking a question with no consequence.
 */
export type SuppliedUploadConsentPrompt = {
  headline: string;
  advisory: string;
  closureLines: string[];
  closureDigest: string;
  consentApplies: boolean;
};

/** The RECORDED outcome of that contract, always reported, never silent. */
export type SuppliedUploadConsentOutcome = {
  granted: boolean;
  reason: string;
  outcome: string;
};

export type SuppliedPackagePreview = {
  kind: SuppliedPackageKind;
  packageName: string;
  version: string;
  contentDigest: string;
  /** Repository road only: the immutable commit the ref was pinned to. */
  resolvedSha?: string;
  repo?: string;
  ref?: string;
  /** Skill packages only — the upload-consent confirmation to show first. */
  consentPrompt?: SuppliedUploadConsentPrompt;
};

export type SuppliedInstallResult =
  | {
      ok: true;
      kind: SuppliedPackageKind;
      packageName: string;
      version: string;
      observable: SuppliedInstallObservable;
      /** Skill installs only: what the upload-consent contract decided. */
      uploadConsent?: SuppliedUploadConsentOutcome;
      /** Non-fatal notices; the install itself succeeded. */
      warnings?: string[];
    }
  | {
      ok: false;
      error: string;
      stage?: "access" | "access-partial" | "requires-rebuild";
    };

export type SuppliedPreviewResult =
  | { ok: true; preview: SuppliedPackagePreview }
  | { ok: false; error: string };

/**
 * The GitHub tab's PRECONDITION, stated rather than surfaced as a raw capability
 * refusal (criterion 9). The two failure states are genuinely different and the
 * operator fixes them in different places.
 */
export type GitHubUploadPrecondition =
  | { state: "ready" }
  | { state: "no-connector"; message: string; fixHref: string; fixLabel: string }
  | { state: "no-connection"; message: string; fixHref: string; fixLabel: string };

// ---------------------------------------------------------------------------
// Per-kind observable (criterion 21)
// ---------------------------------------------------------------------------

const KIND_OBSERVABLE: Record<SuppliedPackageKind, SuppliedInstallObservable> = {
  agent: { label: "See it in the agents list", href: "/agents" },
  skill: { label: "See it in the skills catalog", href: "/skills" },
  artifact: { label: "See it in installed extensions", href: "/configuration/extensions" },
  connector: { label: "Open its configuration", href: "/configuration/connectors" },
};

/** Where an install of ANY kind is listed as an install — the surface the
 *  artifact kind already names, and the truthful fallback for an agent the run
 *  picker does not carry. */
const INSTALLED_EXTENSIONS_OBSERVABLE: SuppliedInstallObservable = {
  label: "See it in installed extensions",
  href: "/configuration/extensions",
};

/**
 * The AGENT kind's observable, resolved from the installed template rather than
 * asserted (cinatra#3204 criterion 21).
 *
 * `/agents` is the run picker: it lists the installed templates that carry a
 * human-in-the-loop signal of their own, plus their sub-agents and external A2A
 * agents (`selectHitlRunVisibleTemplates`). An installed agent without such a
 * signal is absent from it — through THIS road and through the store road
 * alike, because the filter reads the template, not the road it arrived on. So
 * pointing every agent install at `/agents` promises a listing that cannot
 * carry it, which is exactly what the proof round measured: the toast named the
 * agents list, the search there reported no match, and the install was fine.
 *
 * Resolved through the LISTING'S OWN reader and the LISTING'S OWN predicate —
 * never a second rule that could drift from the page — so the answer is the
 * page's answer. An agent the picker carries keeps the agents list; any other
 * agent is pointed at the installed-extensions listing, where every kind's
 * install is visible. A read failure degrades to that same listing: it is true
 * for every install, so it can never become the false half of this choice.
 */
async function resolveAgentObservable(packageName: string): Promise<SuppliedInstallObservable> {
  try {
    const { readInstalledAgentTemplates } = await import("./store");
    const { selectHitlRunVisibleTemplates } = await import("./hitl-run-filter");
    const installed = await readInstalledAgentTemplates();
    const visible = selectHitlRunVisibleTemplates(installed);
    if (visible.some((t) => t.packageName === packageName)) return KIND_OBSERVABLE.agent;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      "[supplied-install-actions] could not read the agents listing for the install observable:",
      err instanceof Error ? err.message : err,
    );
  }
  return INSTALLED_EXTENSIONS_OBSERVABLE;
}

/**
 * The SKILL kind's observable, narrowed to the package (cinatra#3204
 * criterion 21).
 *
 * The criterion names this observable in its own words: the skill is "queryable
 * in the catalog by package name". The unfiltered catalog is not that: it is a
 * paged table of every installed skill, so on any instance carrying more skills
 * than one page the freshly installed one is present but NOT on the surface the
 * operator lands on — the proof round measured exactly that, the row in the
 * document and hidden behind the pager. Naming the catalog QUERY as the
 * destination makes the promise true on the first screen, and it is the very
 * link the catalog renders beside each row (`/skills?q=<package name>`), so the
 * operator arrives where the product itself would have sent them.
 *
 * The name is percent-encoded: a scoped package carries `@` and `/`, and an
 * unencoded `/` would turn the query into a second path segment.
 */
function resolveSkillObservable(packageName: string): SuppliedInstallObservable {
  return {
    ...KIND_OBSERVABLE.skill,
    href: `${KIND_OBSERVABLE.skill.href}?q=${encodeURIComponent(packageName)}`,
  };
}

/** The observable a completed install points the operator at, per kind. */
async function resolveInstallObservable(
  kind: SuppliedPackageKind,
  packageName: string,
): Promise<SuppliedInstallObservable> {
  if (kind === "agent") return resolveAgentObservable(packageName);
  if (kind === "skill") return resolveSkillObservable(packageName);
  return KIND_OBSERVABLE[kind];
}

// ---------------------------------------------------------------------------
// Scope: validate, authorize, resolve the contract. Runs BEFORE any mutation.
// ---------------------------------------------------------------------------

type ResolvedScope = {
  target: InstallAccessTarget;
  orgId: string;
  rowOwnership: ReturnType<typeof resolveInstallAccessTargetContract>["rowOwnership"];
  policy: ReturnType<typeof resolveInstallAccessTargetContract>["policy"];
};

async function resolveScope(
  session: Awaited<ReturnType<typeof requireAdminSession>>,
  requested: { level: string; id: string } | undefined,
): Promise<ResolvedScope> {
  const orgId = session.session?.activeOrganizationId ?? null;
  if (!orgId) {
    throw new Error(
      "Installing needs an active organization. Switch to one of your organizations, then install this package.",
    );
  }
  if (!requested) {
    throw new Error(
      "Choose who can access this extension before installing — the install scope is required.",
    );
  }
  let target = InstallAccessTargetSchema.parse(requested);
  // The workspace audience is the authenticated tenant itself: re-derive its id
  // and DISCARD any client-supplied one, exactly as the store action does.
  if (target.level === "workspace" || target.level === "admin") {
    target = { level: target.level, id: orgId };
  }
  const { buildCanDoOptsFromSession } = await import("@/lib/auth-session");
  const { readActorRolesForInstall, assertTargetBelongsToActiveOrg, assertCanInstallAtTarget } =
    await import("./install-target-authz");
  const { orgRole } = await buildCanDoOptsFromSession(session);
  const roleBag = readActorRolesForInstall(session, orgId, orgRole);
  const tenantCheck = await assertTargetBelongsToActiveOrg(roleBag, target, orgId);
  await assertCanInstallAtTarget(roleBag, target, tenantCheck.projectOwnership);

  const { rowOwnership, policy } = resolveInstallAccessTargetContract(target, orgId);
  return { target, orgId, rowOwnership, policy };
}

// ---------------------------------------------------------------------------
// The shared install + fail-closed access write
// ---------------------------------------------------------------------------

async function resolveAccessResourceId(input: {
  kind: SuppliedPackageKind;
  packageName: string;
  identity: {
    organizationId: string | null;
    ownerLevel: string;
    ownerId: string | null;
    packageName: string;
  };
  provenanceType: "local" | "github";
}): Promise<{ accessKind: "agent_template" | "skill_package" | "connector" | "artifact"; resourceId: string }> {
  const resource = resolveSuppliedInstallAccessResource(input.kind);
  if (resource.carrier === "canonical-row") {
    const { readInstalledExtensionByIdentity } = await import(
      "@cinatra-ai/extensions/canonical-store"
    );
    const row = await readInstalledExtensionByIdentity(input.identity as never);
    if (!row) {
      throw new Error("canonical install row not found after a successful install");
    }
    return { accessKind: resource.accessKind, resourceId: row.id };
  }
  if (input.kind === "agent") {
    const { readAgentTemplateByPackageName } = await import("./store");
    const template = await readAgentTemplateByPackageName(input.packageName);
    if (!template) {
      throw new Error("agent template row not found after a successful install");
    }
    return { accessKind: "agent_template", resourceId: template.id };
  }
  const { resolveSkillPackageSource } = await import(
    "@cinatra-ai/skills/skill-package-source"
  );
  const resolved = resolveSkillPackageSource({
    registryUrl: "",
    packageName: input.packageName,
    provenance: { type: input.provenanceType },
  } as never);
  return { accessKind: "skill_package", resourceId: resolved.packageId };
}

type Candidate = {
  kind: SuppliedPackageKind;
  packageName: string;
  version: string;
  provenance: { type: "local" | "github" } & Record<string, unknown>;
  anthropicUploadConsent?: {
    granted?: unknown;
    confirmedClosureDigest?: unknown;
  };
};

// ---------------------------------------------------------------------------
// THE UPLOAD-CONSENT CONTRACT (cinatra#2092), on BOTH supplied roads.
//
// Nothing about the policy is re-implemented here: the decision, the digest
// check and the grant writes all belong to `@/lib/anthropic-skill-config-service`
// and are called, not copied. What this road owns is the two ends of it —
// showing the closure BEFORE the install, and recording the outcome AFTER it —
// and the fail-closed default in between: no consent means the installed skill
// stays upload-ineligible, and the reason travels back to the operator.
//
// It applies to the `skill` kind alone, because the skills catalog is the only
// thing the Anthropic Skills API uploads. A connector, an artifact or an agent
// package is never asked the question, so an operator is never shown a consent
// box for a package that cannot egress.
// ---------------------------------------------------------------------------

/** The package identity the consent grant hangs off, for a skill package. */
async function suppliedSkillPackageId(
  packageName: string,
  provenanceType: "local" | "github",
): Promise<string> {
  const { resolveSkillPackageSource } = await import(
    "@cinatra-ai/skills/skill-package-source"
  );
  return resolveSkillPackageSource({
    registryUrl: "",
    packageName,
    provenance: { type: provenanceType },
  } as never).packageId;
}

/**
 * The PRE-INSTALL confirmation for a supplied skill package.
 *
 * The previewed closure is the root package ALONE, stated rather than assumed: a
 * supplied package carries no resolved registry dependency edges on this road
 * (bundled-closure handling is criterion 24, and is not built here), so a wider
 * claim would be a claim this road cannot keep. The post-install recorder reads
 * the real closure from the catalog and applies the digest check.
 */
async function buildSuppliedConsentPrompt(input: {
  kind: SuppliedPackageKind;
  packageName: string;
  provenanceType: "local" | "github";
}): Promise<SuppliedUploadConsentPrompt | undefined> {
  if (input.kind !== "skill") return undefined;
  const { buildInstallConsentPrompt } = await import(
    "@/lib/anthropic-skill-config-service"
  );
  const packageId = await suppliedSkillPackageId(input.packageName, input.provenanceType);
  const prompt = buildInstallConsentPrompt({
    rootPackageName: input.packageName,
    closure: [{ packageId, packageName: input.packageName, isRoot: true }],
  });
  return {
    headline: prompt.headline,
    advisory: prompt.advisory,
    closureLines: prompt.closureLines,
    closureDigest: prompt.closureDigest,
    consentApplies: prompt.consentApplies,
  };
}

/**
 * The FILE road's consent lookup. That tab reads the archive in the browser (so
 * the operator sees what they supplied without a roundtrip), so the consent
 * confirmation — which is server state, because the workspace opt-in is — is
 * fetched here once the kind is known. The repository road gets the identical
 * object on its preview, from the same builder.
 */
export async function readSuppliedUploadConsentPromptAction(input: {
  kind: string;
  packageName: string;
  provenanceType?: "local" | "github";
}): Promise<SuppliedUploadConsentPrompt | null> {
  await requireAdminSession();
  try {
    const prompt = await buildSuppliedConsentPrompt({
      kind: input.kind as SuppliedPackageKind,
      packageName: input.packageName,
      provenanceType: input.provenanceType ?? "local",
    });
    return prompt ?? null;
  } catch {
    // A consent prompt that cannot be built is not a reason to block an install:
    // with no prompt the screen asks nothing, and an unasked install is
    // fail-closed by the recorder — the skill stays upload-ineligible.
    return null;
  }
}

const CONSENT_FAIL_CLOSED: SuppliedUploadConsentOutcome = {
  granted: false,
  reason: "consent-write-failed",
  outcome:
    "The upload consent could not be recorded, so the installed skill stays excluded from upload.",
};

async function installAtScope(
  session: Awaited<ReturnType<typeof requireAdminSession>>,
  scope: ResolvedScope,
  candidate: Candidate,
): Promise<SuppliedInstallResult> {
  // The fail-closed precondition, for EVERY kind (criterion 13).
  assertSuppliedInstallAccessTarget(candidate.kind, scope.target);

  const { installSuppliedCandidate } = await import("@/lib/supplied-package-install");
  const { readInstalledExtensionByIdentity } = await import(
    "@cinatra-ai/extensions/canonical-store"
  );
  const { withInstallLock } = await import("./materialize-agent-package");

  const identity = {
    organizationId: scope.rowOwnership.organizationId,
    ownerLevel: scope.rowOwnership.ownerLevel,
    ownerId: scope.rowOwnership.ownerId,
    packageName: candidate.packageName,
  };

  const isSkill = candidate.kind === "skill";

  return withInstallLock(candidate.packageName, async (): Promise<SuppliedInstallResult> => {
    // Snapshot BEFORE the install (under the lock): a re-upload over an existing
    // live row must never be uninstalled by the compensation below.
    const preRow = await readInstalledExtensionByIdentity(identity as never);
    const hadLiveRowBefore =
      preRow != null && (preRow.status === "active" || preRow.status === "locked");

    // The catalog as it stands BEFORE this install, so the consent closure below
    // is what THIS install added and not the whole catalog. Taken under the same
    // lock as the install itself, or a concurrent install's rows would be
    // consented to by this operator's tick.
    let catalogBefore: Set<string> | null = null;
    if (isSkill) {
      const { snapshotSkillPackageIds } = await import(
        "@/lib/anthropic-skill-config-service"
      );
      catalogBefore = snapshotSkillPackageIds();
    }

    try {
      await installSuppliedCandidate({
        candidate: candidate as never,
        actor: {
          actorType: "human",
          source: "ui",
          ...(session.user?.id ? { userId: session.user.id } : {}),
          orgId: scope.orgId,
        },
        rowOwnership: scope.rowOwnership,
      });
    } catch (installErr) {
      // The TYPED requires-rebuild state, surfaced as a state rather than as a
      // wall of prose (the MCP layer already does exactly this). A connector
      // that ships a bundled React setup page is not a broken package and the
      // operator has not done anything wrong — there is simply no runtime road
      // for it, and saying so by name is the whole difference between an error
      // and an answer.
      if (isRequiresRebuild(installErr)) {
        return {
          ok: false,
          stage: "requires-rebuild",
          error:
            `${candidate.packageName} ships a bundled React setup page, so it cannot be ` +
            `installed at runtime — it becomes available after a base-image rebuild that ` +
            `includes it. A schema-config connector installs here with no rebuild. Nothing ` +
            `was installed.`,
        };
      }
      // Everything else travels in the words of whatever refused it: the trust
      // gate, the validator, the containment policy. A summary here would
      // replace the one sentence the operator has to act on.
      throw installErr;
    }

    try {
      const { accessKind, resourceId } = await resolveAccessResourceId({
        kind: candidate.kind,
        packageName: candidate.packageName,
        identity,
        provenanceType: candidate.provenance.type,
      });
      const { setExtensionInstallAccess } = await import(
        "@cinatra-ai/extensions/install-access-contract"
      );
      await setExtensionInstallAccess({
        kind: accessKind,
        resourceId,
        ...(scope.policy ? { policy: scope.policy } : {}),
        installedByUserId: session.user?.id ?? null,
      });
    } catch (accessErr) {
      // eslint-disable-next-line no-console
      console.warn(
        "[supplied-install-actions] install-time access write failed:",
        accessErr instanceof Error ? accessErr.message : accessErr,
      );
      if (hadLiveRowBefore) {
        return {
          ok: false,
          error:
            "The package installed, but the access scope could not be saved. The previous access still applies — set it on the extension's permissions page.",
          stage: "access-partial",
        };
      }
      const rolledBack = await rollbackFreshSuppliedInstall({
        identity,
        packageName: candidate.packageName,
        version: candidate.version,
        workspaceAnchored: isWorkspaceRowAnchor(scope.rowOwnership),
      });
      return {
        ok: false,
        error: rolledBack
          ? "The access scope could not be saved, so the install was rolled back. Nothing was left installed at a broader scope than you chose."
          : "The access scope could not be saved and the install could not be rolled back — this needs recovery. Check the installed-extensions list before retrying.",
        stage: rolledBack ? "access" : "access-partial",
      };
    }

    // The upload-consent contract, AFTER the install and NEVER rolling it back:
    // a fail-closed decision leaves the skill upload-ineligible, which is a
    // complete and correct install — it is only the upload that does not happen.
    const warnings: string[] = [];
    let uploadConsent: SuppliedUploadConsentOutcome | undefined;
    if (isSkill && catalogBefore) {
      try {
        const { resolveInstalledClosure, recordSkillInstallConsent } = await import(
          "@/lib/anthropic-skill-config-service"
        );
        const rootPackageId = await suppliedSkillPackageId(
          candidate.packageName,
          candidate.provenance.type,
        );
        const closure = resolveInstalledClosure({ before: catalogBefore, rootPackageId });
        const recorded = recordSkillInstallConsent({
          consent: candidate.anthropicUploadConsent ?? null,
          closure,
          grantedBy: session.user?.id ?? null,
          // The screen is the only caller, and it shows the closure and the
          // advisory before the tick — so the digest check is mandatory.
          interactive: candidate.anthropicUploadConsent != null,
        });
        uploadConsent = {
          granted: recorded.grant,
          reason: recorded.reason,
          outcome: recorded.outcome,
        };
      } catch (consentErr) {
        // eslint-disable-next-line no-console
        console.warn(
          "[supplied-install-actions] upload-consent recording failed (the skill stays upload-ineligible):",
          consentErr instanceof Error ? consentErr.message : consentErr,
        );
        uploadConsent = CONSENT_FAIL_CLOSED;
        warnings.push(
          "Could not record the upload consent — the installed skill stays excluded from upload.",
        );
      }
    }

    return {
      ok: true,
      kind: candidate.kind,
      packageName: candidate.packageName,
      version: candidate.version,
      observable: await resolveInstallObservable(candidate.kind, candidate.packageName),
      ...(uploadConsent ? { uploadConsent } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  });
}

/**
 * Undo a FRESH supplied install whose access write failed. Follows the anchor,
 * exactly as the store road's compensation does: an org-anchored row goes through
 * the package-scoped uninstall, a workspace-anchored (org-NULL) row through the
 * row-scoped inverse the org-pinned resolver cannot address.
 */
async function rollbackFreshSuppliedInstall(input: {
  identity: {
    organizationId: string | null;
    ownerLevel: string;
    ownerId: string | null;
    packageName: string;
  };
  packageName: string;
  version: string;
  workspaceAnchored: boolean;
}): Promise<boolean> {
  try {
    const { readInstalledExtensionByIdentity } = await import(
      "@cinatra-ai/extensions/canonical-store"
    );
    const row = await readInstalledExtensionByIdentity(input.identity as never);
    if (!row) return true;
    const { extensionRegistry } = await import("@cinatra-ai/extensions");
    await extensionRegistry.uninstall(
      row.kind,
      { registryUrl: "", packageName: input.packageName, version: input.version } as never,
      { actorType: "system", source: "ui" } as never,
    );
    const after = await readInstalledExtensionByIdentity(input.identity as never);
    return after == null || (after.status !== "active" && after.status !== "locked");
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      "[supplied-install-actions] rollback of a fresh supplied install FAILED — recovery required:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/** The typed `REQUIRES_REBUILD` state a connector handler raises. */
function isRequiresRebuild(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "REQUIRES_REBUILD"
  );
}

function failure(err: unknown): { ok: false; error: string } {
  // Every refusal travels in the words of whatever refused it — that is the
  // rule, and it is right while those words are addressed to the operator. Two
  // are not: the connector access-declaration chain composes the SDK validator's
  // file-and-issue sentence with the activator's failure token and the
  // dispatcher's placeholder-row detail, and the install road's execution
  // boundary composes the classifier's verdict with the journal, the grant and
  // the materialized bytes it did NOT write. Both are paragraphs of diagnostics,
  // and a paragraph on the toast surface is a refusal the admin cannot read.
  // Those refusals are answered in product words; the diagnostics go to the
  // server log, where whoever maintains the install chain reads every word.
  const raw = err instanceof Error ? err.message : String(err);
  const adminFacing = adminFacingSuppliedInstallRefusal(raw);
  if (adminFacing) {
    // eslint-disable-next-line no-console
    console.error(
      "[supplied-install-actions] supplied install refused — the admin was answered " +
        "in product words; the diagnostics are:",
      raw,
    );
    return { ok: false, error: adminFacing };
  }
  return { ok: false, error: err instanceof Error ? err.message : "The install failed." };
}

// ---------------------------------------------------------------------------
// THE FILE ROAD
// ---------------------------------------------------------------------------

function decodeBase64(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "base64"));
}

/** Read a supplied archive server-side and report what it is. Writes nothing. */
export async function previewSuppliedArchiveAction(
  zipBase64: string,
): Promise<SuppliedPreviewResult> {
  await requireAdminSession();
  try {
    const { previewSuppliedArchive } = await import("@/lib/archive-supplied-install");
    const preview = await previewSuppliedArchive(decodeBase64(zipBase64));
    const consentPrompt = await buildSuppliedConsentPrompt({
      kind: preview.kind,
      packageName: preview.packageName,
      provenanceType: "local",
    });
    return {
      ok: true,
      preview: {
        kind: preview.kind,
        packageName: preview.packageName,
        version: preview.version,
        contentDigest: preview.contentDigest,
        ...(consentPrompt ? { consentPrompt } : {}),
      },
    };
  } catch (err) {
    return failure(err);
  }
}

export async function installSuppliedArchiveAction(input: {
  zipBase64: string;
  expectedContentDigest?: string;
  accessTarget?: { level: string; id: string };
  /** The operator's explicit upload consent, when they were asked and ticked it. */
  anthropicUploadConsent?: { granted?: unknown; confirmedClosureDigest?: unknown };
}): Promise<SuppliedInstallResult> {
  const session = await requireAdminSession();
  let scope: ResolvedScope;
  try {
    scope = await resolveScope(session, input.accessTarget);
  } catch (err) {
    return failure(err);
  }
  try {
    const { prepareSuppliedArchiveSnapshot, candidateFromPreparedArchive } = await import(
      "@/lib/supplied-package-install"
    );
    const prepared = await prepareSuppliedArchiveSnapshot({
      archive: decodeBase64(input.zipBase64),
      ...(input.expectedContentDigest
        ? { expectedContentDigest: input.expectedContentDigest }
        : {}),
    });
    return await installAtScope(session, scope, {
      ...(candidateFromPreparedArchive(prepared) as never as Candidate),
      ...(input.anthropicUploadConsent
        ? { anthropicUploadConsent: input.anthropicUploadConsent }
        : {}),
    });
  } catch (err) {
    return failure(err);
  }
}

// ---------------------------------------------------------------------------
// THE REPOSITORY ROAD
// ---------------------------------------------------------------------------

/** The connector key the GitHub connection identity rows are written under —
 *  host vocabulary (a `NangoConnectorKey`), never a package literal. */
const GITHUB_CONNECTOR_KEY = "github";

/**
 * Does THIS organization hold a GitHub connection it may use?
 *
 * The connector client's `getStatus()` answers for the instance: its contract
 * takes no scoping argument at all, so a second admin session in another
 * organization read the first organization's connection as its own and both
 * precondition states below became unreachable for it (measured on the real
 * screen). The connection rows themselves are org-stamped at write time, and
 * the identity store is the sanctioned org-scoped read of them — the same rows
 * the connection resolver picks the actual token from — so the precondition is
 * read there.
 *
 * FAIL-CLOSED on the null-org legacy rows the store returns alongside the
 * organization's own: those are owner-only by construction, so they count only
 * for the admin who owns them and never as this organization's connection.
 */
async function organizationHasGitHubConnection(input: {
  organizationId: string | null;
  userId: string | null;
}): Promise<boolean> {
  const { listNangoConnectionsByConnector } = await import(
    "@cinatra-ai/extensions/connection-identity-store"
  );
  const rows = await listNangoConnectionsByConnector(
    input.organizationId,
    GITHUB_CONNECTOR_KEY,
  );
  return rows.some((row) =>
    row.organizationId === null
      ? input.userId != null && row.ownerUserId === input.userId
      : input.organizationId != null && row.organizationId === input.organizationId,
  );
}

/**
 * The precondition probe (criteria 9, 10). Distinguishes "no owning connector"
 * from "an installed connector with no usable connection", and names where each
 * is fixed.
 */
export async function readGitHubUploadPreconditionAction(): Promise<GitHubUploadPrecondition> {
  const session = await requireAdminSession();
  const { resolveGitHubConnectionClient } = await import("@/lib/connector-client-providers");
  const client = resolveGitHubConnectionClient();
  if (!client) {
    return {
      state: "no-connector",
      message:
        "The GitHub connector is not installed or not active on this instance, so this tab cannot reach a repository. Install and activate it from the marketplace, then come back.",
      fixHref: "/configuration/marketplace",
      fixLabel: "Open the marketplace",
    };
  }
  const noConnection: GitHubUploadPrecondition = {
    state: "no-connection",
    message:
      "The GitHub connector is installed, but this organization has no usable GitHub connection yet. Connect an account in the connector's settings, then come back.",
    fixHref: "/configuration/connectors",
    fixLabel: "Open connector settings",
  };
  try {
    const status = await client.getStatus();
    if (status.status !== "connected") return noConnection;
    // Connected SOMEWHERE on this instance is not connected HERE: the tab
    // installs on behalf of the organization the screen runs in.
    const usableHere = await organizationHasGitHubConnection({
      organizationId: session.session?.activeOrganizationId ?? null,
      userId: session.user?.id ?? null,
    });
    return usableHere ? { state: "ready" } : noConnection;
  } catch {
    return {
      state: "no-connection",
      message:
        "The GitHub connector is installed, but its connection could not be read. Reconnect the account in the connector's settings, then come back.",
      fixHref: "/configuration/connectors",
      fixLabel: "Open connector settings",
    };
  }
}

async function parseRepoUrl(repoUrl: string): Promise<{ owner: string; repo: string }> {
  const { parseGitHubRepositoryReference } = await import("@cinatra-ai/skills");
  const parsed = parseGitHubRepositoryReference(repoUrl);
  if (!parsed) {
    throw new Error(
      "That is not a github.com repository URL. Paste the full URL, for example https://github.com/owner/repo.",
    );
  }
  return parsed;
}

/**
 * Resolve the ref to ONE immutable commit, read the package at it, and report
 * the kind and the pinned sha. The ref is resolved exactly once, here, and the
 * install re-reads at the sha this returns.
 */
export async function previewSuppliedRepositoryAction(input: {
  repoUrl: string;
  ref?: string;
}): Promise<SuppliedPreviewResult> {
  await requireAdminSession();
  try {
    const precondition = await readGitHubUploadPreconditionAction();
    if (precondition.state !== "ready") {
      return { ok: false, error: precondition.message };
    }
    const { owner, repo } = await parseRepoUrl(input.repoUrl);
    const { getGitHubOctokit } = await import("@cinatra-ai/skills");
    const { octokit } = await getGitHubOctokit();
    const { previewGitHubSuppliedPackage } = await import(
      "@cinatra-ai/skills/repository-package-intake"
    );
    const preview = await previewGitHubSuppliedPackage({
      client: octokit as never,
      owner,
      repo,
      ...(input.ref ? { ref: input.ref } : {}),
    });
    const consentPrompt = await buildSuppliedConsentPrompt({
      kind: preview.kind,
      packageName: preview.packageName,
      provenanceType: "github",
    });
    return {
      ok: true,
      preview: {
        kind: preview.kind,
        packageName: preview.packageName,
        version: preview.version,
        contentDigest: preview.contentDigest,
        resolvedSha: preview.resolvedSha,
        repo: preview.repo,
        ref: preview.ref,
        ...(consentPrompt ? { consentPrompt } : {}),
      },
    };
  } catch (err) {
    return failure(err);
  }
}

export async function installSuppliedRepositoryAction(input: {
  repoUrl: string;
  ref: string;
  pin: { resolvedSha: string; contentDigest: string };
  accessTarget?: { level: string; id: string };
  /** The operator's explicit upload consent, when they were asked and ticked it. */
  anthropicUploadConsent?: { granted?: unknown; confirmedClosureDigest?: unknown };
}): Promise<SuppliedInstallResult> {
  const session = await requireAdminSession();
  let scope: ResolvedScope;
  try {
    scope = await resolveScope(session, input.accessTarget);
  } catch (err) {
    return failure(err);
  }
  try {
    const precondition = await readGitHubUploadPreconditionAction();
    if (precondition.state !== "ready") {
      return { ok: false, error: precondition.message };
    }
    const { owner, repo } = await parseRepoUrl(input.repoUrl);
    const { getGitHubOctokit } = await import("@cinatra-ai/skills");
    const { octokit } = await getGitHubOctokit();
    const { prepareSuppliedRepositorySnapshot } = await import(
      "@/lib/supplied-package-install"
    );
    const prepared = await prepareSuppliedRepositorySnapshot({
      client: octokit as never,
      owner,
      repo,
      ref: input.ref,
      pin: input.pin,
    });
    return await installAtScope(session, scope, {
      ...(prepared as never as Candidate),
      ...(input.anthropicUploadConsent
        ? { anthropicUploadConsent: input.anthropicUploadConsent }
        : {}),
    });
  } catch (err) {
    return failure(err);
  }
}
