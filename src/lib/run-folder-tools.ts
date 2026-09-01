import "server-only";

// THE PASSTHROUGH'S RUN-FOLDER FILE TOOLS (cinatra#3030, epic #3023 W6; plan (C)
// item 0.21, technical notes §8.4 and §8.7).
//
//   item 0.21: "an agent writes to it through host file tools on the passthrough
//   (write, list, read, confined to the run's folder), and a sandbox publishes a
//   file from its own workspace into the folder through one tool that copies it
//   across the broker".
//
//   §8.4: "The passthrough allowlist grows by these names, each scoped: the file
//   tools (write, list, read) to the run's folder [...]"
//
// THE SCOPE IS THE RUN, AND THE RUN COMES FROM THE ROUTE, NEVER FROM THE BODY.
// The route has already bound the body's `agent_run_id` to the run actually
// executing the callback (`bindBridgeRunId`), so the organisation and the run of
// the folder are the proven ones. A path that leaves the folder, or a link, is
// refused by the folder itself — this module never widens what it is handed.
//
// A sibling of `@/lib/extension-scoped-tools` in shape and posture: admitted by
// name and by scope, never by wildcard.

import {
  RunFolderRefusal,
  listRunOutputFiles,
  readRunOutputFile,
  writeRunOutputFile,
} from "@/lib/artifacts/run-folder";

/** The names W6 adds to the passthrough allowlist, each scoped to the run. */
export const RUN_FOLDER_TOOLS = new Set<string>([
  "run_file_write",
  "run_file_list",
  "run_file_read",
]);

export type RunFolderToolRun = {
  id: string;
  orgId: string;
};

export type RunFolderToolOutcome =
  | { ok: true; result: unknown }
  | { ok: false; status: number; error: string };

/** The read cap of `run_file_read`. A tool answer travels through a flow's
 *  variables, so it is bounded well below the folder's own per-file cap. */
export const RUN_FILE_READ_MAX_BYTES = 1024 * 1024;

function requireString(raw: Record<string, unknown>, field: string): string {
  const value = raw[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RunFolderRefusal(
      "invalid_path",
      `${field} must be a non-empty string`,
    );
  }
  return value.trim();
}

/**
 * Dispatch one run-folder file tool under the run's own scope. Never throws:
 * every refusal is a stated status the calling node fails visibly on.
 */
export async function dispatchRunFolderTool(input: {
  tool: string;
  input: Record<string, unknown>;
  run: RunFolderToolRun;
}): Promise<RunFolderToolOutcome> {
  const scope = { orgId: input.run.orgId, runId: input.run.id };
  try {
    if (input.tool === "run_file_list") {
      const files = await listRunOutputFiles(scope);
      // The absolute path is host-side and never leaves this module.
      return {
        ok: true,
        result: {
          files: files.map((f) => ({ path: f.relPath, byteLength: f.byteLength })),
        },
      };
    }
    if (input.tool === "run_file_write") {
      const relPath = requireString(input.input, "path");
      const content = input.input.content;
      if (typeof content !== "string") {
        return {
          ok: false,
          status: 400,
          error: "run_file_write: `content` must be a string",
        };
      }
      const encoding = input.input.encoding === "base64" ? "base64" : "utf8";
      const bytes = new Uint8Array(Buffer.from(content, encoding));
      const written = await writeRunOutputFile({ ...scope, relPath, bytes });
      return {
        ok: true,
        result: {
          path: written.relPath,
          byteLength: written.byteLength,
          sha256: written.sha256,
        },
      };
    }
    if (input.tool === "run_file_read") {
      const relPath = requireString(input.input, "path");
      const encoding = input.input.encoding === "base64" ? "base64" : "utf8";
      const read = await readRunOutputFile({
        ...scope,
        relPath,
        maxBytes: RUN_FILE_READ_MAX_BYTES,
      });
      return {
        ok: true,
        result: {
          path: read.relPath,
          byteLength: read.byteLength,
          encoding,
          content: read.bytes.toString(encoding),
        },
      };
    }
    return { ok: false, status: 400, error: `${input.tool} is not a run-folder file tool` };
  } catch (e) {
    if (e instanceof RunFolderRefusal) {
      return {
        ok: false,
        status: e.reason === "not_found" ? 404 : e.reason === "file_cap" || e.reason === "run_cap" ? 413 : 403,
        error: e.message,
      };
    }
    return { ok: false, status: 500, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * THE SANDBOX PUBLISH, host side (item 0.21: "a sandbox publishes a file from
 * its own workspace into the folder through one tool that copies it across the
 * broker"). The BYTES arrive from the broker's copy — the folder is never
 * mounted into a sandbox and the execution plane's no-host-data rule is
 * untouched — and this is where they land in the run's outputs folder, under the
 * same confinement and the same caps every other write takes.
 */
export async function publishSandboxFileToRunFolder(input: {
  orgId: string;
  runId: string;
  relPath: string;
  bytes: Uint8Array;
}): Promise<{ path: string; byteLength: number; sha256: string }> {
  const written = await writeRunOutputFile({
    orgId: input.orgId,
    runId: input.runId,
    relPath: input.relPath,
    bytes: input.bytes,
  });
  return { path: written.relPath, byteLength: written.byteLength, sha256: written.sha256 };
}
