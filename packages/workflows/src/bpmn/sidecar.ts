// Sidecar manifest parser (BPMN-05). At workflow-extension install time the
// installer locates EXACTLY ONE canonical `cinatra/workflow.bpmn` at the package
// root, parses + Profile-validates + compiles it, and derives the install manifest
// `{ key, version, name, description, definition }` — the SAME shape the legacy
// inline `package.json#cinatra.workflow` provided, so it flows into the unchanged
// `installWorkflowTemplate(manifest, scope)` boundary.
//
// Fails CLOSED on: inline JSON definition present, missing/non-integer
// workflowVersion, missing canonical sidecar, duplicate sidecar, parse error,
// unsupported construct, or compile error.

import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { parseWorkflowTemplateManifest, type WorkflowTemplateManifest } from "../manifest";
import { BPMN_ERROR_CODES, BpmnCompileException, type BpmnSidecarError } from "./errors";
import { parseBpmnXml } from "./moddle";
import { validateBpmnAgainstProfile } from "./profile";
import { compileBpmnToWorkflowSpec } from "./compile";

const CANONICAL_REL = join("cinatra", "workflow.bpmn");
const SIDECAR_BASENAME = "workflow.bpmn";
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".next", ".turbo"]);

export type SidecarParseResult =
  | { ok: true; manifest: WorkflowTemplateManifest }
  | { ok: false; errors: BpmnSidecarError[] };

type PkgCinatra = { workflow?: unknown; workflowVersion?: unknown; kind?: unknown; apiVersion?: unknown };

function err(code: BpmnSidecarError["code"], detail: string): BpmnSidecarError {
  return { code, detail };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

// Recursively collect every `workflow.bpmn` whose parent dir is named `cinatra`
// under the package root (skipping build/vendor dirs) so a nested copy is detected
// as a duplicate.
async function findAllSidecars(root: string): Promise<string[]> {
  const hits: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        await walk(join(dir, e.name));
      } else if (e.isFile() && e.name === SIDECAR_BASENAME) {
        const full = join(dir, e.name);
        // only count files whose parent dir is named "cinatra"
        const parts = relative(root, full).split(sep);
        if (parts.length >= 2 && parts[parts.length - 2] === "cinatra") hits.push(full);
      }
    }
  }
  await walk(root);
  return hits;
}

/**
 * Parse the BPMN sidecar for a workflow extension package.
 * @param args.packageRoot absolute path to the extension package root.
 * @param args.pkgCinatra  the `package.json#cinatra` block.
 */
export async function parseWorkflowBpmnSidecar(args: {
  packageRoot: string;
  pkgCinatra: PkgCinatra;
}): Promise<SidecarParseResult> {
  const { packageRoot, pkgCinatra } = args;
  const errors: BpmnSidecarError[] = [];

  // 1. inline JSON definition is forbidden.
  if (pkgCinatra.workflow !== undefined) {
    errors.push(err(BPMN_ERROR_CODES.inlineDefinitionForbidden, "package.json#cinatra.workflow inline definition is forbidden; ship cinatra/workflow.bpmn instead"));
  }

  // 2. integer companion version is required.
  const version = pkgCinatra.workflowVersion;
  if (typeof version !== "number" || !Number.isInteger(version) || version <= 0) {
    errors.push(err(BPMN_ERROR_CODES.workflowVersionMissing, `package.json#cinatra.workflowVersion must be a positive integer (got ${JSON.stringify(version)})`));
  }

  // 3. canonical sidecar must exist at <packageRoot>/cinatra/workflow.bpmn.
  const canonical = join(packageRoot, CANONICAL_REL);
  const canonicalExists = await fileExists(canonical);
  if (!canonicalExists) {
    errors.push(err(BPMN_ERROR_CODES.sidecarMissing, `missing canonical sidecar at ${CANONICAL_REL}`));
  } else {
    // 4. no extra (nested) sidecars.
    const all = await findAllSidecars(packageRoot);
    if (all.length > 1) {
      errors.push(err(BPMN_ERROR_CODES.sidecarDuplicate, `expected exactly one cinatra/workflow.bpmn, found ${all.length}: ${all.map((p) => relative(packageRoot, p)).join(", ")}`));
    }
  }

  // If structural preconditions failed, stop before parsing.
  if (errors.length > 0 || !canonicalExists) {
    return { ok: false, errors };
  }

  // 5. parse XML.
  let xml: string;
  try {
    xml = await readFile(canonical, "utf8");
  } catch (e) {
    return { ok: false, errors: [err(BPMN_ERROR_CODES.parseError, `could not read ${CANONICAL_REL}: ${e instanceof Error ? e.message : String(e)}`)] };
  }
  const parsed = await parseBpmnXml(xml);
  if (!parsed.ok) return { ok: false, errors: [err(parsed.code, parsed.detail)] };

  // 6. Profile 1.0 validation.
  const profile = validateBpmnAgainstProfile(parsed.definitions);
  if (!profile.ok) {
    const constructErrors = profile.errors.map((e) => err(BPMN_ERROR_CODES.unsupportedConstruct, `${e.elementType}${e.elementId ? ` (${e.elementId})` : ""}: ${e.reason}`));
    const structErrors = profile.structureErrors.map((s) => err(BPMN_ERROR_CODES.structureInvalid, s));
    return { ok: false, errors: [...constructErrors, ...structErrors] };
  }

  // 7. compile + derive manifest.
  let definition;
  try {
    definition = compileBpmnToWorkflowSpec(parsed.definitions);
  } catch (e) {
    if (e instanceof BpmnCompileException) return { ok: false, errors: [err(e.error.code, e.error.reason)] };
    return { ok: false, errors: [err(BPMN_ERROR_CODES.parseError, e instanceof Error ? e.message : String(e))] };
  }

  const proc = (parsed.definitions as { rootElements?: Array<{ $type: string; id?: string; name?: string; documentation?: Array<{ text?: string }> }> }).rootElements?.find((r) => r.$type === "bpmn:Process");
  const key = (proc?.id ?? definition.key) as string;
  const name = proc?.name ?? definition.name;
  const description = proc?.documentation?.[0]?.text;

  const manifest: WorkflowTemplateManifest = {
    key,
    version: version as number,
    name,
    ...(description ? { description } : {}),
    definition,
  };

  // Run the full template validator (DAG / cycle / duplicate-dependency /
  // foreach-source / trigger-bundling checks) on the derived manifest so CI and
  // install fail BEFORE a structurally-invalid-but-schema-valid BPMN reaches the
  // store. `installWorkflowTemplate` re-runs this at install; doing it here makes
  // the sidecar parser (and the BPMN gate) a complete validation boundary.
  const validated = parseWorkflowTemplateManifest(manifest);
  if (!validated.ok) {
    return { ok: false, errors: validated.errors.map((m) => err(BPMN_ERROR_CODES.structureInvalid, m)) };
  }
  return { ok: true, manifest: validated.manifest };
}
