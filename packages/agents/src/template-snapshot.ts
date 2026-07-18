// Agent-template version snapshots — build, content-hash, and diff.
//
// Extracted VERTICAL SLICE out of ./store (exec-plane S3, cinatra#1708, PR
// #1754): packages/agents/src/store.ts is a file-size-ratcheted architecture
// bottleneck sitting exactly AT its ceiling, so the S3 snapshot
// execution-environment capture could not land inline — and the snapshot
// concern (build a version snapshot from the live template row, hash it,
// diff two snapshots) is a cohesive seam that stands alone. ./store
// re-exports everything here, so every existing `from "./store"` /
// `@cinatra-ai/agents` consumer is untouched.
//
// NOTE for the route-graph ratchet: this module is reachable wherever
// ./store is (the re-export edge), but it pulls NO new subtree — its only
// first-party imports are the already-reachable @cinatra-ai/sdk-extensions
// barrel and type-only ./store types.

import { createHash } from "node:crypto";
import { diffLines } from "diff";
import {
  parseExecutionEnvironment,
  isEmptyExecutionEnvironment,
} from "@cinatra-ai/sdk-extensions";

import type { AgentTemplateRecord, AgentTemplateVersionSnapshot } from "./store";

// ---------------------------------------------------------------------------
// computeSnapshotContentHash
// ---------------------------------------------------------------------------

export function computeSnapshotContentHash(snapshot: AgentTemplateVersionSnapshot): string {
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}

// ---------------------------------------------------------------------------
// buildSnapshotFromTemplate
// ---------------------------------------------------------------------------

export function buildSnapshotFromTemplate(
  template: AgentTemplateRecord,
): AgentTemplateVersionSnapshot {
  return {
    name: template.name,
    description: template.description ?? null,
    sourceNl: template.sourceNl,
    compiledPlan: template.compiledPlan,
    inputSchema: template.inputSchema,
    outputSchema: template.outputSchema ?? null,
    approvalPolicy: template.approvalPolicy,
    type: template.type,
    taskSpec: template.taskSpec ?? null,
    packageVersion: template.packageVersion ?? null,
    lgGraphCode: template.lgGraphCode ?? null,         //
    lgGraphId: template.lgGraphId ?? null,             //
    // Shape-preserving capture (cinatra#1708): the key exists ONLY when the
    // template declares a non-empty environment, so env-less templates keep
    // their legacy snapshot shape (and content hash) byte-for-byte. The
    // captured value is the CANONICAL parsed spec (codex S3-r0 finding 9):
    // equivalent reordered/duplicated declarations snapshot — and hash —
    // identically, and an INVALID declaration is rejected here fail-closed
    // (version-save is the last gate before a recipe becomes immutable; a
    // snapshot must never version a declaration the builder would refuse).
    ...captureSnapshotExecutionEnvironment(template),
  };
}

function captureSnapshotExecutionEnvironment(
  template: AgentTemplateRecord,
): { executionEnvironment: unknown } | Record<string, never> {
  if (template.executionEnvironment == null) return {};
  const parsed = parseExecutionEnvironment(template.executionEnvironment);
  if (!parsed.ok) {
    throw new Error(
      `[buildSnapshotFromTemplate] template ${template.id} declares an invalid ` +
        `execution environment (refusing to version it):\n- ${parsed.errors.join("\n- ")}`,
    );
  }
  if (isEmptyExecutionEnvironment(parsed.spec)) return {};
  return { executionEnvironment: parsed.spec };
}

// ---------------------------------------------------------------------------
// diffSnapshots — returns unified line diff string between two snapshots
// ---------------------------------------------------------------------------

export function diffSnapshots(
  oldSnapshot: AgentTemplateVersionSnapshot,
  newSnapshot: AgentTemplateVersionSnapshot,
): string {
  const oldJson = JSON.stringify(oldSnapshot, null, 2);
  const newJson = JSON.stringify(newSnapshot, null, 2);
  const parts = diffLines(oldJson, newJson);
  return parts
    .map((part) => {
      const prefix = part.added ? "+" : part.removed ? "-" : " ";
      return part.value
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => `${prefix} ${line}`)
        .join("\n");
    })
    .join("\n");
}
