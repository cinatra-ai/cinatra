// cinatra#4264 A1b: the `none` rule of the lifecycle writer roads, in one place.
//
// A road that keeps the stored `lifecycle_config` column (it has no readable
// manifest to re-project, or it does not rewrite the row at all) must not keep
// a stored `regenerate` list the flow it is about to run, import or reload no
// longer honours. This checks the stored list against that flow and THROWS
// when it fails, or when the stored text cannot be read, so the caller refuses
// before it writes or reloads anything.

import { readStoredRegenerate } from "@/lib/lifecycle/lifecycle-policy";

import { checkRegenerateDeclaration } from "./verdaccio/package-contract";

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
