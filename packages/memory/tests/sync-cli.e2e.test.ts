/**
 * `memory sync` end-to-end as a REAL command run (cinatra#1378 AC1, client
 * half), against a stub MCP endpoint speaking real Streamable HTTP.
 *
 * The sequence under test is the acceptance criterion's own:
 *   author → dry-run (classification shown) → sync → second sync writes
 *   nothing.
 *
 * The stub answers `objects_list` / `objects_save` with the wire shapes the
 * real primitives produce; the SERVER-side half of the same criterion (the
 * gates those primitives run) is covered in `packages/objects` — the ingest
 * gates in `handlers-memory-sync-ingest.test.ts`, the preflight in
 * `handlers-memory-preflight.test.ts`, and the same author → dry-run → sync →
 * resync sequence driven through the REAL primitives with no stub endpoint at
 * all in `memory-sync-e2e.test.ts`.
 */
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BIN = path.join(fileURLToPath(new URL("..", import.meta.url)), "bin", "memory.mjs");
const tmp = mkdtempSync(path.join(os.tmpdir(), "memory-sync-cli-"));
const bundleDir = path.join(tmp, "repo", ".memory");

/** Rows the stub endpoint "stores", keyed by the envelope's externalId. */
const stored = new Map<string, Record<string, unknown>>();
/** Every tool call the stub saw, in order. */
const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

let server: Server;
let endpoint: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      if (body.method === "notifications/initialized") {
        res.writeHead(202).end();
        return;
      }
      let result: unknown = {};
      if (body.method === "tools/call") {
        const name = body.params.name as string;
        const args = body.params.arguments as Record<string, unknown>;
        toolCalls.push({ name, args });
        if (name === "objects_list") {
          const wanted = new Set((args.externalIds as string[]) ?? []);
          result = {
            structuredContent: {
              items: [...stored.values()].filter((row) =>
                wanted.has((row.data as Record<string, unknown>).externalId as string),
              ),
            },
          };
        } else if (name === "objects_save") {
          const data = args.rawData as Record<string, unknown>;
          const externalId = data.externalId as string;
          const existing = stored.get(externalId);
          stored.set(externalId, {
            id: `obj-${externalId.slice(0, 8)}`,
            type: "@cinatra-ai/memory:concept",
            data,
            ownerLevel: existing?.ownerLevel ?? args.ownerLevel ?? "user",
            ownerId: existing?.ownerId ?? "user-1",
            visibility: existing?.visibility ?? args.visibility ?? "private",
            projectId: existing?.projectId ?? args.projectId ?? null,
          });
          result = {
            structuredContent: {
              objectId: `obj-${externalId.slice(0, 8)}`,
              isNew: existing === undefined,
            },
          };
        }
      }
      res
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/mcp`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * Spawn the CLI ASYNCHRONOUSLY.
 *
 * `spawnSync` would block this process's event loop — and the stub MCP
 * endpoint runs on that same loop, so the child's first request would never be
 * answered and every run would time out. The async form keeps the loop free
 * while the child talks to the server.
 */
function run(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd: tmp,
      env: { ...process.env, NO_COLOR: "1", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (c: string) => (stdout += c));
    child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
    child.stdin.end();
    child.on("error", reject);
    child.on("close", (status) => resolve({ status: status ?? -1, stdout, stderr }));
  });
}

function callsSince(mark: number): string[] {
  return toolCalls.slice(mark).map((c) => c.name);
}

describe("memory sync end-to-end (real command runs)", () => {
  it("author: init and add two concepts", async () => {
    expect((await run(["init", "--dir", bundleDir, "--name", "sync e2e"])).status).toBe(0);
    expect(
      (
        await run([
          "add", "--dir", bundleDir,
          "--type", "Convention",
          "--title", "Use pnpm",
          "--body", "Always run pnpm, never npm.",
        ])
      ).status,
    ).toBe(0);
    expect(
      (
        await run([
          "add", "--dir", bundleDir,
          "--type", "Command",
          "--title", "Run the objects suite",
          "--body", "cd packages/objects && pnpm exec vitest run",
        ])
      ).status,
    ).toBe(0);
  });

  it("refuses to run with no endpoint configured", async () => {
    const result = await run(["sync", "--dir", bundleDir, "--dry-run"], {
      CINATRA_MCP_URL: "",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no MCP endpoint configured");
  });

  it("dry-run prints the classification and writes nothing", async () => {
    const mark = toolCalls.length;
    const result = await run(["sync", "--dir", bundleDir, "--dry-run", "--url", endpoint]);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^create\t/m);
    expect(result.stdout).toContain("dry-run: 2 create, 0 update, 0 skip, 0 blocked");
    // A preflight, and not one save.
    expect(callsSince(mark)).toEqual(["objects_list"]);
    expect(stored.size).toBe(0);
    expect(existsSync(path.join(bundleDir, "sync-ledger.json"))).toBe(false);
  });

  it("sync writes the rows and records the ledger", async () => {
    const mark = toolCalls.length;
    const result = await run(["sync", "--dir", bundleDir, "--url", endpoint]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("2 created, 0 updated, 0 skipped");
    expect(callsSince(mark)).toEqual(["objects_list", "objects_save", "objects_save"]);
    expect(stored.size).toBe(2);
    // Every save declared the exact static type, so the server resolves it
    // deterministically with no classifier LLM call.
    for (const call of toolCalls.slice(mark).filter((c) => c.name === "objects_save")) {
      expect(call.args.typeHint).toBe("@cinatra-ai/memory:concept");
    }
    const ledger = JSON.parse(
      readFileSync(path.join(bundleDir, "sync-ledger.json"), "utf8"),
    ) as { entries: Record<string, unknown> };
    expect(Object.keys(ledger.entries)).toHaveLength(2);
  });

  it("a second sync with no changes writes NOTHING (preflight-verified)", async () => {
    const mark = toolCalls.length;
    const result = await run(["sync", "--dir", bundleDir, "--url", endpoint]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("0 created, 0 updated, 2 skipped");
    // The preflight ran and confirmed the rows; not one save followed it.
    expect(callsSince(mark)).toEqual(["objects_list"]);
  });

  it("an edited concept syncs as an update, and only that one", async () => {
    const mark = toolCalls.length;
    const target = path.join(bundleDir, "convention", "use-pnpm.md");
    const source = readFileSync(target, "utf8");
    writeFileSync(target, `${source}\nCorollary: never yarn.\n`, "utf8");
    const result = await run(["sync", "--dir", bundleDir, "--url", endpoint]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("0 created, 1 updated, 1 skipped");
    expect(callsSince(mark)).toEqual(["objects_list", "objects_save"]);
  });

  it("a concept carrying a credential is blocked locally and exits non-zero", async () => {
    const mark = toolCalls.length;
    expect(
      (
        await run([
          "add", "--dir", bundleDir,
          "--type", "Debugging Insight",
          "--title", "Deploy notes",
          "--body", "The token is ghp_0123456789abcdefghijklmnopqrstuvwxyz",
        ])
      ).status,
    ).toBe(0);
    const result = await run(["sync", "--dir", bundleDir, "--url", endpoint]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("secret-detected");
    expect(result.stderr).toContain("github-pat");
    // The secret never reached the wire.
    expect(result.stderr).not.toContain("ghp_0123456789abcdefghijklmnopqrstuvwxyz");
    for (const call of toolCalls.slice(mark)) {
      expect(JSON.stringify(call.args)).not.toContain("ghp_0123456789");
    }
  });
});
