/**
 * cinatra#3745 pre-review 1 cures, on the host side of the source binding:
 *
 * - The dispatch fence: the first message of a bound dispatch names the bound
 *   source under a reserved key, so the loader's mount that receives it runs the
 *   task only for its own source. The key is a cross-language ABI with
 *   docker/wayflow/agent_loader.py (no shared import), pinned here.
 * - The loader's answer is read under a byte bound and refused when larger or
 *   not JSON, before it is parsed, hashed or stored.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CINATRA_EXPECTED_SOURCE_MESSAGE_KEY, LOADER_SELECTION_MAX_BYTES, selectWayflowRunStepToolPolicy } from "../agent-run-serde";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");
const read = (relPath: string) => readFileSync(join(REPO_ROOT, relPath), "utf8");

describe("the dispatch fence key", () => {
  it("is the loader's key", () => {
    expect(CINATRA_EXPECTED_SOURCE_MESSAGE_KEY).toBe("__cinatra_expected_source__");
    expect(read("docker/wayflow/agent_loader.py")).toContain(`CINATRA_EXPECTED_SOURCE_MESSAGE_KEY = "${CINATRA_EXPECTED_SOURCE_MESSAGE_KEY}"`);
  });
});

describe("the loader's answer is bounded before it is read", () => {
  const sha = (t: string) => createHash("sha256").update(t).digest("hex");
  const graph = JSON.stringify({ flow: { id: "step" } });
  const binding = { sourceSha256: "a".repeat(64), executedSourceSha256: "b".repeat(64), declarationSourceSha256: sha(graph), declarationSource: graph };
  const env = () => { vi.stubEnv("WAYFLOW_BASE_URL", "http://wayflow.test:3010"); vi.stubEnv("CINATRA_BRIDGE_TOKEN", "bridge-test-value"); };
  const select = (response: Response) => selectWayflowRunStepToolPolicy({ agentUrl: "http://wayflow.test:3010/agents/v/s", contextId: "c" },
    vi.fn(async () => response) as unknown as typeof fetch);
  afterEach(() => { vi.unstubAllEnvs(); });

  it("keeps a bound that a loader answer of a real graph fits under", () => {
    expect(LOADER_SELECTION_MAX_BYTES).toBe(8 * 1024 * 1024);
  });

  it("accepts an answer within the bound", async () => {
    env();
    await expect(select(new Response(JSON.stringify({ selectedSourceBinding: binding })))).resolves.toMatchObject({ contextId: "c" });
  });

  it("refuses a valid binding padded past the bound, and stops reading it", async () => {
    env();
    // Padded by 1 MiB (16 chunks) past the bound, so a read that stops at the first chunk over the bound
    // leaves chunks unread; a padding inside the last chunk could not show that the read stopped.
    const padded = JSON.stringify({ selectedSourceBinding: binding, composedOas: "x".repeat(LOADER_SELECTION_MAX_BYTES + 16 * 65536) });
    const encoded = new TextEncoder().encode(padded);
    let pulled = 0; let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= encoded.byteLength) { controller.close(); return; }
        controller.enqueue(encoded.subarray(pulled, pulled + 65536)); pulled += 65536;
      },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    await expect(select(new Response(body))).rejects.toThrow("step_tool_loader_answer_oversized");
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(encoded.byteLength);
  });

  it("refuses an answer that declares a length past the bound before reading it", async () => {
    env();
    let pulled = false;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { pulled = true; controller.enqueue(new TextEncoder().encode(JSON.stringify({ selectedSourceBinding: binding }))); controller.close(); } },
      { highWaterMark: 0 });
    const response = new Response(body, { headers: { "content-length": String(LOADER_SELECTION_MAX_BYTES + 1) } });
    await expect(select(response)).rejects.toThrow("step_tool_loader_answer_oversized");
    expect(pulled).toBe(false);
  });

  it("refuses an answer that is not UTF-8 JSON with a stated refusal", async () => {
    env();
    for (const body of ["<html>", "", "{\"selectedSourceBinding\":", new Uint8Array([0x7b, 0xff, 0x7d])]) {
      await expect(select(new Response(body))).rejects.toThrow("step_tool_loader_answer_invalid");
    }
  });
});
