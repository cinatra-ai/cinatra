import { afterEach, beforeEach } from "vitest";
import {
  NOOP_DASHBOARD_TWIN_WRITER,
  resetDashboardArtifactTwinWriter,
  setDashboardArtifactTwinWriter,
} from "../src/twin-writer-seam";

// Suite-wide EXPLICIT test-twin registration (cinatra#1894 B1b, delta D4).
//
// The dashboards-artifact twin seam is FAIL-CLOSED: an unregistered `pairTwin`
// THROWS. Because every mutation-service writer now pairs its twin, EVERY test
// path that drives a writer must have an explicit twin registered. This setup
// registers the explicit `NOOP_DASHBOARD_TWIN_WRITER` before each test and
// resets after — so the default unit suite is green WITHOUT weakening the
// fail-closed seam:
//   - it is an EXPLICIT registration (a real `setDashboardArtifactTwinWriter`
//     call), never a silent no-op-when-unregistered default;
//   - production ships NO such setup, so a dropped boot wiring there still
//     crashes loud at the first mutation;
//   - a test that needs a DIFFERENT twin (a recording spy, the real host twin,
//     or the truly-unregistered fail-closed case) resets + re-registers in its
//     own `beforeEach`/body (file hooks run AFTER this global one).
beforeEach(() => {
  resetDashboardArtifactTwinWriter();
  setDashboardArtifactTwinWriter(NOOP_DASHBOARD_TWIN_WRITER);
});

afterEach(() => resetDashboardArtifactTwinWriter());
