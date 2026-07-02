import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  PORTLET_KINDS_WITH_BUNDLED_COMPONENT,
  ANALYTICS_PORTLET_KIND,
  ANALYTICS_PORTLET_KIND_ALIAS,
} from "@cinatra-ai/dashboards/extension-materialization";

// Parity assertion (cinatra#660): the server-safe
// `PORTLET_KINDS_WITH_BUNDLED_COMPONENT` (used by the runtime portlet-kind
// installer to gate `rendersAs`) MUST equal the live client `COMPONENT_MAP` keys
// PLUS the analytics/cube-dashboard keystone kinds the embedded grid renders. We
// parse the `"use client"` portlet-host SOURCE (not import it — that would pull
// the client bundle into a node test) and compare the key sets. If someone adds
// a portlet component without updating the server list, the runtime installer's
// rendersAs gate would silently reject a now-valid kind — this test catches it.

function componentMapKeysFromSource(): Set<string> {
  const src = readFileSync(
    join(process.cwd(), "src/components/dashboards/portlet-host.tsx"),
    "utf8",
  );
  // Extract the COMPONENT_MAP object literal body.
  const m = src.match(/const COMPONENT_MAP:[^=]*=\s*{([\s\S]*?)};/);
  if (!m) throw new Error("could not locate COMPONENT_MAP in portlet-host.tsx");
  const body = m[1];
  // Keys are quoted string literals (e.g. "object-list":) — collect them.
  const keys = new Set<string>();
  for (const km of body.matchAll(/"([a-z0-9-]+)"\s*:/gi)) {
    keys.add(km[1]);
  }
  return keys;
}

describe("portlet component parity (cinatra#660)", () => {
  it("PORTLET_KINDS_WITH_BUNDLED_COMPONENT == COMPONENT_MAP keys ∪ analytics aliases", () => {
    const mapKeys = componentMapKeysFromSource();
    const expected = new Set<string>([
      ...mapKeys,
      ANALYTICS_PORTLET_KIND,
      ANALYTICS_PORTLET_KIND_ALIAS,
    ]);
    expect(new Set(PORTLET_KINDS_WITH_BUNDLED_COMPONENT)).toEqual(expected);
  });

  it("the COMPONENT_MAP is non-trivial (regex actually matched keys)", () => {
    expect(componentMapKeysFromSource().size).toBeGreaterThanOrEqual(9);
  });
});
