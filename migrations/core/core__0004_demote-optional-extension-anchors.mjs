// core__0004: demote the optional-extension anchor rows that the
// requiredExtensions shrink (cinatra#7) removed from the prod bootable set.
//
// The root `cinatra.requiredExtensions` declaration shrank from the
// 33-package interim bootable set (cinatra#6, Plan A) to the 16-package
// honest floor (8 `systemExtensions` + the 8 packages the host still
// hard-imports — see scripts/audit/extension-coupling-gates.md, residual
// floor register). Existing databases carry platform anchor rows
// (src/lib/static-bundle-lifecycle.ts) for every previously-required
// package with `required_in_prod = true` — and, in production, status
// `locked` (required-in-prod implies locked at the lowest write point,
// packages/extensions/src/lifecycle-primitive.ts).
//
// This migration converts those rows to OPTIONAL / marketplace-managed:
//   - `required_in_prod` -> false (the package is no longer part of the
//     declared bootable set; the marketplace may manage/uninstall it);
//   - status `locked` -> `active` ONLY for the demoted rows (the lock was
//     the required-in-prod coercion; an optional package must be
//     operator-manageable). Archived tombstones STAY archived; `active`
//     rows stay active.
// NOTHING is uninstalled or deleted: source provenance, dependency edges,
// manifest hash, owner/org scoping — all preserved (the upgraded-existing-DB
// test pins byte-level preservation). A demoted package whose bytes left
// the static bundle simply stops being activated by the StaticBundleLoader
// (records-driven; a row without a record is never consulted) and its
// consuming surfaces degrade per the guarded generated maps until the
// marketplace re-acquires it.
//
// Fresh databases never need this: the anchor seeding derives
// `required_in_prod` from the CURRENT declaration (16), and on fresh
// schemas the runner ledger-fakes the chain anyway (migrations/README.md).
// Idempotent: a second run matches zero rows. Unqualified names ride the
// runner's search_path.
//
// The demoted set is FROZEN here as the exact list the shrink removed —
// a static replayable artifact, never recomputed from the live declaration
// (a later shrink ships its own migration).

// Exported for the upgraded-existing-DB lifecycle test
// (src/lib/__tests__/integration/demote-optional-extension-anchors.test.ts);
// node-pg-migrate consumes only up/down.
export const DEMOTED_PACKAGES = [
  "@cinatra-ai/a2a-server-connector",
  "@cinatra-ai/apify-connector",
  "@cinatra-ai/apollo-connector",
  "@cinatra-ai/blog-connector",
  "@cinatra-ai/drupal-assistant-connector",
  "@cinatra-ai/email-connector",
  "@cinatra-ai/github-connector",
  "@cinatra-ai/google-oauth-connector",
  "@cinatra-ai/linkedin-connector",
  "@cinatra-ai/mcp-client-connector",
  "@cinatra-ai/media-feeds-connector",
  "@cinatra-ai/resend-connector",
  "@cinatra-ai/social-media-connector",
  "@cinatra-ai/tailscale-connector",
  "@cinatra-ai/twenty-connector",
  "@cinatra-ai/wordpress-assistant-connector",
  "@cinatra-ai/youtube-connector",
];

const NAME_LIST = DEMOTED_PACKAGES.map((n) => `'${n}'`).join(",\n    ");

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function up(pgm) {
  pgm.sql(`UPDATE installed_extension
  SET required_in_prod = false,
      status = CASE WHEN status = 'locked' THEN 'active' ELSE status END,
      updated_at = now()
  WHERE required_in_prod = true
    AND package_name IN (
    ${NAME_LIST}
  );`);
}

/** @param {import("node-pg-migrate").MigrationBuilder} pgm */
export function down(pgm) {
  // Exact symmetric inverse: re-promote to required-in-prod AND restore the
  // required-implies-locked shape for live rows (`active` -> `locked`).
  // There is NO boot-time re-lock pass for pre-existing rows (the lifecycle
  // primitive coerces `locked` only at INSERT time), so leaving re-promoted
  // rows `active` would make required packages archivable — the rollback
  // must restore the invariant itself. Archived tombstones stay archived
  // (never resurrect an operator decision); in dev the resulting lock
  // matches the required-in-prod advisory and is operator-reversible.
  pgm.sql(`UPDATE installed_extension
  SET required_in_prod = true,
      status = CASE WHEN status = 'active' THEN 'locked' ELSE status END,
      updated_at = now()
  WHERE package_name IN (
    ${NAME_LIST}
  );`);
}
