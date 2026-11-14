// THE EXPORTED DATA ROAD TYPE (cinatra#3092, #4118 fold). The type an extension
// display writes its `dataRoad` against admits exactly the two named roads,
// `{ road: "none" }` and `{ road: "session", apiUrl }`, and no other. These are
// TYPE assertions, read by the root typecheck (`tsc --noEmit`, which compiles
// this file): an assignment the type must admit is written plainly, and one it
// must reject carries `@ts-expect-error`, which is itself a diagnostic the day
// the type admits it. No value is cast (`as`) to a road. The vitest run of this
// file only keeps the values honest.
//
//   pnpm --filter @cinatra-ai/dashboards exec vitest run \
//     src/components/__tests__/read-only-composition-data-road-type.test.ts

import { describe, expect, expectTypeOf, test } from "vitest";

import type {
  ReadOnlyComposedDashboardProps,
  ReadOnlyCompositionDataRoad,
  ReadOnlySinglePortletProps,
} from "@cinatra-ai/sdk-dashboard/components";

// Admitted, as written.
const NONE: ReadOnlyCompositionDataRoad = { road: "none" };
const SESSION: ReadOnlyCompositionDataRoad = { road: "session", apiUrl: "/api/dashboards/cubejs-api/v1" };
const DASHBOARD_PROPS_ROAD: ReadOnlyComposedDashboardProps["dataRoad"] = { road: "none" };
const PORTLET_PROPS_ROAD: ReadOnlySinglePortletProps["dataRoad"] = { road: "none" };

// The road names, exactly: a name added to the type or taken from it is a
// diagnostic here (a missing key, or a key the record does not have).
const ROAD_NAMES: Record<ReadOnlyCompositionDataRoad["road"], true> = { none: true, session: true };

// Rejected.
// @ts-expect-error -- an unknown road name is not a data road
const UNKNOWN: ReadOnlyCompositionDataRoad = { road: "sealed" };
// @ts-expect-error -- a case-varied road name is not a data road
const CASE_VARIED: ReadOnlyCompositionDataRoad = { road: "None" };
// @ts-expect-error -- the session road carries its address
const SESSION_WITHOUT_ADDRESS: ReadOnlyCompositionDataRoad = { road: "session" };
// @ts-expect-error -- a road is an object with a name, not a bare name
const BARE_NAME: ReadOnlyCompositionDataRoad = "none";

describe("the exported data road type admits the two named roads and no other (#4118 fold)", () => {
  test("[guard] (y1) { road: \"none\" } is a data road of its own, and both promoted views take it", () => {
    expectTypeOf<ReadOnlyCompositionDataRoad["road"]>().toEqualTypeOf<"none" | "session">();
    expect(NONE).toEqual({ road: "none" });
    expect(DASHBOARD_PROPS_ROAD).toEqual({ road: "none" });
    expect(PORTLET_PROPS_ROAD).toEqual({ road: "none" });
    expect(SESSION).toEqual({ road: "session", apiUrl: "/api/dashboards/cubejs-api/v1" });
    expect(Object.keys(ROAD_NAMES).sort()).toEqual(["none", "session"]);
  });

  test("[guard] (y2) the values the type rejects are kept as written: the rejection is the typecheck's", () => {
    expect([UNKNOWN, CASE_VARIED, SESSION_WITHOUT_ADDRESS, BARE_NAME]).toEqual([
      { road: "sealed" },
      { road: "None" },
      { road: "session" },
      "none",
    ]);
  });
});
