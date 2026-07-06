import "server-only";

// Host-owned request/response log capture (cinatra#981, part of the #978
// core/extension boundary epic).
//
// Backs `HostLoggerPort.capture`/`captureDirectory` (packages/sdk-extensions/
// src/host-context.ts): the host — not the extension — owns the on-disk
// directory, the file write, and the rotation/retention policy. This retires
// the pre-#981 pattern where gemini-connector/openai-connector/apollo-connector
// reached for `node:fs` directly (banned in extension source going forward by
// the extension-side conformance gate, scripts/audit/extension-fs-import-ban.mjs
// / cinatra#979) to write their own `data/logs/<name>/` capture files with a
// hand-rolled retention module.
//
// Directory layout: `<extension-data-root>/logs/<sanitized packageName>/
// <sanitized channel>/<timestamp>__<sanitized label>__<sanitized kind>.json` —
// nested UNDER the same managed, deploy-configurable extension data root
// (`resolveExtensionDataRoot`, cinatra#791) captures used to live outside of
// (the pre-#981 captures landed on the ephemeral `process.cwd()/data/logs/`
// layer, invisible to the extension-data-root deploy topology and lost on
// redeploy).
//
// Filename convention + retention cap are a DELIBERATE port of the connectors'
// pre-#981 `log-retention.ts` behavior (regression parity): a fixed-width,
// lexicographically-sortable UTC timestamp prefix so a plain string sort is
// chronological, and a default 200-file-per-directory cap.

import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveExtensionDataRoot } from "@/lib/extension-data-root";

/** Default cap on retained capture files per (extension, channel) directory —
 *  mirrors the pre-#981 connector-side `DEFAULT_MAX_LOG_FILES`. */
export const DEFAULT_CAPTURE_MAX_FILES = 200;

/** A captured request/response (or any structured) log entry. `kind` is an
 *  extension-chosen free-form label (historically "request"/"response") —
 *  sanitized before it reaches the filename. */
export type ExtensionCaptureEntry = {
  label: string;
  kind: string;
  body: unknown;
};

// Sanitize an untrusted path SEGMENT (packageName / channel / label / kind) —
// never trust extension-supplied strings as raw path components (traversal:
// `../../etc`; a `/`-bearing scoped package name like
// `@cinatra-ai/gemini-connector` would otherwise create nested directories).
// Mirrors the connectors' own pre-#981 `sanitizeLogLabel` shape so filenames
// stay familiar. Never returns an empty string.
function sanitizeSegment(raw: string, fallback: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return cleaned || fallback;
}

/** The host-owned on-disk directory a `capture(packageName, channel, ...)`
 *  call writes into. Read-only display value for an extension's own settings/
 *  telemetry surface — the extension has no direct filesystem access to this
 *  path; `captureExtensionLogEntry` is the only write path. */
export function resolveExtensionCaptureDirectory(packageName: string, channel: string): string {
  return path.join(
    resolveExtensionDataRoot(),
    "logs",
    sanitizeSegment(packageName, "extension"),
    sanitizeSegment(channel, "default"),
  );
}

function buildCaptureTimestamp(): string {
  // Fixed-width, lexicographically-sortable UTC prefix (":"/"." -> "-").
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function buildCaptureFilename(label: string, kind: string): string {
  return `${buildCaptureTimestamp()}__${sanitizeSegment(label, "capture")}__${sanitizeSegment(kind, "entry")}.json`;
}

// Matches a `${ISO-timestamp}__${label}__${kind}.json` capture file — the SAME
// shape `buildCaptureFilename` writes, so a plain string sort of the matching
// names is chronological (oldest first). An unrelated file dropped into the
// directory is never pruned.
const CAPTURE_FILENAME_RE = /^\d{4}-\d{2}-\d{2}t[\d-]+z__.+__[a-z0-9-]+\.json$/i;

/** Best-effort rotation: keep only the newest `maxFiles` capture files in
 *  `directory`. NEVER throws — a housekeeping failure must not break the
 *  write path that produced the capture (mirrors the pre-#981 connector-side
 *  `enforceLogRetention`). */
export async function enforceExtensionCaptureRetention(
  directory: string,
  maxFiles: number = DEFAULT_CAPTURE_MAX_FILES,
): Promise<void> {
  if (!Number.isFinite(maxFiles) || maxFiles <= 0) return;
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return; // directory absent/unreadable — nothing to prune.
  }
  const captureFiles = entries.filter((name) => CAPTURE_FILENAME_RE.test(name)).sort();
  if (captureFiles.length <= maxFiles) return;
  const stale = captureFiles.slice(0, captureFiles.length - maxFiles);
  await Promise.all(stale.map((name) => unlink(path.join(directory, name)).catch(() => {})));
}

/**
 * Write one capture entry for `packageName`'s `channel` stream. HOST-owned
 * storage/rotation ONLY — the extension is responsible for its own
 * enabled/opt-in gate and any field-level redaction BEFORE calling this (the
 * `body` here is persisted as-is). A genuine write failure (disk full,
 * permissions) propagates; rotation failures are swallowed.
 */
export async function captureExtensionLogEntry(
  packageName: string,
  channel: string,
  entry: ExtensionCaptureEntry,
  maxFiles: number = DEFAULT_CAPTURE_MAX_FILES,
): Promise<void> {
  const directory = resolveExtensionCaptureDirectory(packageName, channel);
  await mkdir(directory, { recursive: true });
  const filename = buildCaptureFilename(entry.label, entry.kind);
  await writeFile(path.join(directory, filename), JSON.stringify(entry.body, null, 2), "utf8");
  await enforceExtensionCaptureRetention(directory, maxFiles);
}
