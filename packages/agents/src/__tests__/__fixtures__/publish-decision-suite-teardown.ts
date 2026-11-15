/**
 * cinatra#4150: the teardown of publish-decision-store.integration.test.ts. It ends the
 * pool, clears the process-wide pool reference and the schema-initialized mark, restores
 * SUPABASE_SCHEMA as it was, drops the test schema and closes the admin client. Every step
 * runs, and any failure (a failed drop too) fails the file after the last step, so a later
 * integration file never inherits an ended pool, a stale schema setting or a leftover schema.
 */
import { runAllCleanups } from "./integration-fixture-helpers";

export interface PublishDecisionSuiteState {
  pool: { end(): Promise<unknown> } | undefined;
  admin: { query(text: string): Promise<unknown>; end(): Promise<unknown> } | undefined;
  dropSchemaSql: string;
  priorSchema: string | undefined;
}

export async function endPublishDecisionSuite(state: PublishDecisionSuiteState): Promise<void> {
  const shared = globalThis as { __cinatraAgentBuilderPool?: unknown; __cinatraPostgresSchemaInitialized?: boolean };
  await runAllCleanups([
    () => state.pool?.end(),
    async () => {
      delete shared.__cinatraAgentBuilderPool;
      delete shared.__cinatraPostgresSchemaInitialized;
      if (state.priorSchema === undefined) delete process.env.SUPABASE_SCHEMA;
      else process.env.SUPABASE_SCHEMA = state.priorSchema;
    },
    () => (state.admin ? state.admin.query(state.dropSchemaSql) : Promise.reject(new Error("no admin client to drop the schema"))),
    () => state.admin?.end(),
  ]);
}
