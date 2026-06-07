import "server-only";

import type * as SentryNextjs from "@sentry/nextjs";

// Re-export the runtime-safe shared surface so callers of
// `@cinatra-ai/errors/server` keep working from server contexts. The
// browser/edge configs import the runtime-safe main (`@cinatra-ai/errors`)
// directly (server-only would break them).
//
// Use the concrete `./index` module specifier. Directory-import ambiguity is
// not a repo pattern.
export {
  shouldInitSentry,
  buildSentryClientOptions,
  beforeSendFilter,
  beforeBreadcrumbFilter,
  type SentryClientOptions,
  type SentryClientRuntime,
} from "./index";

// ---------------------------------------------------------------------------
// Server-only Sentry helpers.
//
// - getSentry(): runtime-loaded namespace, or null when Sentry is disabled
// - captureBackgroundJobError(jobName, err, jobId): BullMQ failed-hook helper
// - captureClientError(err, meta): generic capture helper for server callers
// - withSentryServerAction(fn): wraps a server action to capture+rethrow
// ---------------------------------------------------------------------------

type SentryNamespace = typeof SentryNextjs;

let _sentry: SentryNamespace | null | undefined;

async function loadSentry(): Promise<SentryNamespace | null> {
  if (_sentry !== undefined) return _sentry;
  const { shouldInitSentry: gate } = await import("./index");
  if (!gate()) {
    _sentry = null;
    return _sentry;
  }
  try {
    _sentry = (await import("@sentry/nextjs")) as SentryNamespace;
  } catch {
    _sentry = null;
  }
  return _sentry;
}

export async function getSentry(): Promise<SentryNamespace | null> {
  return loadSentry();
}

export function getSentrySync(): SentryNamespace | null {
  return _sentry ?? null;
}

export async function captureBackgroundJobError(
  err: unknown,
  meta: { jobName?: string; jobId?: string | number; queueName?: string },
): Promise<void> {
  const sentry = await loadSentry();
  if (!sentry) return;
  try {
    sentry.captureException(err, {
      tags: {
        component: "background-jobs",
        jobName: meta.jobName ?? "unknown",
        jobId: meta.jobId != null ? String(meta.jobId) : "unknown",
        queueName: meta.queueName ?? "unknown",
      },
    });
  } catch {
    // Never let Sentry crash a worker.
  }
}

export async function captureClientError(
  err: unknown,
  meta?: { component?: string },
): Promise<void> {
  const sentry = await loadSentry();
  if (!sentry) return;
  try {
    sentry.captureException(
      err,
      meta?.component ? { tags: { component: meta.component } } : undefined,
    );
  } catch {
    // Never crash the caller.
  }
}

export async function withSentryServerAction<T>(
  fn: () => Promise<T>,
  opts?: { actionName?: string },
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const sentry = await loadSentry();
    if (sentry) {
      try {
        sentry.captureException(err, {
          tags: {
            component: "server-action",
            actionName: opts?.actionName ?? "unknown",
          },
        });
      } catch {
        // Swallow Sentry-internal errors.
      }
    }
    throw err;
  }
}
