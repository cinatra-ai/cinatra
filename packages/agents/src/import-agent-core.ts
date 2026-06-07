// No "use server" — safe to import from instrumentation.node.ts and other
// server-startup paths that run outside a request scope.
//
// Contains the auth-free core of importAgentTemplate so it can be called from:
//   1. importAgentTemplate (server action, after requireAdminSession())
//   2. ensureAgentPackage / ensureAgentPackageFromGitFile (startup, no request)

import { createHash, randomUUID } from "node:crypto";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { redirect } from "next/navigation";
import {
  readAgentTemplateByPackageName,
  createAgentTemplate,
  createAgentVersion,
  updateAgentTemplate,
  updateAgentTemplateOrigin,
} from "./store";
import type { CreateAgentTemplateInput } from "./store";
// resolvePublishDestination is the gated loader for publish destination routing.
// resolvePublishDestination is called after auth gate in importAgentTemplate (the public
// server action); importAgentTemplateCore itself is auth-free (called from startup paths too).
// Origin is persisted after successful create/update to track package coordinates.
import { resolvePublishDestination } from "@cinatra-ai/extensions/destination-resolver";
import { readInstanceIdentity } from "@/lib/instance-identity-store";
import { readZipFiles } from "./zip-helpers";
import { compileOasAgentJson } from "./oas-compiler";
import { ensureDynamicObjectType } from "@cinatra-ai/objects/auto-registrar";
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";
import {
  detectSpdxLicense,
  LicenseDetectionRejectedError,
  LicenseAcknowledgementRequiredError,
} from "@cinatra-ai/extensions/license-detection";

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
  },
): Promise<{ templateId: string; upserted: boolean }> {
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
    } catch {
      // ignore malformed package.json — fall through
    }
  }

  // Stage a temp directory so the compiler's filesystem-based resolution works.
  // Layout: <tmp>/agents/<slug>/cinatra/agent.json + <tmp>/agents/<slug>/package.json
  const slug = siblingPkgName ? siblingPkgName.split("/").pop() ?? "imported" : "imported";
  const tmpRoot = join(tmpdir(), `oas-import-${randomUUID()}`);
  const cinatraDir = join(tmpRoot, "agents", slug, "cinatra");
  await mkdir(cinatraDir, { recursive: true });
  const tmpAgentJson = join(cinatraDir, "agent.json");
  await writeFile(tmpAgentJson, agentRaw, "utf8");
  if (siblingPkgRaw) {
    await writeFile(join(tmpRoot, "agents", slug, "package.json"), siblingPkgRaw, "utf8");
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
      agentJsonPath: tmpAgentJson,
    });
    if (!compileResult.ok) {
      throw new Error(
        `failed to compile OAS agent.json for ${siblingPkgName ?? slug}: ${compileResult.error}`,
      );
    }
    compiled = compileResult.value;
  } finally {
    // Cleanup temp directory regardless of compile outcome.
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }

  // Register agent-declared output object types as active.
  // actorUserId is NOT a free variable here. Use createdBy: null
  //   (install-source rows are organizationally owned).
  // compiled.packageName may be null when sibling package.json is
  //   missing or malformed. Skip the entire block in that case — never write
  //   the literal string "unknown" to originContext.
  // Skip type IDs already registered statically by @cinatra/* packages
  //   (objectTypeRegistry.resolve returns non-null). Log a console.warn on
  //   category mismatch but do not fail the install.
  if (compiled.producesObjectTypes?.length && compiled.packageName) {
    for (const pt of compiled.producesObjectTypes) {
      const staticReg = objectTypeRegistry.resolve(pt.typeId);
      if (staticReg) {
        if (staticReg.category !== pt.category) {
          console.warn(
            `[oas-install] type_id ${pt.typeId} declares category=${pt.category} but static registry has ${staticReg.category}; ignoring declaration`,
          );
        }
        continue;
      }
      await ensureDynamicObjectType({
        type: pt.typeId,
        inferredName: pt.displayName,
        inferredCategory: pt.category,
        canonicalKeys: pt.canonicalKeys ?? null,
        identityKey: pt.identityKey ?? null,
        source: "install",
        status: "active",
        createdBy: null, // no actorUserId in this scope
        originContext: { agentId: compiled.packageName },
      });
    }
  }

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

  try {
    // --- Upsert path: if packageName is present, check for an existing template ---
    if (effectivePackageName) {
      const existing = await readAgentTemplateByPackageName(effectivePackageName);
      if (existing) {
        await updateAgentTemplate(existing.id, {
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
        });

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
            });
          } catch (originErr) {
            console.warn("[importAgentTemplateCore:upsert] Origin persistence failed:", originErr);
          }
        }

        if (options?.redirect !== false) {
          redirect("/agents");
        }
        return { templateId: existing.id, upserted: true };
      }
    }

    // --- Create path ---
    const newId = randomUUID();

    await createAgentTemplate({
      id: newId,
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
        });
      } catch (originErr) {
        console.warn("[importAgentTemplateCore:create] Origin persistence failed:", originErr);
      }
    }

    if (options?.redirect !== false) {
      redirect("/agents");
    }
    return { templateId: newId, upserted: false };
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.message.includes("agent_templates_package_name_idx")
    ) {
      throw new Error(
        `Package name "${effectivePackageName}" is already registered. Use a different package name or update the existing template.`,
      );
    }
    throw err;
  }
}
