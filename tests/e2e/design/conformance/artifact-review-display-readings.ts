// The reading a kind-display field's driver reads it in (cinatra#4388).
//
// contract.ts builds one driver per field name of an artifact-kind display row,
// and this function decides which reading that driver asserts. It lives here,
// in a module with no Playwright import, so that the wave test
// (scripts/design/__tests__/conformance-artifact-review-wave.test.mjs) can call
// it on every branch without a browser.

import type { ArtifactKindDisplayField } from "./artifact-review-displays";

/** The readings a row may declare. Absent (undefined) means "open". */
const DECLARED_READINGS: ReadonlySet<string> = new Set(["open", "continued", "no-review"]);

/**
 * The one reading a field's driver reads it in, from every declaration the row
 * records for that field (a drawing binds a field once per reading that draws
 * it). "open": a declaration with no reading, so the field is drawn while the
 * review is open. "continued": no declaration is open and one is continued, so
 * the field is absent while the review is open and drawn once it is continued.
 * "no-review": every declaration is drawn where no review stands, which the
 * review harness does not mount.
 *
 * It throws, and so stops the build, for a row the drivers cannot read: a
 * field bound to no source or to two sources (so also a field with no
 * declaration), a field declared both open and continued, or a declaration
 * whose reading is none of open, continued and no-review.
 */
export function kindDisplayFieldReading(
  surface: string,
  fields: readonly ArtifactKindDisplayField[],
): "open" | "continued" | "no-review" {
  const sources = new Set(fields.map((field) => field.source));
  const readings = new Set<string>(fields.map((field) => field.reading ?? "open"));
  const unknown = [...readings].filter((reading) => !DECLARED_READINGS.has(reading));
  if (
    sources.size !== 1 ||
    unknown.length > 0 ||
    (readings.has("open") && readings.has("continued"))
  ) {
    throw new Error(
      `${surface}: "${fields[0]?.name ?? "(no declaration)"}" is declared with sources ${[...sources].join(", ")} in readings ${[...readings].join(", ")} — reconcile the row with the manifest`,
    );
  }
  if (readings.has("open")) return "open";
  if (readings.has("continued")) return "continued";
  return "no-review";
}
