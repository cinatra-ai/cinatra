// Seed the agent_templates row for an agent package the IMAGE ships.
//
// THE DEFECT THIS CLOSES. A bundled agent package's bytes are in the image and
// its OAS tree is reconciled onto the agent runtime mount at boot, but the chat's
// run resolver does not resolve a package from disk: it reads
// `agent_templates` by package name (store.ts `readAgentTemplateByPackageName`,
// called from mcp/handlers.ts) and answers "Template not found" when there is no
// row. An `installed_extension` anchor is a DIFFERENT row in a DIFFERENT table
// and does not satisfy that read. So on an image built with the development
// fleet, a fleet agent was present on disk, anchored in the catalogue, and still
// undispatchable from the chat.
//
// THE ROAD THIS TAKES — NOT A HAND-WRITTEN TEMPLATE. The row is built by the
// SAME derivation a registry install and a ZIP import use:
// `buildAgentTemplateInstallSeed` compiles the package's own `cinatra/oas.json`
// beside its already-validated `package.json#cinatra` block, and
// `createLocalAgentTemplateVersion` writes the template + its first version from
// that seed. Nothing here invents a field the install path would not have
// written; a package whose OAS does not compile, or whose manifest is not a
// valid agent-package manifest, THROWS here exactly as it would at install —
// the boot caller reports it and moves to the next package.
//
// WHERE THE BYTES COME FROM. The image's own required-OAS seed
// (`/app/.cinatra-required-oas-seed/<vendor>/<slug>/`), which is the projection
// the build stage made of the tree it acquired and the runtime stage copies in.
// It is the one source that is present in the runtime image, is the SAME bytes
// the boot reconcile writes onto the runtime mount, and does not depend on any
// other boot phase having run first.
//
// THE CLAIM IS THE INSTANCE OPERATOR'S. `PLATFORM_IDENTITY_CLAIM` — these are
// the image's own packages, not a tenant's — through the same
// `claimAgentTemplateIdentity` operation the install path runs, so a row a
// tenant already owns is ADOPTED and never overwritten, and two concurrent boots
// race to exactly one insert.
//
// IDEMPOTENT: a package that already has a row is left completely alone (no
// re-compile, no write) — this seeds what is missing, it does not reconcile what
// is there. One exception (cinatra#4264 A1b): a row that stores a
// `regenerate` list has it checked against the image's CURRENT flow. A list
// that flow no longer honours is QUARANTINED: removed from the stored column
// (every other lifecycle key kept), under the row's own claim, and the boot
// reports the package. Nothing from the image is written onto the row.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { parsePackageId } from "@cinatra-ai/registries";

import {
  PLATFORM_IDENTITY_CLAIM,
  claimAgentTemplateIdentity,
  claimOfAuthorizedTemplate,
} from "./agent-template-identity";
import { assertStoredRegenerateHonoured } from "./retained-regenerate";
import { buildAgentTemplateInstallSeed } from "./build-agent-template-seed";
import { createLocalAgentTemplateVersion } from "./import-export-actions";
import { readAgentTemplateByPackageName, updateAgentTemplate } from "./store";
import { normalizeLifecycle, serializeLifecycleConfig } from "@/lib/lifecycle/lifecycle-policy";
import { parseAgentPackageManifestForInstall } from "./verdaccio/package-contract";

/** What the seeder did for one package. Never a throw for "nothing to do". */
export type BundledAgentTemplateSeedOutcome =
  /** A row for this package name already existed — untouched. */
  | { readonly outcome: "exists" }
  /** The image ships no compilable package tree for this name under the seed. */
  | { readonly outcome: "absent"; readonly reason: string }
  /** A row was created from the image's own OAS bytes. */
  | { readonly outcome: "created"; readonly templateId: string; readonly versionId: string }
  /** The name was claimed by a tenant between the read and the write — adopted. */
  | { readonly outcome: "adopted"; readonly templateId: string };

/**
 * Resolve a bundled package's directory inside the image's OAS seed.
 *
 * The seed is keyed by the SAME naming rule the runtime mount uses —
 * `@vendor/slug` -> `<seed>/<vendor>/<slug>/` — and the name is split by
 * `parsePackageId`, the canonical splitter, BEFORE any `path.join`, so a
 * separator or traversal payload in a package name can never reach the join.
 * Returns null for an unscoped or malformed name.
 */
export function bundledAgentPackageDir(seedDir: string, packageName: string): string | null {
  const id = parsePackageId(packageName);
  if (!id || !id.vendor) return null;
  return join(seedDir, id.vendor, id.name);
}

/**
 * Remove ONLY the `regenerate` key from an existing row's readable stored
 * lifecycle column (cinatra#4264 A1b, review 2), under the row's own claim, so
 * an ownership change in between refuses instead of writing a foreign row.
 * Returns false when the text cannot be read (nothing is written). Throws when
 * the write is refused or fails: the stale list then still stands, and the
 * boot must report it as such.
 */
async function quarantineStaleRegenerate(existing: {
  id: string;
  orgId?: string | null;
  lifecycleConfig?: string | null;
}): Promise<boolean> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing.lifecycleConfig ?? "");
  } catch {
    return false;
  }
  const normalized = normalizeLifecycle(parsed);
  if (!normalized) return false;
  const { regenerate: _stale, ...rest } = normalized;
  const text = serializeLifecycleConfig(rest);
  const kept = text === "{}" ? null : text;
  const updated = await updateAgentTemplate(
    existing.id,
    { lifecycleConfig: kept },
    claimOfAuthorizedTemplate({ orgId: existing.orgId ?? null }),
  );
  if (!updated) {
    throw new Error(
      `[seed-bundled-agent-template] the stale regenerate list of row ${existing.id} could not be ` +
        "quarantined: the row moved to another owner. It still stands.",
    );
  }
  return true;
}

async function readJsonIfPresent(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/**
 * Ensure the agent_templates row the chat's run resolver reads exists for one
 * image-shipped agent package.
 *
 * `seedDir` is the image's required-OAS seed root; the caller resolves it (the
 * boot seeder passes the deploy-resolved directory), which also makes this
 * testable without a host.
 */
export async function ensureBundledAgentTemplateRecord(input: {
  packageName: string;
  /** The generated manifest's version for this package (`"0.0.0"` fallback). */
  packageVersion: string;
  seedDir: string;
}): Promise<BundledAgentTemplateSeedOutcome> {
  const existing = await readAgentTemplateByPackageName(input.packageName);
  if (existing) {
    // cinatra#4264 A1b (reviews 1 and 2): image v2 may reconcile new runtime
    // bytes without a step the row's stored list (written from image v1)
    // names. The row is never re-seeded from the image (a tenant row is never
    // overwritten by this seeder), but a stale list is ENFORCED, not only
    // logged: it is removed from the stored column (quarantined), so no
    // regenerate path reads a list the mounted flow cannot honour, and the
    // boot reports the package. Text that cannot be read refuses as is (every
    // lifecycle reader already reads it as no declaration). Rows with a NULL
    // column take the early return with no read.
    if (existing.lifecycleConfig !== null && existing.lifecycleConfig !== undefined) {
      const packageDir = bundledAgentPackageDir(input.seedDir, input.packageName);
      const oas = packageDir === null ? null : await readJsonIfPresent(join(packageDir, "cinatra", "oas.json"));
      const subject = `[seed-bundled-agent-template] ${input.packageName} (existing row, image flow)`;
      try {
        assertStoredRegenerateHonoured(existing.lifecycleConfig, oas ?? {}, subject);
      } catch (err) {
        const stale = await quarantineStaleRegenerate(existing);
        if (stale) {
          throw new Error(
            `${err instanceof Error ? err.message : String(err)}. The stored regenerate list was removed ` +
              "from the row (quarantined); reinstall the package to declare a list its flow honours.",
          );
        }
        throw err;
      }
    }
    return { outcome: "exists" };
  }

  const packageDir = bundledAgentPackageDir(input.seedDir, input.packageName);
  if (packageDir === null) {
    return { outcome: "absent", reason: `"${input.packageName}" is not a scoped package name` };
  }
  const rawManifest = await readJsonIfPresent(join(packageDir, "package.json"));
  if (rawManifest === null) {
    return { outcome: "absent", reason: `no package.json under ${packageDir}` };
  }

  // Fail-closed metadata contract, the SAME parse the install path runs first:
  // a missing/invalid `cinatra` block throws a structured contract violation
  // naming the package and the exact fields.
  const manifest = parseAgentPackageManifestForInstall(rawManifest, input.packageName);

  // The install path's own derivation, over the image's own OAS bytes. A
  // package with no compilable `cinatra/oas.json` throws here — BEFORE any DB
  // write — exactly as it does at install.
  const seed = await buildAgentTemplateInstallSeed({
    extractedTempDir: packageDir,
    packageName: input.packageName,
    packageVersion: input.packageVersion,
    manifest,
  });

  const claimed = await claimAgentTemplateIdentity(
    { packageName: input.packageName, claim: PLATFORM_IDENTITY_CLAIM },
    {
      insert: () =>
        createLocalAgentTemplateVersion({
          seed: {
            name: seed.name,
            description: seed.description,
            sourceNl: seed.sourceNl,
            compiledPlan: seed.compiledPlan,
            inputSchema: seed.inputSchema,
            outputSchema: seed.outputSchema,
            approvalPolicy: seed.approvalPolicy,
            type: seed.type,
            taskSpec: seed.taskSpec,
            snapshot: seed.snapshot,
            packageName: input.packageName,
            packageVersion: input.packageVersion,
            hitlScreens: seed.hitlScreens,
            lgGraphCode: seed.lgGraphCode,
            lgGraphId: seed.lgGraphId,
            executionProvider: seed.executionProvider ?? undefined,
            lifecycleConfig: seed.lifecycleConfig,
            hasArtifactBindings: seed.hasArtifactBindings,
            artifactBindings: seed.artifactBindings,
            publishingSteps: seed.publishingSteps,
            // The image's catalogue is the instance's OWN published set — the
            // chat resolves and dispatches what the instance publishes, and a
            // draft row is not offered there. A tenant-owned row is never
            // reached: the claim adopts it instead of writing.
            status: "published",
          },
        }),
    },
  );

  return claimed.mode === "created"
    ? { outcome: "created", templateId: claimed.created.templateId, versionId: claimed.created.versionId }
    : { outcome: "adopted", templateId: claimed.row.id };
}
