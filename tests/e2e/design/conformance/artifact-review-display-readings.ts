// The driver of a kind-display field (cinatra#4388).
//
// contract.ts builds one driver per field name of an artifact-kind display row.
// This module decides which reading that driver reads (kindDisplayFieldReading)
// and which of the three assertions it gets for that reading
// (kindDisplayFieldDriver). It has no Playwright import, so that the wave test
// (scripts/design/__tests__/conformance-artifact-review-wave.test.mjs) can call
// both on every branch without a browser; contract.ts supplies the three
// assertions themselves.

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
 * declaration whose source is undefined, empty or blank, a field bound to two
 * sources, a field with no declaration, a field declared both open and
 * continued, or a declaration whose reading is none of open, continued and
 * no-review.
 */
export function kindDisplayFieldReading(
  surface: string,
  fields: readonly ArtifactKindDisplayField[],
): "open" | "continued" | "no-review" {
  const blank = fields.filter(
    (field) => typeof field.source !== "string" || field.source.trim() === "",
  );
  const sources = new Set(fields.map((field) => field.source));
  const readings = new Set<string>(fields.map((field) => field.reading ?? "open"));
  const unknown = [...readings].filter((reading) => !DECLARED_READINGS.has(reading));
  if (
    blank.length > 0 ||
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

/** The three assertions a kind-display field's driver can get; contract.ts supplies them. */
export type KindDisplayFieldAssertions<A> = {
  /** "open": the field is bound once, and visible, while the review is open. */
  readonly present: (binding: string) => A;
  /** "continued": the field is absent while the review is open and drawn once it is continued. */
  readonly continuedOnly: (binding: string) => A;
  /** "no-review": the review harness has no mount for the reading, so the driver skips with this reason. */
  readonly skip: (reason: string) => A;
};

/**
 * The driver of one field name: its source, and the assertion its reading
 * gets. The binding is the element the drawing binds the field on,
 * `[data-field="<name>=<source>"]`. It throws for every row
 * kindDisplayFieldReading throws for.
 */
export function kindDisplayFieldDriver<A>(
  surface: string,
  fields: readonly ArtifactKindDisplayField[],
  assertions: KindDisplayFieldAssertions<A>,
): { source: string; assert: A } {
  const reading = kindDisplayFieldReading(surface, fields);
  const { name, source } = fields[0];
  const binding = `[data-field="${name}=${source}"]`;
  switch (reading) {
    case "open":
      return { source, assert: assertions.present(binding) };
    case "continued":
      return { source, assert: assertions.continuedOnly(binding) };
    case "no-review":
      return {
        source,
        assert: assertions.skip(
          `${surface}: "${name}" is drawn only where no review stands, a reading the review harness does not mount`,
        ),
      };
  }
}
