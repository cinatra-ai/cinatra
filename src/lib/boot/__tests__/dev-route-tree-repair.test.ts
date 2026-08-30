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

import { beforeEach, describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  DEV_ROUTE_TREE_ASK_TIMEOUT_MS,
  DEV_ROUTE_TREE_MAX_ATTEMPTS,
  DEV_ROUTE_TREE_PROBE_PATH,
  DEV_ROUTE_TREE_ROUTE_SOURCE,
  ensureDevRouteTreeResolves,
  resolveDevProbePort,
} from "@/lib/boot/dev-route-tree-repair";
import { resetStartBootForTests, startBoot } from "@/lib/boot/start-boot";
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
    // Only an explicit development server detaches. A runtime nobody
    // anticipated keeps the old behaviour and never reaches the repair, which
    // writes to the working tree.
    expect(shouldAwaitBootInRegister({})).toBe(true);
    expect(shouldAwaitBootInRegister({ NODE_ENV: "test" })).toBe(true);
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

describe("the boot entry point starts exactly one boot, and the right one", () => {
  beforeEach(() => {
    resetStartBootForTests();
  });

  /** A boot that never settles on its own, so a caller that WAITS is visible. */
  function pendingBoot() {
    let release: () => void = () => undefined;
    let reject: (err: unknown) => void = () => undefined;
    let calls = 0;
    const boot = () => {
      calls += 1;
      return new Promise<void>((res, rej) => {
        release = () => res();
        reject = (err) => rej(err);
      });
    };
    return {
      boot,
      release: () => release(),
      fail: (err: unknown) => reject(err),
      get calls() {
        return calls;
      },
    };
  }

  const settled = <T,>(promise: Promise<T>) =>
    Promise.race([promise.then(() => "settled" as const), Promise.resolve("pending" as const)]);

  it("returns on the development server WITHOUT waiting for the boot", async () => {
    const b = pendingBoot();
    await expect(
      startBoot({ NODE_ENV: "development" }, { boot: b.boot, ensureRouteTree: async () => "resolved" }),
    ).resolves.toBeUndefined();
    b.release();
  });

  it("waits for the boot in production, and a fatal phase still propagates", async () => {
    const b = pendingBoot();
    const started = startBoot({ NODE_ENV: "production" }, { boot: b.boot });
    await expect(settled(started)).resolves.toBe("pending");
    const boom = new Error("fatal phase");
    b.fail(boom);
    await expect(started).rejects.toBe(boom);
  });

  it("waits for the boot in every runtime that is not the development server", async () => {
    for (const NODE_ENV of ["test", undefined]) {
      resetStartBootForTests();
      const b = pendingBoot();
      const started = startBoot({ NODE_ENV }, { boot: b.boot });
      await expect(settled(started)).resolves.toBe("pending");
      b.release();
      await started;
    }
  });

  it("resolves the route tree BEFORE the first boot phase runs", async () => {
    const order: string[] = [];
    await startBoot(
      { NODE_ENV: "development" },
      {
        ensureRouteTree: async () => {
          order.push("route-tree");
          return "resolved";
        },
        boot: async () => {
          order.push("boot");
        },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual(["route-tree", "boot"]);
  });

  // The development server re-invokes the hook (a hot reload does it, and the
  // repair above touches a file under src/app on purpose). A second concurrent
  // boot would run migrations and extension activation twice, each pass
  // resetting the other's phase log.
  it("runs ONE boot per process however many times it is called", async () => {
    const b = pendingBoot();
    await startBoot({ NODE_ENV: "development" }, { boot: b.boot, ensureRouteTree: async () => "resolved" });
    await startBoot({ NODE_ENV: "development" }, { boot: b.boot, ensureRouteTree: async () => "resolved" });
    await startBoot({ NODE_ENV: "development" }, { boot: b.boot, ensureRouteTree: async () => "resolved" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(b.calls).toBe(1);
    b.release();
  });

  // Nothing is waiting to catch it on the development server, so a failed boot
  // is REPORTED rather than left as an unhandled rejection.
  it("reports a failed development boot instead of rejecting into nothing", async () => {
    const reported: unknown[] = [];
    await startBoot(
      { NODE_ENV: "development" },
      {
        ensureRouteTree: async () => "resolved",
        boot: async () => {
          throw new Error("a phase failed");
        },
        logError: (_message, err) => reported.push(err),
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reported).toHaveLength(1);
  });

  it("hands the boot over from the framework entry point", () => {
    const entry = readFileSync(path.join(REPO_ROOT, "src", "instrumentation.node.ts"), "utf8");
    expect(entry).toContain("startBoot()");
    expect(entry).not.toContain("runBoot()");
  });
});

describe("the ask itself is bounded and asks the right server", () => {
  it("carries a deadline on every ask, so an answer that never comes cannot hold the boot", () => {
    const source = readFileSync(
      path.join(REPO_ROOT, "src", "lib", "boot", "dev-route-tree-repair.ts"),
      "utf8",
    );
    expect(source).toContain("AbortSignal.timeout(DEV_ROUTE_TREE_ASK_TIMEOUT_MS)");
    expect(DEV_ROUTE_TREE_ASK_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DEV_ROUTE_TREE_MAX_ATTEMPTS * DEV_ROUTE_TREE_ASK_TIMEOUT_MS).toBeLessThanOrEqual(120_000);
  });

  it("asks the port the launcher resolved", () => {
    expect(resolveDevProbePort({ PORT: "3126" }, [])).toBe("3126");
  });

  it("asks the port the command line names when nothing resolved one", () => {
    expect(resolveDevProbePort({}, ["node", "next", "dev", "--port", "3126"])).toBe("3126");
    expect(resolveDevProbePort({}, ["node", "next", "dev", "-p", "3131"])).toBe("3131");
    expect(resolveDevProbePort({}, ["node", "next", "dev", "--port=3141"])).toBe("3141");
  });

  it("falls back to the framework default when neither names one", () => {
    expect(resolveDevProbePort({}, ["node", "next", "dev"])).toBe("3000");
  });

  it("does not wait after the last ask", async () => {
    const d = driver([404]);
    const slept: number[] = [];
    await ensureDevRouteTreeResolves({ ...d.options, sleep: async (ms) => void slept.push(ms) });
    expect(slept).toHaveLength(DEV_ROUTE_TREE_MAX_ATTEMPTS - 1);
  });
});
