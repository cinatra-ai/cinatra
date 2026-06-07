// Freshness module public surface.

export {
  freshnessAllowsRestore,
  getFreshnessAdapter,
  listFreshnessAdapters,
  registerFreshnessAdapter,
  type FreshnessAdapter,
  type FreshnessState,
} from "./contract";

import { registerFreshnessAdapter } from "./contract";
import { wordpressFreshnessAdapter } from "./wordpress-adapter";

// Register the reference adapter on first import.
registerFreshnessAdapter(wordpressFreshnessAdapter);

export {
  resolveExternalFreshness,
  resolveEventFreshness,
} from "./resolve";

// Change-set freshness probe.
export {
  freshnessCheckForChangeSet,
  type ChangeSetFreshnessResult,
} from "./check-change-set";
