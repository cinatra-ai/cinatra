import "server-only";

// ---------------------------------------------------------------------------
// THE DECLARED REVIEW'S SERVER HALF (cinatra#2929, epic #2926 W2b).
//
// The one review core is pure: it proves the binding and evaluates the policy
// over facts it is handed. This module resolves the facts a DECLARED review's
// axes need and that do not live on the gate's marker — the artifact's semantic
// TYPE, the organization's bound, the producing agent's compiled declarations —
// and hands them over. It is the exact counterpart of what
// `lifecycle-review-orchestration-store.ts` already does for the produced kind,
// and it is a separate module for the reason that file's own seam exists: the
// run executor must not import a database.
// ---------------------------------------------------------------------------

import { and, eq } from "drizzle-orm";
import { pgSchema, text, timestamp } from "drizzle-orm/pg-core";

import {
  decideDeclaredReview,
  proveReviewBinding,
  DECLARED_REVIEW_DESTINATION_CLASS,
  DECLARED_REVIEW_ORIGIN_KIND,
  decideReviewPolicy,
  type DeclaredReviewDecision,
} from "@/lib/lifecycle/lifecycle-review-core";
import {
  parseLifecycleConfigText,
  type CompiledManifestLifecycle,
  type PolicyDecision,
} from "@/lib/lifecycle/lifecycle-policy";
import { setRepresentingTargetIds } from "@/lib/artifacts/artifact-review-target";
import { parseArtifactBindingDeclaration } from "./artifact-binding";
import { resolveOrgPolicyRule } from "./lifecycle-policy-store";
import { db } from "./db";
import { readAgentTemplateById } from "./store";

// The `objects` table, referenced the same narrow way the orchestration store
// references it: this package owns no objects schema, and a review only ever
// needs one column off it.
const appSchema = pgSchema(process.env.SUPABASE_SCHEMA?.trim() ?? "cinatra");
const objectsRef = appSchema.table("objects", {
  id: text("id").primaryKey(),
  orgId: text("org_id"),
  type: text("type").notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
});

export type DeclaredReviewRequest = {
  readonly orgId: string;
  readonly templateId: string | null;
  /** The version the RUN is pinned to, so a moved-on template cannot speak for it. */
  readonly packageVersion: string | null;
  /** The raw value of the flow input the gate's marker names. */
  readonly targets: unknown;
};

/**
 * Decide whether a template's marked review step opens a review.
 *
 * TWO STEPS, BOTH SHARED WITH THE PRODUCED KIND: prove the binding, then ask the
 * policy. Every fact this resolves is best-effort in the direction that keeps a
 * review OPEN — an artifact whose type cannot be read is evaluated against a
 * SILENT organization bound rather than skipped, because a review that fires
 * when it need not have is a person reading something they did not have to read,
 * and a review that silently does not fire is work nobody looked at.
 */
export async function decideDeclaredReviewForGate(
  input: DeclaredReviewRequest,
): Promise<DeclaredReviewDecision> {
  const binding = proveReviewBinding({ kind: "declared-targets", targets: input.targets });
  // Narrowed rather than asserted: the predicate is total over BOTH inputs, and a
  // declared request can only prove a declared binding — but the core is the one
  // place that says so, and letting it answer keeps this file free of a claim it
  // would have to keep true on its own.
  if (!binding.bound || binding.kind !== "declared-targets") {
    return decideDeclaredReview({ binding, perTarget: [] });
  }

  const declared = await resolveTemplateDeclarations(input.templateId, input.packageVersion);
  const manifest = declared.manifest;

  // The artifact's semantic TYPE, once per named artifact — the fact both the
  // policy below and the set-payload rule read.
  const typeOf = new Map<string, string | null>();
  for (const target of binding.targets) {
    if (typeOf.has(target.artifactId)) continue;
    typeOf.set(target.artifactId, await resolveArtifactType(input.orgId, target.artifactId));
  }

  // cinatra#3458 — "The JSON is not supposed to be presented in the review,
  // because it represents a list of artifacts, not the artifact itself." The
  // production's own list payload is left OUT of what the gate pins; its members
  // are what the work produced for a person to review. The exclusion rides the
  // same per-target filter an org bound rides — the core removes a target whose
  // answer did not fire — so there is exactly one place a target leaves a set.
  const setPayloads = setRepresentingTargetIds({
    targets: binding.targets,
    facts: binding.targets.map((target) => ({
      artifactId: target.artifactId,
      objectType: typeOf.get(target.artifactId) ?? null,
    })),
    declaredProducedTypes: declared.producedTypes,
  });

  const perTarget: PolicyDecision[] = [];
  for (const target of binding.targets) {
    if (setPayloads.has(target.artifactId)) {
      perTarget.push({
        outcome: "skip",
        fired: false,
        reason: "the artifact represents the set the work produced, not a piece of that work",
        decidedBy: "core-default",
      });
      continue;
    }
    const artifactType = typeOf.get(target.artifactId) ?? null;
    const orgRule =
      artifactType === null
        ? { bound: "silent" as const }
        : await resolveOrgPolicyRule(input.orgId, {
            checkpoint: "review",
            artifactType,
            destinationClass: DECLARED_REVIEW_DESTINATION_CLASS,
            originKind: DECLARED_REVIEW_ORIGIN_KIND,
          }).catch(() => ({ bound: "silent" as const }));
    perTarget.push(
      decideReviewPolicy({
        artifactType: artifactType ?? "",
        destinationClass: DECLARED_REVIEW_DESTINATION_CLASS,
        originKind: DECLARED_REVIEW_ORIGIN_KIND,
        // Review's core default does not branch on presence (only the
        // recommendation checkpoint does), so this is inert for this checkpoint;
        // it is passed to keep the pure input total, exactly as the produced
        // side passes it.
        humanPresent: false,
        orgRule,
        manifest,
      }),
    );
  }
  return decideDeclaredReview({ binding, perTarget });
}

/** The artifact's semantic type, or null when the row cannot be read. */
async function resolveArtifactType(orgId: string, artifactId: string): Promise<string | null> {
  try {
    const [row] = await db
      .select({ type: objectsRef.type, deletedAt: objectsRef.deletedAt })
      .from(objectsRef)
      .where(and(eq(objectsRef.id, artifactId), eq(objectsRef.orgId, orgId)))
      .limit(1);
    if (!row || row.deletedAt) return null;
    return typeof row.type === "string" ? row.type : null;
  } catch {
    return null;
  }
}

/** What ONE read of the run's template version tells the review: the producing
 *  agent's compiled lifecycle refinements, and the object types it DECLARES it
 *  produces. */
interface TemplateDeclarations {
  readonly manifest: CompiledManifestLifecycle | undefined;
  /** The declared produced object type ids; empty when the template declares
   *  none, or when nothing about this version may be trusted to speak. */
  readonly producedTypes: readonly string[];
}

/**
 * The producing agent's declarations, or the empty answer.
 *
 * VERSION-PINNED, on the same rule the produced path applies: a manifest skip
 * REMOVES a review, so a template PROVABLY on another version than the run must
 * not supply one — a reinstall would otherwise take a review off a run that
 * started before the skip was declared. The declared produced types ride the
 * SAME guard for the same reason: they decide which named artifact a gate leaves
 * out, and a version the run never executed does not get to say. An unpinned run
 * keeps its manifest, which is the behaviour it has always had.
 */
async function resolveTemplateDeclarations(
  templateId: string | null,
  runPackageVersion: string | null,
): Promise<TemplateDeclarations> {
  const none: TemplateDeclarations = { manifest: undefined, producedTypes: [] };
  if (!templateId) return none;
  try {
    const tmpl = await readAgentTemplateById(templateId);
    const pinContradicted =
      typeof runPackageVersion === "string" &&
      runPackageVersion.length > 0 &&
      typeof tmpl?.packageVersion === "string" &&
      tmpl.packageVersion !== runPackageVersion;
    if (pinContradicted) return none;
    // The EXECUTED artifact-binding declaration (cinatra#3208) carries the typed
    // `produces` refs the compile that made this template version was validated
    // against — the extension's own word on what this production produces. An
    // unreadable or absent declaration parses to null: "unknown", and unknown
    // leaves every named target pinned.
    const bindings = parseArtifactBindingDeclaration(tmpl?.artifactBindings ?? null);
    const producedTypes = (bindings?.producesRefs ?? [])
      .map((ref) => ref.objectTypeId)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    return {
      manifest: parseLifecycleConfigText(tmpl?.lifecycleConfig ?? null) ?? undefined,
      producedTypes,
    };
  } catch {
    return none;
  }
}
