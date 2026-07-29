// Shared seed-pack skill-id expectation (cinatra#2090 S3, epic #2086).
//
// The seed-pack manifest suites used to pin the matcher/authoring catalog id to
// ONE shape — `<the artifact's own package>:<base>-matcher` — because the skill
// bundle shipped INSIDE the artifact extension. The S3 separation rule moves
// each bundle into its own single-bundle `-skill` extension, so the artifact's
// manifest names the PROVIDER package instead, and the artifact declares a
// role-carrying dependency edge on it.
//
// The migration is ROLLING (one extension repo at a time, each behind its own
// pin move), so the fleet holds BOTH shapes at once and these suites have to
// accept both — while still refusing anything else. They stay exact: each
// helper returns the two ids that are legal for a given artifact slug, so a
// third shape (a typo, a foreign package, a renamed bundle) still fails.
//
// When the last artifact pin has moved, drop the `coLocated` arm and these
// become single-value expectations again.

/** The base name an artifact package derives its skill names from. */
export function skillBase(artifactSlug: string): string {
  return artifactSlug.replace(/-artifact$/, "");
}

/** The two legal matcher catalog ids for an artifact package. */
export function expectedMatcherSkillIds(artifactSlug: string, pkgName: string): string[] {
  const base = skillBase(artifactSlug);
  return [
    // pre-extraction: the bundle ships in the artifact's own package
    `${pkgName}:${base}-matcher`,
    // post-extraction: the bundle is its own `-skill` extension
    `@cinatra-ai/${base}-matcher-skill:${base}-matcher`,
  ];
}

/** The two legal authoring catalog ids for an artifact package. */
export function expectedAuthoringSkillIds(artifactSlug: string, pkgName: string): string[] {
  const base = skillBase(artifactSlug);
  return [
    `${pkgName}:${base}-author`,
    `@cinatra-ai/${base}-authoring-skill:${base}-authoring`,
  ];
}
