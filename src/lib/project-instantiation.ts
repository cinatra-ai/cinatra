import "server-only";

// PROJECT INSTANTIATION primitive (cinatra#1032 deliverable 3) — the host
// seam that creates the project-instance binding record a PM project runs
// under. This is where the ratified once-at-instantiation decisions are
// ENFORCED (the pilot's project-manager agent calls this; it never re-decides
// any of them):
//
//   1. PM-SEAT KIND GATE — only a project-management agent (an installed
//      agent whose manifest declares the `pm-work-store` capability binding at
//      requirement "required") may own a project template at runtime / hold
//      the PM seat. Fail-closed: an unresolvable seat manifest refuses.
//   2. TEMPLATE AUTHORITY — the template is read from the SEAT-independent
//      installed template package's FINALIZED store payload (never
//      caller-supplied bytes), re-validated, and its worker refs re-checked
//      against that SAME package's manifest dependency edges (defense in
//      depth over the install gate — one truth source).
//   3. PROVIDER SELECTION — the PM work-store provider is chosen ONCE here
//      (configured wins; auto iff exactly one connected; fail-closed on
//      none/several) and persisted on the instance. No runtime path re-runs
//      selection.
//   4. STICKINESS — an existing (org, projectRef) instance is idempotent
//      success when the requested binding matches it, and a LOUD
//      INSTANCE_DRIFT refusal when it does not (a project can never silently
//      migrate between PM tools, templates, or seats). A lost creation race
//      converges through the same drift predicate.
//
// Never throws: every failure resolves to a structured outcome (the dispatch
// primitive's contract).

import {
  createProjectInstance,
  readProjectInstance,
  type ProjectInstanceRecord,
} from "@cinatra-ai/agents/project-instance-store";
import { checkTemplateWorkerRefsAgainstDependencies } from "@cinatra-ai/sdk-extensions/project-template-contract";
import { parseManifestDependencyEdges } from "@cinatra-ai/extensions/manifest-dependencies";
import {
  agentManifestDeclaresPmSeat,
  resolveInstalledAgentManifest,
  resolveInstalledProjectTemplate,
} from "@/lib/project-template-resolve";
import {
  connectedPmWorkStoreProviderIds,
  selectPmWorkStoreProvider,
} from "@/lib/pm-work-store-selection";

export type ProjectInstantiationRejectionCode =
  | "INVALID_INPUT"
  | "TEMPLATE_UNRESOLVED"
  | "TEMPLATE_INVALID"
  | "NOT_PM_SEAT"
  | "INSTANCE_DRIFT"
  | "PROVIDER_CONFIGURED_NOT_CONNECTED"
  | "PROVIDER_NONE_CONNECTED"
  | "PROVIDER_AMBIGUOUS";

export type ProjectInstantiationOutcome =
  | { status: "instantiated"; instance: ProjectInstanceRecord }
  | {
      /** A matching instance already existed (or won a concurrent race) —
       *  idempotent success with the PERSISTED binding. */
      status: "already_instantiated";
      instance: ProjectInstanceRecord;
    }
  | { status: "rejected"; code: ProjectInstantiationRejectionCode; message: string }
  | { status: "failed"; code: "PROJECT_INSTANTIATION_FAILED"; message: string };

export type ProjectInstantiationInput = {
  /** Auth-derived tenant org — NEVER a body id (tenancy operand). */
  orgId: string;
  /** The PM project scope — the natural-key prefix of the project's items. */
  projectRef: string;
  /** Optional cinatra project refinement (persisted; child dispatches inherit it). */
  projectId?: string | null;
  /** The installed agent package shipping `cinatra/project-template.json`. */
  templatePackage: string;
  /** The PM SEAT — the project-management agent package (kind-gated here). */
  pmAgentPackage: string;
  /** Explicitly configured PM work-store provider id (wins over auto). */
  configuredProviderId?: string | null;
};

/** The sticky-binding drift predicate — the fields an existing instance must
 *  match for a re-instantiation to be idempotent. Provider drift is judged
 *  only when the caller CONFIGURED a provider (an auto request converges onto
 *  whatever was persisted — re-running auto against today's connected set is
 *  exactly the silent-migration hazard stickiness exists to prevent). */
function instanceDrift(
  existing: ProjectInstanceRecord,
  requested: ProjectInstantiationInput,
  requestedTemplateId: string,
): string | null {
  if (existing.templatePackage !== requested.templatePackage) {
    return `template package "${requested.templatePackage}" differs from the persisted "${existing.templatePackage}"`;
  }
  if (existing.templateId !== requestedTemplateId) {
    return `template id "${requestedTemplateId}" differs from the persisted "${existing.templateId}"`;
  }
  if (existing.pmAgentPackage !== requested.pmAgentPackage) {
    return `PM seat "${requested.pmAgentPackage}" differs from the persisted "${existing.pmAgentPackage}"`;
  }
  const configured = requested.configuredProviderId?.trim();
  if (configured && configured !== existing.providerId) {
    return `configured provider "${configured}" differs from the persisted "${existing.providerId}" — a project never migrates PM tools implicitly`;
  }
  if (
    requested.projectId !== undefined &&
    (requested.projectId ?? null) !== existing.projectId
  ) {
    return `projectId "${requested.projectId ?? "null"}" differs from the persisted "${existing.projectId ?? "null"}"`;
  }
  return null;
}

/**
 * Instantiate (or idempotently re-resolve) a PM project instance. See the
 * module header for the enforced invariants. Never throws.
 */
export async function instantiateProject(
  input: ProjectInstantiationInput,
): Promise<ProjectInstantiationOutcome> {
  try {
    // ---- 0. Deterministic input validation ------------------------------
    for (const [field, value] of [
      ["orgId", input.orgId],
      ["projectRef", input.projectRef],
      ["templatePackage", input.templatePackage],
      ["pmAgentPackage", input.pmAgentPackage],
    ] as const) {
      if (typeof value !== "string" || value.trim().length === 0) {
        return {
          status: "rejected",
          code: "INVALID_INPUT",
          message: `${field} must be a non-empty string`,
        };
      }
    }

    // ---- 1. Template authority: installed bytes, re-validated ------------
    const templateResolution = await resolveInstalledProjectTemplate(
      input.templatePackage,
      input.orgId,
    );
    if (!templateResolution.ok) {
      if (templateResolution.reason === "template_invalid") {
        return {
          status: "rejected",
          code: "TEMPLATE_INVALID",
          message: `installed template of "${input.templatePackage}" fails the contract: ${templateResolution.detail ?? "invalid"}`,
        };
      }
      return {
        status: "rejected",
        code: "TEMPLATE_UNRESOLVED",
        message:
          templateResolution.reason === "no_template"
            ? `installed package "${input.templatePackage}" ships no cinatra/project-template.json`
            : `no finalized install of "${input.templatePackage}" is resolvable for org ${input.orgId}`,
      };
    }
    const template = templateResolution.template;

    // Worker-ref exact-match re-check against the SAME installed manifest's
    // dependency edges (the install gate's rule, re-asserted at runtime).
    let workerRefViolations;
    try {
      const edges = parseManifestDependencyEdges(templateResolution.manifest, {
        packageName: input.templatePackage,
      }).edges;
      workerRefViolations = checkTemplateWorkerRefsAgainstDependencies(template, edges);
    } catch (err) {
      return {
        status: "rejected",
        code: "TEMPLATE_INVALID",
        message: `installed manifest of "${input.templatePackage}" has unreadable dependency edges: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    if (workerRefViolations.length > 0) {
      return {
        status: "rejected",
        code: "TEMPLATE_INVALID",
        message:
          `template worker refs violate the one-truth-source rule: ` +
          workerRefViolations.map((v) => `[${v.code}] ${v.path}`).join("; "),
      };
    }

    // ---- 2. PM-seat kind gate (fail-closed) ------------------------------
    const seat = await resolveInstalledAgentManifest(input.pmAgentPackage, input.orgId);
    if (!seat) {
      return {
        status: "rejected",
        code: "NOT_PM_SEAT",
        message: `no finalized install of "${input.pmAgentPackage}" is resolvable for org ${input.orgId} — the PM seat must be an installed agent (fail-closed)`,
      };
    }
    if (!agentManifestDeclaresPmSeat(seat.manifest)) {
      return {
        status: "rejected",
        code: "NOT_PM_SEAT",
        message: `"${input.pmAgentPackage}" does not declare the required pm-work-store capability binding (cinatra.consumes) — only a project-management agent can own project templates`,
      };
    }

    // ---- 3. Sticky existing instance -------------------------------------
    const existing = await readProjectInstance(input.orgId, input.projectRef);
    if (existing) {
      const drift = instanceDrift(existing, input, template.id);
      if (drift) {
        return { status: "rejected", code: "INSTANCE_DRIFT", message: drift };
      }
      return { status: "already_instantiated", instance: existing };
    }

    // ---- 4. Once-at-instantiation provider selection ----------------------
    const selection = selectPmWorkStoreProvider({
      configuredProviderId: input.configuredProviderId ?? null,
      connectedProviderIds: connectedPmWorkStoreProviderIds(),
    });
    if (selection.kind === "rejected") {
      const connected = selection.connectedProviderIds.join(", ") || "(none)";
      switch (selection.reason) {
        case "invalid_configured":
          return {
            status: "rejected",
            code: "INVALID_INPUT",
            message: "configuredProviderId must be a non-blank string when supplied",
          };
        case "configured_not_connected":
          return {
            status: "rejected",
            code: "PROVIDER_CONFIGURED_NOT_CONNECTED",
            message: `configured provider "${input.configuredProviderId?.trim()}" is not connected (connected: ${connected})`,
          };
        case "none_connected":
          return {
            status: "rejected",
            code: "PROVIDER_NONE_CONNECTED",
            message: "no PM work-store provider is connected — connect one (e.g. a PM connector) or configure one explicitly",
          };
        case "ambiguous":
          return {
            status: "rejected",
            code: "PROVIDER_AMBIGUOUS",
            message: `several PM work-store providers are connected (${connected}) — configure one explicitly; auto-selection never guesses`,
          };
      }
    }

    // ---- 5. Persist (race converges through the drift predicate) ---------
    const { created, instance } = await createProjectInstance({
      orgId: input.orgId,
      projectRef: input.projectRef,
      projectId: input.projectId ?? null,
      templatePackage: input.templatePackage,
      templateId: template.id,
      // Provenance: the digest of the finalized install the template bytes came
      // from. NOT part of the drift predicate — re-instantiating after a
      // legitimate template-package update must stay idempotent; the digest
      // makes content evolution auditable and feeds the future rebinding valve.
      templateDigest: templateResolution.digest,
      pmAgentPackage: input.pmAgentPackage,
      providerId: selection.providerId,
      providerMode: selection.mode,
    });
    if (!created) {
      const drift = instanceDrift(instance, input, template.id);
      if (drift) {
        return { status: "rejected", code: "INSTANCE_DRIFT", message: drift };
      }
      return { status: "already_instantiated", instance };
    }
    return { status: "instantiated", instance };
  } catch (err) {
    return {
      status: "failed",
      code: "PROJECT_INSTANTIATION_FAILED",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
