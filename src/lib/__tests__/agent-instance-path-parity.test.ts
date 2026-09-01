/**
 * A REPAIR RUN IS A RUN, SO THE LINK TO ITS PAGE IS A URL (cinatra#3080).
 *
 * `buildAgentInstancePath` exists in THREE verbatim copies — the host's, the
 * notifications package's, and the one inlined in the execution path — each
 * duplicated on purpose so no package boundary is crossed for a four-line pure
 * string function. The copies are the risk: the measured defect was a repair
 * run's id (`lifecycle-repair-run:<repairId>`, a colon in a path segment) being
 * emitted raw, and a fix applied to one copy and not another leaves the same
 * broken link behind a different caller. These cases read all three.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildAgentInstancePath } from "@/lib/agent-url";

const REPAIR_RUN_ID = "lifecycle-repair-run:8f1d2a3b-4c5d-6e7f-8091-a2b3c4d5e6f7";
const ORDINARY_RUN_ID = "8f1d2a3b-4c5d-6e7f-8091-a2b3c4d5e6f7";
const PACKAGE = "@cinatra-ai/blog-draft-writer-agent";

describe("cinatra#3080 — the link to a repair run's page", () => {
  it("is a URL: the run id is one path segment that decodes back to the run", () => {
    const path = buildAgentInstancePath(PACKAGE, REPAIR_RUN_ID);
    const segments = path.split("/");
    const last = segments[segments.length - 1]!;
    expect(last).not.toContain(":");
    expect(decodeURIComponent(last)).toBe(REPAIR_RUN_ID);
  });

  it("leaves every ordinary run's link byte-identical — a uuid encodes to itself", () => {
    expect(buildAgentInstancePath(PACKAGE, ORDINARY_RUN_ID)).toBe(
      `/agents/cinatra-ai/blog-draft-writer-agent/${ORDINARY_RUN_ID}`,
    );
  });

  // The other two copies are not importable from here — the notifications one
  // is not on the package's export map, and the execution one is module-
  // private (inlined so the route-graph ratchet sees no new first-party edge
  // from that hot path). They are therefore read WHERE THEY ARE WRITTEN. A
  // revert of the encoding in either fails this, which is the whole point:
  // the first fix landed in three places and only one of them was covered.
  it.each([
    ["the notifications copy", "packages/notifications/src/agent-run-href.ts", "buildAgentInstancePath"],
    ["the execution path's inlined copy", "packages/agents/src/execution.ts", "buildReviewRunBasePath"],
  ])("%s encodes its instance-id segment too", (_label, file, fnName) => {
    const source = readFileSync(join(process.cwd(), file), "utf8");
    const at = source.indexOf(`function ${fnName}(`);
    expect(at).toBeGreaterThan(-1);
    const body = source.slice(at, at + 400);
    expect(body).toContain("encodeURIComponent(instanceId)");
    // …and emits the encoded value, not the raw one, into the segment.
    expect(body).not.toMatch(/\/\$\{instanceId\}/);
  });

  // The page LAYOUT builds the same address a fourth time, as the prefix its
  // breadcrumb contribution is matched against `usePathname()` — which is the
  // ENCODED path. An unencoded prefix there never matches a repair run's own
  // page, so the run opens with no crumb: the same defect, one layer up.
  it("the crumb prefix the run page publishes is encoded, so it matches the page's own pathname", () => {
    const source = readFileSync(
      join(process.cwd(), "packages/agents/src/agent-page-layout.tsx"),
      "utf8",
    );
    const at = source.indexOf("publishCrumbContributions(pathname");
    expect(at).toBeGreaterThan(-1);
    const call = source.slice(at, at + 300);
    expect(call).toContain("encodeURIComponent(instanceId)");
    expect(call).not.toMatch(/\/\$\{instanceId\}/);
  });
});
