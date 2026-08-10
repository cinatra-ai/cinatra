// cinatra#2616 — the agent_templates IDENTITY CLAIM.
//
// ONE module on purpose. The rule and its operations were drafted as two files
// (a leaf for the predicate, a tier above for the operations) but the route-graph
// ratchet counts MODULES reachable from the locked dev-perf routes, and store.ts
// is on every one of them — so a second file cost a second module on all five for
// no architectural gain. There is no cycle to avoid: this module imports only
// ./db and ./schema, never ./store, which is what lets store.ts both AND the
// predicate into its own writes and re-export the origin writers as a thin facade.
//
// What lives here:
//   - THE RULE (insert-only-or-owned-update) as a pure predicate and its SQL twin.
//   - the packageName DERIVATION moved out of store.ts — it mints the very
//     identity the rule adjudicates, and the move made room under store.ts's
//     own file-size ceiling.
//   - resolveAgentTemplateIdentityClaim — read + refuse, for the INERT window.
//   - claimAgentTemplateIdentity — the whole insert-only-or-owned-update
//     operation INCLUDING the 23505 race classification. ONE shared function, so
//     the concurrency proof exercises the same code the install path runs.
//   - the package-name-keyed origin writers, moved here from store.ts and now
//     claim-GUARDED (they were a second unguarded writer of a globally unique
//     identity: agent_source_publish caught its DB-sync failure, logged it, and
//     then wrote origin onto the foreign row anyway).

import { and, eq, isNull, or, type SQL } from "drizzle-orm";
import { db } from "./db";
import { agentTemplates, type ExtensionOrigin } from "./schema";

// ---------------------------------------------------------------------------
// packageName DERIVATION (moved from store.ts, cinatra#2616 — it mints the very
// identity the rule above adjudicates).
//
// Every template row carries a NOT NULL packageName. Templates created via the
// internal save path that omit packageName receive an auto-derived
// `@user-<userId>/<slug>` identity. Existing templates created with an explicit
// packageName pass through unchanged.
//
// `slugify` mirrors the looser `slugifyAgentTemplateName` variant used for route
// lookups but enforces the strict `[a-z0-9-]` charset that the strict regex
// (resolveWayflowUrl) demands.
// ---------------------------------------------------------------------------

/**
 * Strip leading and trailing hyphens.
 *
 * Deliberately NOT the `/^-+|-+$/g` replace these two functions carried in
 * store.ts: that alternation backtracks polynomially on a long run of hyphens,
 * and the input here is caller-supplied (an agent name, a route slug), so CodeQL
 * flags it as a ReDoS reachable from library input. This scan is linear and the
 * result is byte-identical for every input.
 */
function trimHyphens(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) === 45) start += 1;
  while (end > start && value.charCodeAt(end - 1) === 45) end -= 1;
  return value.slice(start, end);
}

export function slugify(input: string): string {
  const cleaned = trimHyphens(input.toLowerCase().replace(/[^a-z0-9-]+/g, "-"));
  return cleaned || "untitled";
}

/** The looser route-lookup slug variant. */
export function slugifyAgentTemplateName(value: string): string {
  return trimHyphens(value.toLowerCase().replace(/[^a-z0-9]+/g, "-"));
}

export function derivePackageName(input: {
  packageName?: string | null;
  userId?: string | null;
  name: string;
  id?: string | null;
}): string {
  const trimmed = input.packageName?.trim();
  if (trimmed) return trimmed;
  // Append slugified id to guarantee uniqueness, mirroring the migration
  // backfill formula in src/lib/drizzle-store.ts. Without the id suffix two
  // templates with the same (creator, name) collide on the unique index. The
  // slugify pass also enforces the strict resolveWayflowUrl charset (lowercase
  // + [a-z0-9-]) so manifests round-trip cleanly through the catch-all proxy.
  const userPartRaw = input.userId?.trim() || "unknown";
  const userPart = slugify(userPartRaw);
  const slug = slugify(input.name);
  const idPart = input.id ? slugify(input.id) : "";
  return idPart ? `@user-${userPart}/${slug}-${idPart}` : `@user-${userPart}/${slug}`;
}

/**
 * WHO is claiming a package name. Discriminated ON PURPOSE: an optional
 * `orgId?: string | null` would make "the caller forgot the field" and "the
 * caller is the instance operator" the same value, which is how a missed
 * caller becomes a silent platform-authorized takeover.
 */
export type AgentTemplateIdentityClaim =
  | { readonly kind: "organization"; readonly orgId: string }
  | { readonly kind: "platform" };

/** The instance operator's own claim — boot seeding and the CLI. */
export const PLATFORM_IDENTITY_CLAIM: AgentTemplateIdentityClaim = { kind: "platform" };

/** A tenant's claim. */
export function organizationIdentityClaim(orgId: string): AgentTemplateIdentityClaim {
  return { kind: "organization", orgId };
}

/**
 * Derive a claim from the org values an install caller threads.
 *
 * `orgId ?? anchorOrgId` is the SAME scope rule the dependency planner already
 * uses (`install-package-with-dependencies.ts`: "orgId when the caller threads
 * it, else the dispatcher anchor scope"). The `anchorOrgId` fallback is
 * load-bearing: the extension/marketplace handler passes ONLY `anchorOrgId` and
 * never `orgId`, so without it the marketplace path — the caller cinatra#2616
 * AC4 names — would claim as platform and skip the guard entirely.
 *
 * Throws when two non-null org values DISAGREE: claiming as A while stamping B
 * would let the predicate pass against A's row and the patch write B's org.
 */
export function deriveAgentTemplateIdentityClaim(input: {
  claimantOrgId?: string | null;
  orgId?: string | null;
  anchorOrgId?: string | null;
}): AgentTemplateIdentityClaim {
  const present = [input.claimantOrgId, input.orgId, input.anchorOrgId].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  const distinct = Array.from(new Set(present));
  if (distinct.length > 1) {
    throw new Error(
      "[agent-template-identity] refusing an incoherent identity claim: the caller " +
        `supplied disagreeing organizations (${distinct.join(", ")}). A claim must be ` +
        "evaluated against the SAME organization the write stamps.",
    );
  }
  const orgId = input.claimantOrgId ?? input.orgId ?? input.anchorOrgId ?? null;
  return orgId ? organizationIdentityClaim(orgId) : PLATFORM_IDENTITY_CLAIM;
}

/**
 * The claim for a package-name-keyed write that follows an ALREADY-AUTHORIZED
 * row read — the `origin` / `visibility` writers on the publish paths.
 *
 * `actorOrgId` FIRST, and that ordering is the point. Deriving the claim from
 * the ROW alone mints PLATFORM authority whenever the row happens to be
 * org-less, and platform authority may write any row: if another organization
 * claimed that org-less name between the caller's read and this write, the
 * write would land on the now-foreign row — exactly the guarantee this helper
 * is supposed to give. A tenant caller therefore claims as ITS OWN
 * organization, which still passes on an org-less row (org-less is unclaimed)
 * and refuses once the name has moved.
 *
 * With no actor organization the claim pins to the row's own organization, so
 * the write is still bound to the identity the caller authorized. Only an
 * org-less caller writing an org-less row reaches the platform arm — the
 * operator/boot shape.
 */
export function claimOfAuthorizedTemplate(
  row: { orgId: string | null },
  actorOrgId?: string | null,
): AgentTemplateIdentityClaim {
  if (actorOrgId) return organizationIdentityClaim(actorOrgId);
  return row.orgId ? organizationIdentityClaim(row.orgId) : PLATFORM_IDENTITY_CLAIM;
}

/**
 * Thrown when a package name is held by a DIFFERENT organization.
 *
 * The owning organization is deliberately NOT in the message: install and
 * publish refusals surface through MCP tool results, which persist and are
 * LLM-visible, so the copy must not enumerate other tenants. Callers that need
 * the owner for an operator log read it from the row themselves.
 */
export class AgentTemplateIdentityConflictError extends Error {
  readonly code = "AGENT_TEMPLATE_IDENTITY_CONFLICT" as const;
  readonly packageName: string;
  constructor(packageName: string) {
    super(
      `package-name identity conflict: '${packageName}' is already claimed by another ` +
        "organization on this instance. Installing or publishing under that name would take " +
        "over the existing agent, so it is refused. Publish under a different package name, " +
        "or ask the organization that owns it to publish the update.",
    );
    this.name = "AgentTemplateIdentityConflictError";
    this.packageName = packageName;
  }
}

export function isAgentTemplateIdentityConflict(
  err: unknown,
): err is AgentTemplateIdentityConflictError {
  return err instanceof AgentTemplateIdentityConflictError;
}

/**
 * THE RULE, as a pure predicate. The SQL builder below is its twin; they are
 * kept adjacent so they cannot drift.
 */
export function agentTemplateIdentityIsClaimable(
  row: { orgId: string | null },
  claim: AgentTemplateIdentityClaim,
): boolean {
  if (claim.kind === "platform") return true;
  return row.orgId === null || row.orgId === claim.orgId;
}

/**
 * THE RULE, as a WHERE fragment. `undefined` means "no restriction" (the
 * platform arm), which drizzle's `and(...)` drops.
 *
 * This rides the WRITE, not a preceding read — that is what makes the claim
 * atomic. It is the same idiom `_updateAgentTemplateImpl` already uses for the
 * assistant-publication invariant ("the UPDATE itself carries
 * `agent_kind <> 'assistant'` in its WHERE, so an assistant can NEVER be moved
 * to published even under a race").
 */
export function agentTemplateIdentityClaimPredicate(
  claim: AgentTemplateIdentityClaim,
): SQL<unknown> | undefined {
  if (claim.kind === "platform") return undefined;
  return or(
    isNull(agentTemplates.orgId),
    eq(agentTemplates.orgId, claim.orgId),
  ) as SQL<unknown>;
}

/**
 * The org value a successful claim RECORDS on the row, or `undefined` when the
 * caller already supplies one.
 *
 * A refusal predicate alone is not a claim: the marketplace/extension handler
 * threads only `anchorOrgId`, so its rows used to land `org_id NULL` — the name
 * stayed UNCLAIMED and a second organization could take it. Recording the claim
 * in the column that already exists is what makes it durable without DDL.
 *
 * This is NOT the ownership shift cinatra#793 forbids. That rule protects an
 * EXISTING row from having its owner moved by a payload-anchor scope; here the
 * row is either brand new (no prior owner to move) or `org_id IS NULL` (no
 * prior owner at all). A row that already carries an org keeps it.
 */
export function agentTemplateIdentityClaimOrgToRecord(
  claim: AgentTemplateIdentityClaim,
  callerOrgId: string | undefined,
): string | undefined {
  if (callerOrgId !== undefined) return undefined;
  return claim.kind === "organization" ? claim.orgId : undefined;
}


/**
 * The projection the claim operations return. Deliberately NARROW — the whole
 * `AgentTemplateRecord` would require `deserializeTemplate` from store.ts and
 * reintroduce the cycle this module exists to avoid. These are the columns the
 * install branches actually consume (`existing.id`, `existing.status`) plus the
 * ownership tuple an operator log needs.
 */
export type ClaimedAgentTemplateRow = {
  id: string;
  orgId: string | null;
  ownerLevel: string | null;
  ownerId: string | null;
  status: string;
  packageVersion: string | null;
};

const CLAIM_PROJECTION = {
  id: agentTemplates.id,
  orgId: agentTemplates.orgId,
  ownerLevel: agentTemplates.ownerLevel,
  ownerId: agentTemplates.ownerId,
  status: agentTemplates.status,
  packageVersion: agentTemplates.packageVersion,
} as const;

export type AgentTemplateIdentityResolution =
  /** No row holds this name — the caller may INSERT. */
  | { outcome: "unclaimed" }
  /** The row is claimable by this claimant — the caller may UPDATE it. */
  | { outcome: "owned"; row: ClaimedAgentTemplateRow };

/** Postgres unique-violation on `agent_templates_package_name_idx`. */
export function isUniqueViolation(err: unknown): boolean {
  const code = (err as { code?: unknown })?.code;
  if (code === "23505") return true;
  const causeCode = (err as { cause?: { code?: unknown } })?.cause?.code;
  return causeCode === "23505";
}

/**
 * Read the row a package name resolves to FOR A WRITE by this claimant.
 *
 * Refuses a foreign name here so the ordinary refusal happens in the install
 * path's INERT window — before the disk materialize — and mutates nothing,
 * which is the doctrine that file already keeps for its pin gate, its
 * dependency-edge gate and its project-template gate.
 *
 * This is a FAST PATH, not the guard. The guard is the predicate riding the
 * actual write (`updateAgentTemplate`'s `claim` option); a row adopted between
 * this read and that write still refuses there.
 */
export async function resolveAgentTemplateIdentityClaim(input: {
  packageName: string;
  claim: AgentTemplateIdentityClaim;
}): Promise<AgentTemplateIdentityResolution> {
  const rows = await db
    .select(CLAIM_PROJECTION)
    .from(agentTemplates)
    .where(eq(agentTemplates.packageName, input.packageName))
    .limit(1);
  const row = rows[0];
  if (!row) return { outcome: "unclaimed" };
  if (!agentTemplateIdentityIsClaimable(row, input.claim)) {
    // The owning org is named in the OPERATOR log only — never in the thrown
    // message, which reaches LLM-visible MCP tool results.
    console.warn(
      `[agent-template-identity] refusing '${input.packageName}': held by org ` +
        `'${row.orgId ?? "<none>"}', claimed by ` +
        `'${input.claim.kind === "organization" ? input.claim.orgId : "<platform>"}'.`,
    );
    throw new AgentTemplateIdentityConflictError(input.packageName);
  }
  return { outcome: "owned", row };
}

export type AgentTemplateIdentityClaimResult<TCreated> =
  | { mode: "created"; created: TCreated }
  | { mode: "adopted"; row: ClaimedAgentTemplateRow };

/**
 * THE claim operation: insert-only-or-owned-update, race classification
 * included.
 *
 * Deliberately ONE function rather than logic split between the store and the
 * install primitive. The concurrency property lives in the `23505` branch, so a
 * test that races raw inserts and observes a unique violation proves only that
 * Postgres picks a winner — it proves nothing about the LOSER receiving the
 * designed refusal. Every racer must run THIS.
 *
 * `insert` is a callback because the fresh-row creator
 * (`createLocalAgentTemplateVersion`) lives in a module that imports store.ts;
 * calling it from here directly would be a cycle.
 *
 * The unique index IS the claim on the insert side: two organizations racing a
 * brand-new name produce exactly one INSERT winner (carrying its own `org_id` —
 * see `agentTemplateIdentityClaimOrgToRecord`), and the loser lands here on
 * 23505, re-resolves, sees a foreign row, and refuses.
 */
export async function claimAgentTemplateIdentity<TCreated>(
  input: { packageName: string; claim: AgentTemplateIdentityClaim },
  ops: { insert: () => Promise<TCreated> },
): Promise<AgentTemplateIdentityClaimResult<TCreated>> {
  const resolved = await resolveAgentTemplateIdentityClaim(input);
  if (resolved.outcome === "owned") return { mode: "adopted", row: resolved.row };

  try {
    return { mode: "created", created: await ops.insert() };
  } catch (insertErr) {
    if (!isUniqueViolation(insertErr)) throw insertErr;
    // Another claimant won the INSERT between the resolve and here. Re-resolve
    // against the committed winner: `resolveAgentTemplateIdentityClaim` THROWS
    // the identity conflict when that winner belongs to another organization,
    // which is exactly the refusal the loser must receive.
    const afterRace = await resolveAgentTemplateIdentityClaim(input);
    // The winner vanished again (a concurrent uninstall). Nothing to adopt, and
    // inventing a second insert here would race the same way — surface the
    // original violation.
    if (afterRace.outcome !== "owned") throw insertErr;
    return { mode: "adopted", row: afterRace.row };
  }
}

// ---------------------------------------------------------------------------
// origin JSONB helpers (moved from store.ts, cinatra#2616).
//
// readAgentTemplateOrigin — used by resolveInstallEnvironment to determine
// which registry URL + routing topology to use for a given extension.
//
// updateAgentTemplateOrigin — called by every publish path (publishToRegistry,
// handleAgentBuilderGitPublish, importAgentTemplateCore) after a successful
// publish to persist coordinates. Tokens MUST NOT appear in origin; the caller
// writes only an opaque destinationId.
//
// Both origin WRITERS are keyed on the globally unique `package_name` with no
// organization predicate, which made them a second adoption surface: in
// `agent_source_publish` the guarded DB sync can now refuse, and the origin
// write that follows would still have stamped the refusing publisher's
// coordinates onto the foreign row. The claim is therefore REQUIRED, not
// optional — an optional guard preserves exactly the silent-bypass class this
// issue exists to close.
// ---------------------------------------------------------------------------

/**
 * Reads the origin JSONB from the agent_templates row identified by packageName.
 * Returns null for legacy rows (origin IS NULL) — callers treat null as
 * "public" (grandfather clause). READ-only, so it carries no claim.
 */
export async function readAgentTemplateOrigin(
  packageName: string,
): Promise<ExtensionOrigin | null> {
  const rows = await db
    .select({ origin: agentTemplates.origin })
    .from(agentTemplates)
    .where(eq(agentTemplates.packageName, packageName))
    .limit(1);
  return (rows[0]?.origin as ExtensionOrigin | null | undefined) ?? null;
}

/** WHERE package_name = $1 AND <the claim rule>. */
function claimedByPackageName(
  packageName: string,
  claim: AgentTemplateIdentityClaim,
): SQL<unknown> {
  const predicate = agentTemplateIdentityClaimPredicate(claim);
  return (
    predicate
      ? and(eq(agentTemplates.packageName, packageName), predicate)
      : eq(agentTemplates.packageName, packageName)
  ) as SQL<unknown>;
}

/**
 * Persists origin coordinates on the agent_templates row after a successful
 * publish.
 *
 * Tokens MUST NOT appear in origin. Only opaque coordinates are written:
 * packageName, version, destinationId (opaque key — no token), scope,
 * visibility, registryUrl, and optional importedFrom provenance.
 *
 * The claim rides the WHERE. A write that matches no row is REFUSED loudly
 * rather than reported as a no-op: every caller reaches here after resolving a
 * template it believes it owns, so zero rows means the identity moved.
 */
export async function updateAgentTemplateOrigin(
  packageName: string,
  origin: ExtensionOrigin,
  claim: AgentTemplateIdentityClaim,
): Promise<void> {
  const written = await db
    .update(agentTemplates)
    .set({ origin })
    .where(claimedByPackageName(packageName, claim))
    .returning({ id: agentTemplates.id });
  if (written.length === 0) await assertRowMissingOrThrowConflict(packageName);
}

/**
 * Updates the visibility field on the origin JSONB of an agent_templates row
 * after a successful promotion.
 *
 * Preserves all other origin fields (importedFrom, version, scope, etc.).
 * Current behavior supports only private→public. Callers are responsible for
 * enforcing that direction; this helper does NOT guard direction.
 *
 * Called exclusively by promoteExtensionToPublicAction after a successful
 * registry publish.
 */
export async function updateAgentTemplateVisibility(
  packageName: string,
  visibility: "public" | "private",
  registryUrl: string,
  claim: AgentTemplateIdentityClaim,
): Promise<void> {
  const existing = await readAgentTemplateOrigin(packageName);
  if (!existing) {
    throw new Error(`No origin row found for package ${packageName}`);
  }
  const updated: ExtensionOrigin = {
    ...existing,
    visibility,
    // When promoting to public, clear the private destinationId; it is no
    // longer the routing destination. When demoting (future), callers must
    // supply the destinationId explicitly.
    destinationId: visibility === "private" ? existing.destinationId : null,
    registryUrl,
  };
  const written = await db
    .update(agentTemplates)
    .set({ origin: updated })
    .where(claimedByPackageName(packageName, claim))
    .returning({ id: agentTemplates.id });
  if (written.length === 0) await assertRowMissingOrThrowConflict(packageName);
}

/**
 * Zero rows matched a claim-guarded write keyed on package_name. Classify:
 * the row is GONE (a concurrent uninstall — nothing to write, and the caller's
 * own error handling owns that) or it is FOREIGN (the identity moved under us).
 */
async function assertRowMissingOrThrowConflict(packageName: string): Promise<void> {
  const rows = await db
    .select({ id: agentTemplates.id })
    .from(agentTemplates)
    .where(eq(agentTemplates.packageName, packageName))
    .limit(1);
  if (rows.length > 0) throw new AgentTemplateIdentityConflictError(packageName);
}
