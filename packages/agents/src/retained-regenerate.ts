// cinatra#4264 A1b: the `none` rule of the lifecycle writer roads, in one place.
//
// A road that keeps the stored `lifecycle_config` column (it has no readable
// manifest to re-project, or it does not rewrite the row at all) must not keep
// a stored `regenerate` list the flow it is about to run, import or reload no
// longer honours. This checks the stored list against that flow and THROWS
// when it fails, or when the stored text cannot be read, so the caller refuses
// before it writes or reloads anything.

import { basename, dirname } from "node:path";

import { readStoredRegenerate } from "@/lib/lifecycle/lifecycle-policy";

import { checkRegenerateDeclaration } from "./verdaccio/package-contract";

const LAYOUT_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The package name an agent's on-disk layout names, `@<vendor>/<slug>` for
 * `.../<vendor>/<slug>/cinatra/oas.json` (or the flat `.../<vendor>/<slug>/agent.json`),
 * the same rule the agent runtime mounts by (cinatra#4264 A1b, review 2). A
 * writer with no manifest name and no OAS name uses it to find the row whose
 * stored list it must check, instead of the bare slug, which names no
 * scoped row. Null when the segments are not plain path segments.
 */
export function packageNameFromAgentLayout(oasSourcePath: string): string | null {
  const oasDir = dirname(oasSourcePath);
  const packageDir = basename(oasDir) === "cinatra" ? dirname(oasDir) : oasDir;
  const slug = basename(packageDir);
  const vendor = basename(dirname(packageDir));
  if (!LAYOUT_SEGMENT.test(slug) || !LAYOUT_SEGMENT.test(vendor)) return null;
  return `@${vendor}/${slug}`;
}

/**
 * Refuse a stored `regenerate` list that `parsedOas` no longer honours.
 *
 * `subject` names the caller and the package for the error text. A stored
 * column without the key (or no column) passes without a check.
 */
export function assertStoredRegenerateHonoured(
  storedLifecycleConfig: string | null | undefined,
  parsedOas: unknown,
  subject: string,
): void {
  let retained: unknown;
  try {
    retained = readStoredRegenerate(storedLifecycleConfig);
  } catch (err) {
    throw new Error(
      `${subject}: ${err instanceof Error ? err.message : String(err)}, so its regenerate list ` +
        "cannot be checked against the flow",
    );
  }
  if (retained === undefined) return;
  const check = checkRegenerateDeclaration(parsedOas, retained);
  if (!check.ok) {
    throw new Error(
      `${subject} keeps its stored lifecycle declaration, but the flow no longer honours its ` +
        `regenerate list: ${check.error}`,
    );
  }
}
