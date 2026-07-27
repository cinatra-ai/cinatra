// The per-agent execution-config VIEW MODEL (exec-plane S3 slice B,
// cinatra#1708; epic #1705).
//
// Pure: given the two possible declaration sources, the agent's stored posture
// and the tri-state execution-service readiness, it produces everything the
// surface renders. No I/O, no React — so the two rules that are easy to get
// silently wrong are unit-testable:
//
//  1. EDITABILITY follows AUTHORITY (epic D8). A packaged agent's environment
//     is owned by its manifest; the surface renders it read-only and names the
//     review path. Only a project agent's config is editable in place.
//  2. DORMANCY IS STATED, NEVER FAKED. The execution plane is OFF by default
//     today. A surface that renders a declared environment as though it were
//     running would be lying, and one that hides the configuration because the
//     plane is off would make the plane impossible to prepare for. So the
//     configuration is always shown and always labelled with what it is doing
//     right now — nothing, until the plane is switched on.
//
// The promotion affordance ("installed pandoc on 6 of the last 10 runs — add
// it to the declared environment?") is rendered from OBSERVED ad-hoc installs.
// With the plane dormant there are no runs and therefore no observations, so
// the affordance renders its own honest empty state rather than an invented
// suggestion.

import {
  EXECUTION_ENVIRONMENT_MANAGERS,
  type ExecutionEnvironmentManager,
  type ExecutionEnvironmentSpec,
} from "@cinatra-ai/sdk-extensions";
import {
  EXECUTION_ENVIRONMENT_STARTER_TEMPLATES,
  countDeclaredEntries,
  environmentToEditorText,
  resolveAgentEnvironmentAuthority,
  type ExecutionEnvironmentAuthority,
  type ExecutionEnvironmentStarterTemplate,
} from "@cinatra-ai/agents/execution-config";
import type { ExecutionServiceState } from "@/lib/execution/register-execution-environment-service";

/** The tri-state toggle value the editor round-trips. */
export type ExecutionPostureValue = "inherit" | "on" | "off";

/**
 * A promotion candidate as the surface renders it. Structurally identical to
 * the execution-plane's `PromotionCandidate` — restated here so this view model
 * (and every consumer of it) stays free of a runtime execution-plane import;
 * the plane's barrel pulls the docker seam.
 */
export type PromotionCandidateView = {
  manager: ExecutionEnvironmentManager;
  packageName: string;
  runCount: number;
  windowRuns: number;
};

export type ExecutionPlaneDormancy = {
  /** True whenever a declared environment cannot actually be built/mounted. */
  dormant: boolean;
  state: ExecutionServiceState;
  headline: string;
  detail: string;
};

export type AgentExecutionConfigView = {
  packageName: string;
  displayName: string;
  templateId: string | null;
  authority: ExecutionEnvironmentAuthority;
  /** Canonical declared spec, or null when the declaration is INVALID. */
  spec: ExecutionEnvironmentSpec | null;
  /** Fail-closed parser errors (non-empty exactly when `spec` is null). */
  errors: string[];
  /** The declaration is absent/empty ⇒ the agent runs on the base image. */
  empty: boolean;
  entryCount: number;
  /** Editable in place — true only for `authority: "config"`. */
  editable: boolean;
  /** Why the surface is read-only (null when editable). */
  readOnlyReason: string | null;
  /**
   * Set when the agent ships as a PACKAGED extension whose manifest declares
   * NO environment, so anything declared here is an INSTANCE-LOCAL addition.
   * The surface says so plainly — an operator must never read a local addition
   * as something the package asked for, and must know a later package
   * declaration takes over.
   */
  localDeclarationNote: string | null;
  editorText: Record<ExecutionEnvironmentManager, string>;
  posture: ExecutionPostureValue;
  /** One-line statement of what the posture means right now. */
  postureSummary: string;
  dormancy: ExecutionPlaneDormancy;
  starterTemplates: readonly ExecutionEnvironmentStarterTemplate[];
  promotionCandidates: PromotionCandidateView[];
  /** Honest note when there is nothing to promote (empty otherwise). */
  promotionEmptyNote: string | null;
};

const PACKAGED_READ_ONLY_REASON =
  "This agent's environment is declared in its package manifest " +
  "(cinatra.execution.environment). Changing it rides the extension's own " +
  "review and lock choreography — edit the manifest and publish a new version.";

const MANIFEST_UNREADABLE_REASON =
  "This agent's package manifest could not be read, so its declared environment " +
  "cannot be edited here. Reinstall or repair the package first.";

/** Resolve the dormancy banner from the tri-state service readiness. */
export function describeExecutionPlaneDormancy(
  state: ExecutionServiceState,
): ExecutionPlaneDormancy {
  if (state === "ready") {
    return {
      dormant: false,
      state,
      headline: "The execution plane is on.",
      detail:
        "A declared environment is built once, cached, and mounted read-only into " +
        "every run of this agent.",
    };
  }
  if (state === "disabled") {
    return {
      dormant: true,
      state,
      headline: "The execution plane is off on this instance.",
      detail:
        "Configuration here is stored and reviewed as usual, but nothing is built " +
        "or mounted yet. While the plane is off, a run of an agent that DECLARES an " +
        "environment is refused rather than quietly running without its packages; " +
        "agents that declare none are unaffected. A declared environment starts " +
        "being built the moment the plane is switched on.",
    };
  }
  return {
    dormant: true,
    state,
    headline: "The execution plane is switched on but cannot run.",
    detail:
      "The instance is opted in, but the sandbox executor is not available. A run " +
      "that declares an environment is refused rather than quietly running without " +
      "its packages — check the execution-plane health surface.",
  };
}

function describePosture(
  posture: ExecutionPostureValue,
  dormant: boolean,
): string {
  if (posture === "off") {
    return "Execution is switched off for this agent. It never gets a sandbox, and it cannot declare an environment.";
  }
  const base =
    posture === "on"
      ? "Execution is switched on for this agent."
      : "Execution follows the instance default for this agent.";
  return dormant
    ? `${base} The plane is off today, so this takes effect once it is switched on.`
    : base;
}

export function postureFromStored(
  executionEnabled: boolean | null | undefined,
): ExecutionPostureValue {
  if (executionEnabled === true) return "on";
  if (executionEnabled === false) return "off";
  return "inherit";
}

export function buildAgentExecutionConfigView(input: {
  packageName: string;
  displayName: string;
  templateId?: string | null;
  manifestEnvironment?: unknown;
  templateEnvironment?: unknown;
  manifestReadFailed?: boolean;
  /** The agent ships as a packaged extension (a manifest was found). */
  packaged?: boolean;
  executionEnabled?: boolean | null;
  serviceState: ExecutionServiceState;
  promotionCandidates?: readonly PromotionCandidateView[];
}): AgentExecutionConfigView {
  const resolved = resolveAgentEnvironmentAuthority({
    manifestEnvironment: input.manifestEnvironment,
    templateEnvironment: input.templateEnvironment,
    manifestReadFailed: input.manifestReadFailed,
  });
  const dormancy = describeExecutionPlaneDormancy(input.serviceState);
  const posture = postureFromStored(input.executionEnabled);
  const editable = resolved.authority === "config" && input.templateId != null;
  const readOnlyReason = editable
    ? null
    : input.manifestReadFailed
      ? MANIFEST_UNREADABLE_REASON
      : resolved.authority === "manifest"
        ? PACKAGED_READ_ONLY_REASON
        : "This agent has no editable configuration record on this instance.";

  const localDeclarationNote =
    editable && input.packaged
      ? "This agent's package declares no environment, so anything declared here is " +
        "an instance-local addition — it applies on this instance only, and a future " +
        "package version that declares its own environment takes over."
      : null;

  const candidates = [...(input.promotionCandidates ?? [])];
  const promotionEmptyNote =
    candidates.length > 0
      ? null
      : dormancy.dormant
        ? "Nothing to promote yet — the execution plane is off, so no run has installed anything ad hoc."
        : "Nothing to promote yet — no package has been installed ad hoc often enough to suggest declaring it.";

  return {
    packageName: input.packageName,
    displayName: input.displayName,
    templateId: input.templateId ?? null,
    authority: resolved.authority,
    spec: resolved.spec,
    errors: resolved.errors,
    empty: resolved.empty,
    entryCount: countDeclaredEntries(resolved.spec),
    editable,
    readOnlyReason,
    localDeclarationNote,
    editorText: environmentToEditorText(resolved.spec),
    posture,
    postureSummary: describePosture(posture, dormancy.dormant),
    dormancy,
    starterTemplates: EXECUTION_ENVIRONMENT_STARTER_TEMPLATES,
    promotionCandidates: candidates,
    promotionEmptyNote,
  };
}

/** Manager label + hint pairs, in canonical order — shared by every renderer. */
export const EXECUTION_MANAGER_FIELDS: readonly {
  manager: ExecutionEnvironmentManager;
  label: string;
  hint: string;
}[] = EXECUTION_ENVIRONMENT_MANAGERS.map((manager) =>
  manager === "os"
    ? {
        manager,
        label: "System packages",
        hint: "Debian package names, e.g. pandoc or ffmpeg=7:6.1-1. Installed once at build time.",
      }
    : manager === "pip"
      ? {
          manager,
          label: "Python packages",
          hint: "Requirement specifiers, e.g. pandas>=2 or httpx[http2]. Registry installs only.",
        }
      : {
          manager,
          label: "npm packages",
          hint: "Package specifiers, e.g. prettier or @scope/name@^3. Registry installs only.",
        },
);
