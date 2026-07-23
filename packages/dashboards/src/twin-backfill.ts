import "server-only";

/**
 * Public subpath for the B1c artifact-twin backfill (cinatra#1894 / #2006).
 *
 * The implementation lives in `mutation-service.ts` so it reuses the module's
 * private twin-pairing glue (`pairTwin` / `twinCtx` / `acquireTwinLockFirst`)
 * verbatim — the backfill drives the SAME registered writer the forward
 * mutations do, never a re-implementation of the substrate pairing SQL. The
 * host core-boot phase imports this subpath and calls it after the twin writer
 * is registered.
 */
export {
  backfillDashboardArtifactTwins,
  DASHBOARD_TWIN_OBJECT_TYPE,
  type TwinBackfillResult,
  type BackfillTwinsDeps,
} from "./mutation-service";
