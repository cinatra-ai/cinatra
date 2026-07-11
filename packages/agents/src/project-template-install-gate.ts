// PROJECT-TEMPLATE install gate (cinatra#1032 deliverable 3) — the host-side
// AUTHORITATIVE enforcement of the typed project-template contract at install.
//
// An agent package that ships `cinatra/project-template.json` (a "specific
// project agent") must satisfy the merged contract
// (@cinatra-ai/sdk-extensions/project-template-contract) BEFORE anything
// mutates:
//   1. the file parses as JSON,
//   2. `validateProjectTemplate` passes (collect-ALL structural violations),
//   3. every template worker ref EXACT-MATCHES a manifest
//      `cinatra.dependencies` edge by packageName AND versionConstraint
//      (`checkTemplateWorkerRefsAgainstDependencies` — the "one truth source"
//      rule: a template can never name an executable dependency the manifest
//      does not declare).
//
// The gate runs inside install-from-package's INERT window (after the manifest
// + dependency-edge parses, before the disk materialize and any DB write), so
// a refusal mutates nothing. A violation throws the STRUCTURED
// ProjectTemplateContractViolationError (the AgentPackageContractViolationError
// pattern: stable code, statusCode 422, per-violation paths) — never a raw
// parse error.
//
// A package with NO `cinatra/project-template.json` is not a project-template
// package: the gate no-ops (`present: false`).
//
// The author-facing PRE-PUBLISH mirror of these rules lives in the cinatra-cli
// extension-kind-gate (self-contained by design); THIS module is the enforcer
// of record on the install pipeline.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ExtensionDependency } from "@cinatra-ai/sdk-extensions/dependencies";
import {
  validateProjectTemplate,
  checkTemplateWorkerRefsAgainstDependencies,
  type ProjectTemplate,
  type ProjectTemplateViolation,
} from "@cinatra-ai/sdk-extensions/project-template-contract";

/** The in-package path of a typed project template (beside `cinatra/oas.json`). */
export const PROJECT_TEMPLATE_PACKAGE_PATH = "cinatra/project-template.json";

export const PROJECT_TEMPLATE_CONTRACT_VIOLATION_CODE =
  "PROJECT_TEMPLATE_CONTRACT_VIOLATION" as const;

/**
 * Structured install refusal for a project-template contract violation.
 * `code` is a STABLE literal (the AGENT_PACKAGE_CONTRACT_VIOLATION convention)
 * so batch-saga/MCP surfaces can key on it structurally without importing this
 * module; `statusCode` 422 marks invalid PACKAGE CONTENT, not a server fault.
 */
export class ProjectTemplateContractViolationError extends Error {
  readonly code = PROJECT_TEMPLATE_CONTRACT_VIOLATION_CODE;
  readonly statusCode: number;
  readonly packageName: string;
  readonly violations: readonly ProjectTemplateViolation[];

  constructor(opts: {
    packageName: string;
    violations: readonly ProjectTemplateViolation[];
    statusCode?: number;
  }) {
    super(
      `Agent package "${opts.packageName}" ships a cinatra/project-template.json that ` +
        `violates the project-template contract: ` +
        opts.violations.map((v) => `[${v.code}] ${v.path || "(root)"}: ${v.message}`).join("; ") +
        `. Fix the template (or its cinatra.dependencies edges) and republish.`,
    );
    this.name = "ProjectTemplateContractViolationError";
    this.statusCode = opts.statusCode ?? 422;
    this.packageName = opts.packageName;
    this.violations = opts.violations;
  }
}

export type ProjectTemplateInstallGateResult =
  | { present: false }
  | { present: true; template: ProjectTemplate };

/**
 * Enforce the project-template contract for an extracted agent package. See
 * the module header. Returns the validated template when one ships (so the
 * caller never re-parses); throws ProjectTemplateContractViolationError on any
 * violation; `{ present: false }` when the package ships no template.
 */
export async function enforceProjectTemplateInstallContract(input: {
  extractedTempDir: string;
  packageName: string;
  dependencyEdges: ExtensionDependency[];
}): Promise<ProjectTemplateInstallGateResult> {
  let raw: string;
  try {
    raw = await readFile(join(input.extractedTempDir, PROJECT_TEMPLATE_PACKAGE_PATH), "utf8");
  } catch (err) {
    if ((err as { code?: string } | null)?.code === "ENOENT") {
      return { present: false };
    }
    // Present but unreadable is an integrity problem, not "no template".
    throw new ProjectTemplateContractViolationError({
      packageName: input.packageName,
      violations: [
        {
          code: "template_unreadable",
          path: "",
          message: `${PROJECT_TEMPLATE_PACKAGE_PATH} exists but could not be read: ${
            err instanceof Error ? err.message : String(err)
          }`,
        },
      ],
    });
  }

  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch (err) {
    throw new ProjectTemplateContractViolationError({
      packageName: input.packageName,
      violations: [
        {
          code: "template_unparsable",
          path: "",
          message: `${PROJECT_TEMPLATE_PACKAGE_PATH} is not valid JSON: ${
            err instanceof Error ? err.message : String(err)
          }`,
        },
      ],
    });
  }

  const validation = validateProjectTemplate(candidate);
  if (!validation.valid) {
    throw new ProjectTemplateContractViolationError({
      packageName: input.packageName,
      violations: validation.violations,
    });
  }

  const workerRefViolations = checkTemplateWorkerRefsAgainstDependencies(
    validation.template,
    input.dependencyEdges,
  );
  if (workerRefViolations.length > 0) {
    throw new ProjectTemplateContractViolationError({
      packageName: input.packageName,
      violations: workerRefViolations,
    });
  }

  return { present: true, template: validation.template };
}
