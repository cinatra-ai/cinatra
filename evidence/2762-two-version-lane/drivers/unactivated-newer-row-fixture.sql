-- #2762 ACCEPTANCE ITEM 1: an unactivated NEWER row, while the BUNDLE serves.
--
-- Acceptance 1 asks that restarting with a stranded newer row either activates
-- it or keeps serving the bundled implementation under the documented
-- failure-class policy. This fixture drives the SECOND branch, which is the one
-- that only a BUNDLED package can reach.
--
-- `drivers/stranded-row-fixture.sql` deliberately names a package the image does
-- NOT bundle, so it has no fallback and the reconciliation acts on it. This file
-- is its counterpart: the package here IS bundled, so the static bundle
-- registers it at boot, which puts it in `activatedThisBoot` and takes it out of
-- the reconciliation candidate set (`src/lib/extension-boot-reconcile.ts`). That
-- skip is not the reconciliation failing to notice the row — it is the
-- documented "the bundled implementation is already serving" outcome.
--
-- The row points at version 0.1.5, which is published NOWHERE and materialized
-- NOWHERE. That is what makes it genuinely unactivatable rather than merely
-- unactivated: nothing in the store can serve it, so the only implementation
-- that can answer is the bundled 0.1.0 the image carries.
--
-- What the surfaces must then show, and what the capture proves:
--   * the SETUP surface renders the UNSTAMPED declared placeholder, i.e. the
--     BUNDLED 0.1.0 manifest is what reached the render — the bundle serves;
--   * the SETTINGS surface NAMES 0.1.5, because the lifecycle/settings seam
--     resolves the marketplace row through the shared source-precedence policy.
-- The newer row is therefore VISIBLE rather than shadowed, which is the whole
-- point of this change.

-- Take the activatable marketplace row out of the way, so the only marketplace
-- row for this package is the unactivatable one below. Without this there would
-- be two live default verdaccio rows, which the resolver correctly refuses to
-- choose between.
DELETE FROM cinatra.installed_extension
 WHERE package_name = '@cinatra-ai/google-appointment-schedules-connector'
   AND source->>'type' = 'verdaccio';

INSERT INTO cinatra.installed_extension
  (id, package_name, owner_level, owner_id, organization_id, kind, status,
   source, version, is_default)
VALUES
  ('iext_unactivated_newer_2762',
   '@cinatra-ai/google-appointment-schedules-connector',
   'workspace', '__platform__', NULL,
   'connector', 'active',
   '{"type":"verdaccio","packageName":"@cinatra-ai/google-appointment-schedules-connector","version":"0.1.5","registryUrl":"http://127.0.0.1:4880","integrity":"sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}'::jsonb,
   '0.1.5', true)
ON CONFLICT (id) DO NOTHING;
