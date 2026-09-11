// NEGATIVE FIXTURE — criterion 3: no credential literal on the fixture-seeding
// path.
//
// This module is never imported by the product. It carries the WRONG version of
// the rule it is named after, so the assertion that pins the real rule can be
// pointed at it and REQUIRED to reject it.
//
// It holds both shapes a DERIVED literal takes, and neither is a value anybody
// generated or injected:
//   - a fixed string written straight into the seeding call,
//   - a value assembled at run time out of fixed fragments through a named
//     list, and
//   - the same assembly written inline, which reads like computation but is
//     the same constant on every boot of every instance.
//
// The fragments below are deliberately meaningless words. Nothing here is, or
// ever was, a credential of anything.

export const CRITERION_3_NEGATIVE_FIXTURE = {
  criterion: 3,
  name: "criterion-3-derived-literal-fixture-password",
  rule: "the fixture account's secret is minted or injected, never derived from a literal",
  source: `
const fixtureParts = ["fixture", "account", "constant"];

export async function seedDevFixtureAccount(): Promise<void> {
  const password = fixtureParts.join("-");
  await signUpEmail({ email: "fixture@example.com", password });
  await signUpEmail({ email: "second@example.com", password: "a-fixed-fixture-value" });
  await signUpEmail({ email: "third@example.com", password: ["one", "two"].join("-") });
}
`,
} as const;
