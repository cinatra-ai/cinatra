// Bootstrap DDL for the skill co-ownership join tables' post-CREATE index +
// FK-constraint-repair statements — a pure string builder with ZERO imports (a
// synchronous leaf, safe for drizzle-store.ts's synchronous require() composition;
// see the postgres-sync-leaf-imports test). Extracted VERBATIM from
// buildCreateStoreSchemaQueries to relieve the src/lib/drizzle-store.ts
// file-size-ratchet bottleneck (it sat 1 line under its 4564 ceiling). The two
// CREATE TABLE statements deliberately STAY inline in drizzle-store.ts — moving
// pre-existing CREATE TABLE DDL out reads as a destructive drop to the
// schema-migration gate; only the additive index + idempotent constraint-repair
// DO blocks move here. The emitted DDL text is byte-identical before/after
// (proven by the co-owner-constraint-schema string-set equality test).

/** skill_package_co_owners: user_id index + the FK-constraint-repair DO block.
 * Spread into buildCreateStoreSchemaQueries immediately after the
 * skill_package_co_owners CREATE TABLE. */
export function skillPackageCoOwnerConstraintQueries(schemaName: string): { text: string }[] {
  return [
    { text: `CREATE INDEX IF NOT EXISTS skill_package_co_owners_user_id_idx ON "${schemaName.replaceAll('"', '""')}"."skill_package_co_owners" (user_id)` },
    { text: `DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = '${schemaName.replaceAll("'", "''")}'
            AND table_name = 'skill_package_co_owners'
            AND constraint_name = 'skill_package_co_owners_user_id_fkey'
        ) THEN
          ALTER TABLE "${schemaName.replaceAll('"', '""')}"."skill_package_co_owners"
            ADD CONSTRAINT skill_package_co_owners_user_id_fkey
            FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = '${schemaName.replaceAll("'", "''")}'
            AND table_name = 'skill_package_co_owners'
            AND constraint_name = 'skill_package_co_owners_granted_by_fkey'
        ) THEN
          ALTER TABLE "${schemaName.replaceAll('"', '""')}"."skill_package_co_owners"
            ADD CONSTRAINT skill_package_co_owners_granted_by_fkey
            FOREIGN KEY (granted_by) REFERENCES public."user"(id);
        END IF;
        -- Replace CASCADE with RESTRICT on the
        -- package_id FK if a pre-existing schema was bootstrapped while the
        -- CASCADE was still in CREATE TABLE. Idempotent: only fires when the
        -- current constraint delete_rule is still CASCADE.
        IF EXISTS (
          SELECT 1 FROM information_schema.referential_constraints rc
          WHERE rc.constraint_schema = '${schemaName.replaceAll("'", "''")}'
            AND rc.constraint_name = 'skill_package_co_owners_package_id_fkey'
            AND rc.delete_rule = 'CASCADE'
        ) THEN
          ALTER TABLE "${schemaName.replaceAll('"', '""')}"."skill_package_co_owners"
            DROP CONSTRAINT skill_package_co_owners_package_id_fkey;
          ALTER TABLE "${schemaName.replaceAll('"', '""')}"."skill_package_co_owners"
            ADD CONSTRAINT skill_package_co_owners_package_id_fkey
            FOREIGN KEY (package_id) REFERENCES "${schemaName.replaceAll('"', '""')}"."skill_packages"(id) ON DELETE RESTRICT;
        END IF;
        -- Heal a schema where the package_id FK is
        -- missing entirely after table
        -- creation, or any state where the constraint got dropped manually).
        -- CREATE TABLE IF NOT EXISTS won't re-add the FK, so we add it here.
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = '${schemaName.replaceAll("'", "''")}'
            AND table_name = 'skill_package_co_owners'
            AND constraint_name = 'skill_package_co_owners_package_id_fkey'
        ) THEN
          ALTER TABLE "${schemaName.replaceAll('"', '""')}"."skill_package_co_owners"
            ADD CONSTRAINT skill_package_co_owners_package_id_fkey
            FOREIGN KEY (package_id) REFERENCES "${schemaName.replaceAll('"', '""')}"."skill_packages"(id) ON DELETE RESTRICT;
        END IF;
      END $$;` },
  ];
}

/** skill_co_owners: user_id index + the FK-constraint-repair DO block (incl. the
 * orphan-cleanup DELETE before the skill_id FK add). Spread into
 * buildCreateStoreSchemaQueries immediately after the skill_co_owners CREATE TABLE. */
export function skillCoOwnerConstraintQueries(schemaName: string): { text: string }[] {
  return [
    { text: `CREATE INDEX IF NOT EXISTS skill_co_owners_user_id_idx ON "${schemaName.replaceAll('"', '""')}"."skill_co_owners" (user_id)` },
    { text: `DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = '${schemaName.replaceAll("'", "''")}'
            AND table_name = 'skill_co_owners'
            AND constraint_name = 'skill_co_owners_user_id_fkey'
        ) THEN
          ALTER TABLE "${schemaName.replaceAll('"', '""')}"."skill_co_owners"
            ADD CONSTRAINT skill_co_owners_user_id_fkey
            FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;
        END IF;
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = '${schemaName.replaceAll("'", "''")}'
            AND table_name = 'skill_co_owners'
            AND constraint_name = 'skill_co_owners_granted_by_fkey'
        ) THEN
          ALTER TABLE "${schemaName.replaceAll('"', '""')}"."skill_co_owners"
            ADD CONSTRAINT skill_co_owners_granted_by_fkey
            FOREIGN KEY (granted_by) REFERENCES public."user"(id);
        END IF;
        -- Heal a schema where skill_id FK was
        -- never added (table was originally created without it).
        --
        -- review follow-up: BEFORE adding the FK, clean up any orphan
        -- skill_co_owners rows whose skill_id no longer points at a real
        -- skill row. The legacy no-FK design allowed package-uninstall
        -- paths to drop skill rows while leaving co-owner grants in place;
        -- those orphans would block ALTER TABLE ADD CONSTRAINT now.
        IF NOT EXISTS (
          SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = '${schemaName.replaceAll("'", "''")}'
            AND table_name = 'skill_co_owners'
            AND constraint_name = 'skill_co_owners_skill_id_fkey'
        ) THEN
          DELETE FROM "${schemaName.replaceAll('"', '""')}"."skill_co_owners"
          WHERE skill_id NOT IN (
            SELECT id FROM "${schemaName.replaceAll('"', '""')}"."skills"
          );
          ALTER TABLE "${schemaName.replaceAll('"', '""')}"."skill_co_owners"
            ADD CONSTRAINT skill_co_owners_skill_id_fkey
            FOREIGN KEY (skill_id) REFERENCES "${schemaName.replaceAll('"', '""')}"."skills"(id) ON DELETE RESTRICT;
        END IF;
      END $$;` },
  ];
}
