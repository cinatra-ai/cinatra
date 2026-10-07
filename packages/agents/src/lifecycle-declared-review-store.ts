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
 * policy. Artifact and organization-rule read failures propagate: replacing an
 * unreadable required bound with SILENT would let a manifest skip remove the
 * required review (cinatra#3948). A successful absent/deleted artifact reading
 * retains its existing default behavior. The template manifest remains
 * best-effort: losing a skip can add review but cannot weaken an org bound.
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

  const manifest = await resolveTemplateManifest(input.templateId, input.packageVersion);
  const perTarget: PolicyDecision[] = [];
  for (const target of binding.targets) {
    const artifactType = await resolveArtifactType(input.orgId, target.artifactId);
    const orgRule =
      artifactType === null
        ? { bound: "silent" as const }
        : await resolveOrgPolicyRule(input.orgId, {
            checkpoint: "review",
            artifactType,
            destinationClass: DECLARED_REVIEW_DESTINATION_CLASS,
            originKind: DECLARED_REVIEW_ORIGIN_KIND,
          });
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

/** The artifact's semantic type, or null for a successfully read absent/deleted
 * row. A failed read is not an absent row and must not bypass organization policy. */
async function resolveArtifactType(orgId: string, artifactId: string): Promise<string | null> {
  const [row] = await db
    .select({ type: objectsRef.type, deletedAt: objectsRef.deletedAt })
    .from(objectsRef)
    .where(and(eq(objectsRef.id, artifactId), eq(objectsRef.orgId, orgId)))
    .limit(1);
  if (!row || row.deletedAt) return null;
  return typeof row.type === "string" ? row.type : null;
}

/**
 * The producing agent's compiled lifecycle refinements, or undefined.
 *
 * VERSION-PINNED, on the same rule the produced path applies: a manifest skip
 * REMOVES a review, so a template PROVABLY on another version than the run must
 * not supply one — a reinstall would otherwise take a review off a run that
 * started before the skip was declared. An unpinned run keeps its manifest,
 * which is the behaviour it has always had.
 */
async function resolveTemplateManifest(
  templateId: string | null,
  runPackageVersion: string | null,
): Promise<CompiledManifestLifecycle | undefined> {
  if (!templateId) return undefined;
  try {
    const tmpl = await readAgentTemplateById(templateId);
    const pinContradicted =
      typeof runPackageVersion === "string" &&
      runPackageVersion.length > 0 &&
      typeof tmpl?.packageVersion === "string" &&
      tmpl.packageVersion !== runPackageVersion;
    if (pinContradicted) return undefined;
    return parseLifecycleConfigText(tmpl?.lifecycleConfig ?? null) ?? undefined;
  } catch {
    return undefined;
  }
}
