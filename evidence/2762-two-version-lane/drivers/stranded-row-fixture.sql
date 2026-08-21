-- A PRE-EXISTING STRANDED INSTALL ROW.
--
-- The boot reconciliation this change adds exists for rows written before the
-- install path learned to refuse an install it cannot activate: a live, default,
-- marketplace-sourced install for a package that then serves nothing. The
-- candidate predicate is status in (active, locked) AND is_default is not false
-- AND source.type = 'verdaccio' AND the package did NOT come up in this process
-- (src/lib/extension-boot-reconcile.ts).
--
-- The package named here is deliberately one the image does NOT bundle. A
-- bundled package always registers from the static bundle, which puts it in the
-- set of packages that came up this boot, so it is never a reconciliation
-- candidate — correctly, since its bundled implementation is already serving.
-- Only a package with no bundled fallback can actually be stranded, which is
-- exactly the row this fixture writes.
INSERT INTO cinatra.installed_extension
  (id, package_name, owner_level, owner_id, organization_id, kind, status,
   source, version, is_default)
VALUES
  ('iext_stranded_fixture_2762',
   '@cinatra-ai/stranded-fixture-connector',
   'workspace', '__platform__', NULL,
   'connector', 'active',
   '{"type":"verdaccio","packageName":"@cinatra-ai/stranded-fixture-connector","version":"0.1.0","registryUrl":"http://127.0.0.1:4880"}'::jsonb,
   '0.1.0', true)
ON CONFLICT (id) DO NOTHING;
