/**
 * Make sure the development server can actually route to its readiness endpoint.
 *
 * WHAT GOES WRONG WITHOUT THIS — measured, not inferred.
 *
 * The development server (Next 16 / Turbopack) builds the App Router's route
 * tree lazily and on the main thread. A request that arrives before that tree
 * exists is answered `404` — with no route and no application code in the
 * request's own timing breakdown — and the framework KEEPS that answer: every
 * later request for the same path is answered 404 too, for the life of the
 * process, even long after the tree is complete and even though the route file
 * has been compiled (it appears in `.next/dev/server/app-paths-manifest.json`).
 * The only thing that clears it is a filesystem change under `src/app`, which
 * makes the framework rebuild the entry.
 *
 * The boot sequence is what holds that window open: it starts the moment the
 * server becomes ready and occupies the main thread for minutes on a fresh
 * instance (several phases talk to Postgres synchronously). A harness that
 * starts polling as soon as the process starts therefore lands its first
 * request inside the window, and `/api/health` — the endpoint every development
 * harness polls for readiness — answers 404 until the instance is restarted.
 * Measured on a fresh instance: ten minutes of `GET /api/health 404` from a
 * server whose own boot log shows every phase finishing normally, against a
 * ten-minute readiness budget that then expires with nothing to read.
 *
 * WHAT THIS DOES. Before the first boot phase runs, ask the instance for
 * `/api/health` over loopback. Any answer other than 404 proves the route
 * resolved and ends it immediately — including the `503` the endpoint gives
 * while the boot has not started, which is the expected first answer. A 404
 * means the framework has cached a not-found for a route that exists, so the
 * route's own source file is touched — its modification time only, never its
 * bytes — which is the invalidation the framework acts on, and the ask repeats.
 *
 * WHAT IT IS NOT. It is not a readiness wait, it decides nothing, and it never
 * fails a boot: a server that cannot answer its own loopback request boots
 * exactly as it did before. It is bounded, so a boot can never be held behind
 * it, and it is confined to the development server — a production server builds
 * its route tree at build time and has no window to land in.
 */

import { utimesSync } from "node:fs";
import path from "node:path";

/** The path asked for: the one route that answers at every point of a boot. */
export const DEV_ROUTE_TREE_PROBE_PATH = "/api/health";

/** The source file whose entry is invalidated when that path answers 404. */
export const DEV_ROUTE_TREE_ROUTE_SOURCE = path.join("src", "app", "api", "health", "route.ts");

/** How many times to ask before booting anyway. */
export const DEV_ROUTE_TREE_MAX_ATTEMPTS = 24;

/** How long to wait between asks. */
export const DEV_ROUTE_TREE_RETRY_MS = 250;

const LOG = "[dev-route-tree]";

/**
 * `resolved` — the route answered on its own.
 * `repaired` — it answered 404 first, and answered after the invalidation.
 * `unresolved` — it never answered within the budget; the boot runs regardless.
 */
export type DevRouteTreeOutcome = "resolved" | "repaired" | "unresolved";

export type EnsureDevRouteTreeOptions = {
  /** The HTTP status the instance gave, or null when it could not be asked. */
  fetchStatus?: (url: string) => Promise<number | null>;
  /** Invalidate the route's compiled entry. */
  invalidate?: (file: string) => void;
  sleep?: (ms: number) => Promise<void>;
  env?: Record<string, string | undefined>;
  cwd?: string;
  log?: (message: string) => void;
};

/** Read a status without ever throwing: an unreachable server is not an error here. */
async function defaultFetchStatus(url: string): Promise<number | null> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    return response.status;
  } catch {
    return null;
  }
}

/**
 * Touch the route's source file — modification time only, so the working tree
 * is byte-identical afterwards and version control sees nothing. Best-effort:
 * a read-only checkout simply does not get the repair.
 */
function defaultInvalidate(file: string): void {
  try {
    const now = new Date();
    utimesSync(file, now, now);
  } catch {
    /* best-effort */
  }
}

export async function ensureDevRouteTreeResolves(
  options: EnsureDevRouteTreeOptions = {},
): Promise<DevRouteTreeOutcome> {
  const env = options.env ?? process.env;
  const fetchStatus = options.fetchStatus ?? defaultFetchStatus;
  const invalidate = options.invalidate ?? defaultInvalidate;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = options.log ?? ((message: string) => console.log(message));

  // The port the dev launcher resolved into the environment before it spawned
  // the server (scripts/dev-server.mjs), falling back to the framework default.
  const url = `http://127.0.0.1:${env.PORT ?? "3000"}${DEV_ROUTE_TREE_PROBE_PATH}`;
  const routeSource = path.join(options.cwd ?? process.cwd(), DEV_ROUTE_TREE_ROUTE_SOURCE);

  let repaired = false;
  for (let attempt = 1; attempt <= DEV_ROUTE_TREE_MAX_ATTEMPTS; attempt += 1) {
    const status = await fetchStatus(url);
    if (status !== null && status !== 404) {
      if (repaired) {
        log(
          `${LOG} ${DEV_ROUTE_TREE_PROBE_PATH} was answered 404 by a route tree this server had not ` +
            `finished building; the route's entry was invalidated and it answers again.`,
        );
      }
      return repaired ? "repaired" : "resolved";
    }
    if (status === 404) {
      invalidate(routeSource);
      repaired = true;
    }
    await sleep(DEV_ROUTE_TREE_RETRY_MS);
  }

  log(
    `${LOG} ${DEV_ROUTE_TREE_PROBE_PATH} did not answer within ${DEV_ROUTE_TREE_MAX_ATTEMPTS} attempts. ` +
      `Booting anyway — nothing here gates the boot.`,
  );
  return "unresolved";
}
