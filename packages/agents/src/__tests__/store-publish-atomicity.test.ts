/**
 * cinatra#2653 (CodeRabbit major) — publish + version binding must be ONE
 * transaction.
 *
 * `publishAgentTemplateAndBindVersion` is DB-backed; its full behavior is
 * exercised by the real-browser publish proof. What a later change must not
 * be able to weaken by accident is the WIRING, pinned here source-grep style
 * (the same strategy as pages.test.tsx):
 *
 *   • the status flip and the version binding both run INSIDE one
 *     `db.transaction`, through the executor-threaded internals
 *     (`_runAgentTemplateUpdate`, `_createAgentTemplateVersionIfChanged`);
 *   • the version-if-changed core threads ONE executor through the latest
 *     read, the insert AND both `currentVersionId` pointer advances (no bare
 *     `db.` writes left inside it);
 *   • the dedup path re-points a stale `currentVersionId` (the retry-repair
 *     demanded by the review) instead of returning early;
 *   • the Objects-layer shadow mirror stays AFTER the transaction.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";

// Both halves are extracted vertical slices (file-size ratchet, same fix
// round): the publish transaction lives in ./publish-template — the seam the
// upload import path calls — and the executor-threaded version cores live in
// ./store-template-versions.
const publishSource = readFileSync(
  path.resolve(__dirname, "..", "publish-template.ts"),
  "utf8",
);
const versionsSource = readFileSync(
  path.resolve(__dirname, "..", "store-template-versions.ts"),
  "utf8",
);

/** The publishAgentTemplateAndBindVersion function body. */
function publishFnBody(): string {
  const start = publishSource.indexOf("export async function publishAgentTemplateAndBindVersion");
  expect(start).toBeGreaterThan(-1);
  const end = publishSource.indexOf("\nexport ", start + 1);
  return publishSource.slice(start, end === -1 ? undefined : end);
}

/** The _createAgentTemplateVersionIfChanged function body. */
function ifChangedBody(): string {
  const start = versionsSource.indexOf("async function _createAgentTemplateVersionIfChanged");
  expect(start).toBeGreaterThan(-1);
  const end = versionsSource.indexOf("\n/**", start + 1);
  return versionsSource.slice(start, end === -1 ? undefined : end);
}

describe("publishAgentTemplateAndBindVersion atomicity wiring (cinatra#2653)", () => {
  it("runs the status flip AND the version binding inside one db.transaction", () => {
    const body = publishFnBody();
    expect(body).toMatch(/db\.transaction\(/);
    expect(body).toMatch(/_runAgentTemplateUpdate\(tx,/);
    expect(body).toMatch(/_createAgentTemplateVersionIfChanged\(tx,/);
  });

  it("flips to published through the guarded update core (all assistant guard arms)", () => {
    expect(publishFnBody()).toMatch(/\{\s*status:\s*"published"\s*\}/);
  });

  it("mirrors to the Objects layer only AFTER the transaction resolves", () => {
    const body = publishFnBody();
    const txEnd = body.indexOf("db.transaction");
    const shadow = body.indexOf("shadowUpsertObject");
    expect(shadow).toBeGreaterThan(txEnd);
    // The shadow call must not be inside the transaction callback: the
    // callback closes before the null-guard that precedes the mirror.
    expect(body).toMatch(/if \(!result\) return null;[\s\S]*shadowUpsertObject/);
  });

  it("_createAgentTemplateVersionIfChanged threads ONE executor — no bare db writes left inside", () => {
    const body = ifChangedBody();
    expect(body).toMatch(/_readLatestAgentTemplateVersion\(exec,/);
    expect(body.match(/_createAgentTemplateVersion\(exec,/g)?.length).toBe(2);
    // Both pointer advances ride the executor.
    expect(body.match(/exec\s*\.update\(agentTemplates\)\.set\(\{ currentVersionId/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(body).not.toMatch(/\bdb\s*\.update\(/);
    expect(body).not.toMatch(/\bdb\s*\.insert\(/);
  });

  it("the dedup path repairs a stale currentVersionId pointer instead of masking it", () => {
    const body = ifChangedBody();
    expect(body).toMatch(/latest\.contentHash === contentHash/);
    expect(body).toMatch(/template\.currentVersionId !== latest\.id/);
  });

  it("the version-number allocation runs on the executor (closing the MAX+1 race under tx)", () => {
    const start = versionsSource.indexOf("async function _createAgentTemplateVersion(");
    expect(start).toBeGreaterThan(-1);
    const body = versionsSource.slice(start, versionsSource.indexOf("\n}", versionsSource.indexOf("return {", start)));
    expect(body).toMatch(/exec\s*[\r\n\s]*\.select\(/);
    expect(body).toMatch(/exec\.insert\(agentTemplateVersions\)/);
  });
});
