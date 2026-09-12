// ---------------------------------------------------------------------------
// archive-supplied-install.ts — THE FILE ROAD'S DRIVER (cinatra#3204 leg 3,
// criteria 1-5, 18-20).
//
// The repository road already has one (src/lib/repository-supplied-install.ts,
// leg 2). This is its twin for a package the operator hands over as a FILE, and
// it is deliberately the same three-part composition, adding nothing to the gate
// set:
//
//   the READER (packages/agents/upload-archive, leg 1) — which reads the ZIP,
//   refuses a traversing/absolute/symlink entry and an over-cap archive before
//   inflating anything, resolves the DECLARED kind for all four live kinds, and
//   computes the content digest over the delivered tree;
//
//   the PACKER (supplied-package-tarball) — which turns that delivered tree into
//   the npm-layout tarball the store already materializes;
//
//   leg 1's ENTRY (installExtensionFromSuppliedSnapshot) — which runs the SAME
//   gate set a registry install runs, re-verifies the digest over what actually
//   landed, and records honest `local` provenance instead of a registry row.
//
// The two judgements this module makes are:
//
//   THE RE-READ. The server never trusts the browser's parse. The action hands
//   over the archive BYTES; the tree, the kind, the identity and the digest are
//   all resolved again HERE. A client that lies about the kind is simply
//   ignored, because its claim is never read.
//
//   THE KIND'S OWN VALIDATOR, BEFORE ANY MUTATION (criterion 4). The resolved
//   kind's registered handler is asked to validate the parsed manifest, and an
//   invalid package is refused before the packer runs, before the store is
//   touched, and therefore before anything durable exists to undo. A kind whose
//   handler declares no validator is reported as such rather than silently
//   treated as validated.
//
// NOTHING HERE EXECUTES PACKAGE CODE: the reader parses JSON, the validator
// compares strings and schemas, and the packer copies bytes.
// ---------------------------------------------------------------------------

import {
  isSuppliedPackageProvenance,
  type ResolvedSuppliedPackageTree,
  type SuppliedPackageKind,
  type SuppliedPackageProvenance,
} from "@cinatra-ai/extension-types";
import { readZipEntries, resolveSuppliedArchive } from "@cinatra-ai/agents/upload-archive";
import {
  installExtensionFromSuppliedSnapshot,
  type InstallPipelineResult,
  type SuppliedInstallPipelineDeps,
} from "@/lib/extension-install-pipeline";
import type { ExtensionStoreKind } from "@/lib/extension-package-store-core";
import { writeSuppliedSnapshot } from "@/lib/extension-package-store";
import { buildNpmLayoutTarball } from "@/lib/supplied-package-tarball";

/** What a kind's own handler answers when asked to validate a manifest. */
export type SuppliedKindValidation = { valid: boolean; errors?: string[] };

/**
 * Resolve the validator a KIND declares, or null when it declares none. Injected
 * so the refusal is unit-testable without booting the handler registry.
 */
export type SuppliedKindValidatorResolver = (
  kind: SuppliedPackageKind,
) => Promise<((spec: unknown) => Promise<SuppliedKindValidation>) | null>;

export type SuppliedArchivePreview = ResolvedSuppliedPackageTree & {
  /** Ready to record: honest `local` provenance, never a registry claim. */
  provenance: Extract<SuppliedPackageProvenance, { type: "local" }>;
};

/**
 * The `path` a `local` row carries BEFORE the snapshot is staged. It is a label,
 * not a filesystem location: the real staged name is derived from the content
 * digest by the store's own writer and replaces this before the row is written.
 */
export const SUPPLIED_ARCHIVE_PENDING_PATH = "supplied-archive";

/**
 * READ a supplied archive and say what it is. No writes, no network, no
 * execution — this is the preview both the screen and the install run, and the
 * install runs it AGAIN on the bytes it was handed rather than believing a
 * preview it did not perform.
 */
export async function previewSuppliedArchive(
  archive: ArrayBuffer | Uint8Array,
): Promise<SuppliedArchivePreview> {
  const buffer =
    archive instanceof Uint8Array
      ? (archive.buffer.slice(
          archive.byteOffset,
          archive.byteOffset + archive.byteLength,
        ) as ArrayBuffer)
      : archive;
  const entries = await readZipEntries(buffer);
  const resolved = await resolveSuppliedArchive(entries);
  return {
    ...resolved,
    provenance: {
      type: "local",
      path: SUPPLIED_ARCHIVE_PENDING_PATH,
      contentDigest: resolved.contentDigest,
    },
  };
}

/**
 * The default validator resolver: the kind's OWN registered handler.
 *
 * `typeId` and the declared kind are the same token for the four live kinds
 * (handler-bootstrap registers `agent`, `skill`, `connector` and `artifact` under
 * exactly those ids), so there is no second mapping table to drift.
 */
export const resolveRegisteredKindValidator: SuppliedKindValidatorResolver = async (
  kind,
) => {
  const { extensionRegistry } = await import("@cinatra-ai/extensions");
  const handler = extensionRegistry.tryResolve(kind);
  if (!handler || typeof handler.validate !== "function") return null;
  const validate = handler.validate.bind(handler);
  return async (spec: unknown) => (await validate(spec)) as SuppliedKindValidation;
};

/**
 * Run the resolved kind's own `validate()` over the package's parsed manifest,
 * BEFORE any mutation (criterion 4).
 *
 * Returns the verdict rather than swallowing it, so a caller can report which
 * kinds actually carry a validator instead of implying all four do.
 */
export async function validateSuppliedPackageForKind(input: {
  kind: SuppliedPackageKind;
  packageJson: string;
  resolveValidator?: SuppliedKindValidatorResolver;
}): Promise<{ ran: boolean }> {
  const resolve = input.resolveValidator ?? resolveRegisteredKindValidator;
  const validate = await resolve(input.kind);
  if (!validate) return { ran: false };

  let manifest: unknown;
  try {
    manifest = JSON.parse(input.packageJson);
  } catch {
    throw new Error(
      `[supplied-install] the package.json of this "${input.kind}" package is not valid JSON — ` +
        `refusing before any write.`,
    );
  }
  const verdict = await validate(manifest);
  if (!verdict.valid) {
    const detail = (verdict.errors ?? []).join("; ") || "no reason given";
    throw new Error(
      `[supplied-install] this "${input.kind}" package did not pass the ${input.kind} validator: ` +
        `${detail}. Nothing was written.`,
    );
  }
  return { ran: true };
}

export type SuppliedArchiveInstallInput = {
  /** The archive bytes exactly as supplied. Re-read here; never trusted second-hand. */
  archive: ArrayBuffer | Uint8Array;
  orgId?: string | null;
  actorUserId?: string | null;
  storeRoot?: string;
  installOpId?: string;
  /**
   * The digest the SCREEN previewed, when the caller holds one. Passing it makes
   * a preview-to-install swap a refusal instead of a surprise: the same guard the
   * repository road's pin gives, expressed over the only thing a file road can
   * pin — its bytes.
   */
  expectedContentDigest?: string;
  resolveValidator?: SuppliedKindValidatorResolver;
  /** Injectable staging (production uses the store's own digest-named writer). */
  stageSnapshot?: (contentDigest: string, tarball: Uint8Array) => Promise<string>;
};

/** Everything a supplied install needs, with nothing installed yet. */
export type PreparedSuppliedSnapshot = {
  package: SuppliedArchivePreview;
  /** The npm-layout tarball the store materializes. */
  tarball: Uint8Array;
  /** Complete provenance, its `path` naming the snapshot that was actually staged. */
  provenance: SuppliedPackageProvenance;
  /** Whether the kind's own validator ran (criterion 4, reported honestly). */
  validatorRan: boolean;
};

/**
 * READ, VALIDATE, PACK and STAGE — everything before the first durable install
 * mutation, in one call, so both the pipeline-direct driver below and the
 * dispatcher-driven road the screen takes share ONE intake.
 *
 * Order is the contract: the archive is re-read here, the kind's own validator
 * runs on the parsed manifest, and only then is anything packed or staged. A
 * refusal at either step leaves no snapshot behind.
 */
export async function prepareSuppliedArchiveSnapshot(
  input: SuppliedArchiveInstallInput,
): Promise<PreparedSuppliedSnapshot> {
  const supplied = await previewSuppliedArchive(input.archive);

  if (
    input.expectedContentDigest !== undefined &&
    input.expectedContentDigest !== supplied.contentDigest
  ) {
    throw new Error(
      `[supplied-install] ${supplied.packageName}: the previewed content digest ` +
        `${input.expectedContentDigest} is not the digest of the bytes that arrived ` +
        `(${supplied.contentDigest}) — refusing before any write.`,
    );
  }

  // CRITERION 4 — the kind's own validator, before the packer, before the store.
  const validation = await validateSuppliedPackageForKind({
    kind: supplied.kind,
    packageJson: supplied.packageJson,
    ...(input.resolveValidator ? { resolveValidator: input.resolveValidator } : {}),
  });

  const tarball = buildNpmLayoutTarball(supplied.deliveredEntries);

  // Stage the immutable snapshot, then record WHERE it went. A `local` row whose
  // provenance names no staged snapshot is refused by `readSuppliedSnapshot` the
  // next time the runtime activates it, so installing without staging would write
  // a row that works once and never again.
  const stage = input.stageSnapshot ?? writeSuppliedSnapshot;
  const snapshotPath = await stage(supplied.contentDigest, tarball);

  const provenance: SuppliedPackageProvenance = {
    ...supplied.provenance,
    path: snapshotPath,
  };
  if (!isSuppliedPackageProvenance(provenance)) {
    throw new Error(
      `[supplied-install] ${supplied.packageName}: the staged snapshot did not produce complete ` +
        `local provenance — refusing before any write.`,
    );
  }

  return {
    package: { ...supplied, provenance: { ...supplied.provenance, path: snapshotPath } },
    tarball,
    provenance,
    validatorRan: validation.ran,
  };
}

export type SuppliedArchiveInstallResult = {
  result: InstallPipelineResult;
  /** What was actually read from the supplied bytes — the row's own account. */
  package: SuppliedArchivePreview;
  /** Whether the kind's own validator ran (criterion 4, reported honestly). */
  validatorRan: boolean;
};

/**
 * Install a supplied ARCHIVE as a package of WHATEVER KIND it declares, straight
 * through leg 1's pipeline entry.
 *
 * The kind is not a parameter: it comes from the archive's own manifest through
 * the shared resolver, and it is what the store placement and the pipeline's
 * trust decision are both told. This is the twin of the repository road's
 * `installGitHubSuppliedPackage`; the SCREEN takes the dispatcher-driven road
 * (src/lib/supplied-package-install.ts), which runs this same pipeline through
 * the activate hook AND then the kind's native handler in its declared order.
 */
export async function installSuppliedArchivePackage(
  input: SuppliedArchiveInstallInput,
  deps: SuppliedInstallPipelineDeps,
): Promise<SuppliedArchiveInstallResult> {
  const prepared = await prepareSuppliedArchiveSnapshot(input);

  const result = await installExtensionFromSuppliedSnapshot(
    {
      packageName: prepared.package.packageName,
      version: prepared.package.version,
      orgId: input.orgId ?? null,
      ...(input.actorUserId === undefined ? {} : { actorUserId: input.actorUserId }),
      ...(input.storeRoot ? { storeRoot: input.storeRoot } : {}),
      ...(input.installOpId ? { installOpId: input.installOpId } : {}),
      expectedKind: prepared.package.kind as ExtensionStoreKind,
      supplied: { tarball: prepared.tarball, provenance: prepared.provenance },
    },
    deps,
  );

  return {
    result,
    package: prepared.package,
    validatorRan: prepared.validatorRan,
  };
}
