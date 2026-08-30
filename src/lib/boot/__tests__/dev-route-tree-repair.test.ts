// The development server must be able to route to its own readiness endpoint.
//
// The defect this pins, measured on the development runtime (Next 16 /
// Turbopack): a request that arrives before the App Router's route tree exists
// is answered 404 — no route, no application code in its own timing breakdown —
// and the framework KEEPS that answer for the path, for the life of the
// process, even after the route file has been compiled. The boot sequence holds
// that window open, because it starts the moment the server becomes ready and
// occupies the main thread for minutes on a fresh instance. `/api/health`, the
// endpoint every development harness polls for readiness, then answers 404
// until the instance is restarted: ten minutes of `GET /api/health 404` from a
// server whose boot log shows every phase finishing.
//
// Two rules answer it, and both are exercised here:
//   1. the development server does not hold `register()` open for the whole
//      boot — production still does, because a fatal phase must abort startup;
//   2. before the first boot phase runs, the instance asks itself for
//      `/api/health`, and a 404 for a route that exists is repaired by
//      invalidating that route's entry.

import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  DEV_ROUTE_TREE_MAX_ATTEMPTS,
  DEV_ROUTE_TREE_PROBE_PATH,
  DEV_ROUTE_TREE_ROUTE_SOURCE,
  ensureDevRouteTreeResolves,
} from "@/lib/boot/dev-route-tree-repair";
import { shouldAwaitBootInRegister } from "@/lib/boot/register-await-policy";

const REPO_ROOT = path.join(__dirname, "..", "..", "..", "..");

/** A driver that answers a scripted sequence of statuses and records the asks. */
function driver(statuses: (number | null)[]) {
  const asked: string[] = [];
  const invalidated: string[] = [];
  let index = 0;
  return {
    asked,
    invalidated,
    options: {
      fetchStatus: async (url: string) => {
        asked.push(url);
        const next = statuses[Math.min(index, statuses.length - 1)];
        index += 1;
        return next ?? null;
      },
      invalidate: (file: string) => {
        invalidated.push(file);
      },
      sleep: async () => {},
      env: { PORT: "3126" },
      cwd: "/instance",
      log: () => {},
    },
  };
}

describe("the boot does not hold the development server open", () => {
  it("awaits the boot in production, where a fatal phase must abort startup", () => {
    expect(shouldAwaitBootInRegister({ NODE_ENV: "production" })).toBe(true);
  });

  it("does NOT await it on the development server, whose route tree the wait starves", () => {
    expect(shouldAwaitBootInRegister({ NODE_ENV: "development" })).toBe(false);
    expect(shouldAwaitBootInRegister({})).toBe(false);
  });
});

describe("the readiness endpoint is routable before the first boot phase runs", () => {
  it("asks the instance for its own readiness endpoint, over loopback, on the resolved port", async () => {
    const d = driver([503]);
    await ensureDevRouteTreeResolves(d.options);
    expect(d.asked[0]).toBe(`http://127.0.0.1:3126${DEV_ROUTE_TREE_PROBE_PATH}`);
  });

  // 503 is the endpoint's OWN answer while the boot has not started. It proves
  // the route resolved, which is the only thing this step is asking about.
  it("accepts any answer but 404 as proof the route resolved, and touches nothing", async () => {
    const d = driver([503]);
    await expect(ensureDevRouteTreeResolves(d.options)).resolves.toBe("resolved");
    expect(d.invalidated).toEqual([]);
    expect(d.asked).toHaveLength(1);
  });

  it("repairs a 404 for a route that exists by invalidating that route's own entry", async () => {
    const d = driver([404, 200]);
    await expect(ensureDevRouteTreeResolves(d.options)).resolves.toBe("repaired");
    expect(d.invalidated).toEqual([path.join("/instance", DEV_ROUTE_TREE_ROUTE_SOURCE)]);
  });

  // A server whose socket is not accepting yet is not a cached not-found: there
  // is nothing to invalidate, and invalidating on every failed connection would
  // rewrite the file's timestamp for as long as the server takes to come up.
  it("waits out a server that cannot be reached yet without invalidating anything", async () => {
    const d = driver([null, null, 200]);
    await expect(ensureDevRouteTreeResolves(d.options)).resolves.toBe("resolved");
    expect(d.invalidated).toEqual([]);
  });

  it("gives up inside a bounded number of asks, so a boot is never held behind it", async () => {
    const d = driver([404]);
    await expect(ensureDevRouteTreeResolves(d.options)).resolves.toBe("unresolved");
    expect(d.asked).toHaveLength(DEV_ROUTE_TREE_MAX_ATTEMPTS);
  });

  it("names the route file it invalidates, and that file is the readiness route", () => {
    expect(DEV_ROUTE_TREE_ROUTE_SOURCE).toBe(path.join("src", "app", "api", "health", "route.ts"));
    expect(() => readFileSync(path.join(REPO_ROOT, DEV_ROUTE_TREE_ROUTE_SOURCE), "utf8")).not.toThrow();
  });
});

describe("the boot entry point is wired to both rules", () => {
  const startBoot = readFileSync(path.join(REPO_ROOT, "src", "lib", "boot", "start-boot.ts"), "utf8");
  const entry = readFileSync(path.join(REPO_ROOT, "src", "instrumentation.node.ts"), "utf8");

  // The framework's entry point stays a shim: it hands the boot over rather
  // than carrying the decision itself.
  it("hands the boot to the module that decides who waits for it", () => {
    expect(entry).toContain("startBoot()");
    expect(entry).not.toContain("runBoot()");
  });

  it("decides who waits for the boot through the shared policy", () => {
    expect(startBoot).toContain("shouldAwaitBootInRegister");
  });

  it("resolves the route tree BEFORE the first boot phase runs", () => {
    const ensureIdx = startBoot.indexOf("ensureDevRouteTreeResolves()");
    const bootIdx = startBoot.indexOf("runBoot()", ensureIdx);
    expect(ensureIdx).toBeGreaterThan(-1);
    expect(bootIdx).toBeGreaterThan(ensureIdx);
  });

  // Production must still be able to abort startup on a fatal phase, which only
  // works while the framework is waiting on the hook.
  it("awaits the boot on the branch the policy says waits", () => {
    const awaitIdx = startBoot.indexOf("await runBoot()");
    const policyIdx = startBoot.indexOf("shouldAwaitBootInRegister(env)");
    expect(policyIdx).toBeGreaterThan(-1);
    expect(awaitIdx).toBeGreaterThan(policyIdx);
  });
});
