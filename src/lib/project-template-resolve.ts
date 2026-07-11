import "server-only";

// Installed-package RESOLUTION seams for the project kind-gate wiring
// (cinatra#1032 deliverable 3). Everything here reads the SRI-verified
// FINALIZED store payload (the same trust basis as the boot loader and the
// dispatcher install pipeline) — NEVER caller-supplied bytes and NEVER the
// mutable agent runtime mount — so the PM-seat binding check and the
// dispatch-time template resolution are anchored to the bytes the install
// pipeline actually verified.
//
//   - resolveInstalledAgentManifest — the installed agent package's
//     package.json (raw parse; the zod install contract deliberately strips
//     unknown keys, and `cinatra.consumes` must survive to be judged).
//   - agentManifestDeclaresPmSeat — the PM-SEAT predicate: the manifest
//     declares `cinatra.consumes` with the `pm-work-store` capability at
//     requirement "required". An `optional` declaration explicitly says the
//     agent can function without the store, so it does NOT confer the seat.
//     Malformed `consumes` fails CLOSED (no seat).
//   - resolveInstalledProjectTemplate — the installed package's
//     `cinatra/project-template.json`, validated. The install gate already
//     refused invalid templates; re-validating here keeps the runtime
//     fail-closed against any pre-gate install lineage.
//
// ORG-SCOPE RESOLUTION RULE: try the caller org's exact-org anchor first, then
// fall back to the PLATFORM-SCOPE anchor (`orgId: null` — rows whose org_id IS
// NULL: bootstrap-seeded / platform-scope installs are usable by every org,
// mirroring the dispatch primitive's tenancy rule that a null-org agent
// template is dispatchable by any org). A FOREIGN-org install is unreachable
// on both passes — the fallback is never the omitted-orgId platform-GLOBAL
// resolution, which would surface another org's single live row.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { PROJECT_TEMPLATE_PACKAGE_PATH } from "@cinatra-ai/agents/project-template-install-gate";
import { PM_WORK_STORE_CAPABILITY } from "@cinatra-ai/sdk-extensions/internal";
// Direct subpath import (NOT the barrel): the consumes VALUE helpers are
// deliberately kept off the sdk root so barrel-importing routes' first-party
// graphs stay flat (see packages/sdk-extensions/src/index.ts).
import { parseConsumedPrimitives } from "@cinatra-ai/sdk-extensions/consumes";
import {
  validateProjectTemplate,
  type ProjectTemplate,
} from "@cinatra-ai/sdk-extensions/project-template-contract";
import { resolveFinalizedStorePayload } from "@/lib/extension-store-payload";

export type InstalledAgentManifest = {
  /** The raw parsed package.json of the finalized install. */
  manifest: Record<string, unknown>;
  /** The finalized digest dir the manifest was read from. */
  storeDir: string;
  /** The journal-confirmed tarball digest. */
  digest: string;
};

/**
 * Resolve an installed agent package's manifest from its FINALIZED store
 * payload: exact-org first, platform-global fallback. Returns null (never
 * throws) when no finalized install exists at either scope or the manifest is
 * unreadable/unparsable — callers fail CLOSED on null.
 */
export async function resolveInstalledAgentManifest(
  packageName: string,
  orgId: string,
): Promise<InstalledAgentManifest | null> {
  let payload = await resolveFinalizedStorePayload({
    packageName,
    expectedKind: "agent",
    orgId,
  });
  if (!payload) {
    // PLATFORM-SCOPE fallback: `orgId: null` is the EXACT-ORG resolution at
    // the platform scope (anchor rows with org_id IS NULL) — deliberately NOT
    // the omitted-orgId platform-GLOBAL resolution ("the single live row
    // across all orgs", the boot-loader semantics), which could hand org A
    // the install org B owns when A has none.
    payload = await resolveFinalizedStorePayload({
      packageName,
      expectedKind: "agent",
      orgId: null,
    });
  }
  if (!payload) return null;
  try {
    const raw = await readFile(join(payload.storeDir, "package.json"), "utf8");
    const manifest = JSON.parse(raw) as unknown;
    if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) return null;
    return {
      manifest: manifest as Record<string, unknown>,
      storeDir: payload.storeDir,
      digest: payload.digest,
    };
  } catch {
    return null;
  }
}

/**
 * The PM-SEAT predicate: true iff the manifest declares
 * `cinatra.consumes: [{ primitive: "pm-work-store", requirement: "required" }]`.
 * Fail-closed: a malformed `consumes` block (fail-loud in the parser) yields
 * false — a package that cannot state its binding cleanly does not get the
 * seat.
 */
export function agentManifestDeclaresPmSeat(manifest: unknown): boolean {
  try {
    return parseConsumedPrimitives(manifest).some(
      (c) => c.primitive === PM_WORK_STORE_CAPABILITY && c.requirement === "required",
    );
  } catch {
    return false;
  }
}

export type InstalledProjectTemplateResolution =
  | { ok: true; template: ProjectTemplate; digest: string; manifest: Record<string, unknown> }
  | { ok: false; reason: "not_installed" | "no_template" | "template_invalid"; detail?: string };

/**
 * Resolve + validate the `cinatra/project-template.json` shipped by an
 * INSTALLED agent package (same org-scope rule as the manifest resolver).
 * Never throws; every miss is a discriminated fail-closed reason.
 */
export async function resolveInstalledProjectTemplate(
  packageName: string,
  orgId: string,
): Promise<InstalledProjectTemplateResolution> {
  const resolved = await resolveInstalledAgentManifest(packageName, orgId);
  if (!resolved) return { ok: false, reason: "not_installed" };

  let raw: string;
  try {
    raw = await readFile(join(resolved.storeDir, PROJECT_TEMPLATE_PACKAGE_PATH), "utf8");
  } catch {
    return { ok: false, reason: "no_template" };
  }

  let candidate: unknown;
  try {
    candidate = JSON.parse(raw);
  } catch (err) {
    return {
      ok: false,
      reason: "template_invalid",
      detail: `not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const validation = validateProjectTemplate(candidate);
  if (!validation.valid) {
    return {
      ok: false,
      reason: "template_invalid",
      detail: validation.violations.map((v) => `[${v.code}] ${v.path}`).join("; "),
    };
  }
  return {
    ok: true,
    template: validation.template,
    digest: resolved.digest,
    manifest: resolved.manifest,
  };
}
