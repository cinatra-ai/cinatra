import "server-only";

// THE RUN FOLDER'S HOST FILE TOOLS (cinatra#3030, epic #3023 W6; plan (C) item
// 0.21).
//
//   "The folder is host-side and is never mounted into a sandbox: an agent
//    writes to it through host file tools on the passthrough (write, list,
//    read, confined to the run's folder) [...]"
//
// THREE TOOLS, ONE SCOPE. Every one of them takes its organisation and run from
// the run the REQUEST ITSELF PROVED (the passthrough's bridge-token binding),
// never from the request body — a tool that let a caller name the run would let
// a bridge-token holder read another run's staged files. The confinement,
// symlink refusal and both caps live in `./artifacts/run-folder`; this module is
// the thin, testable dispatch that maps a tool call onto them and turns every
// refusal into a stated, caller-visible error.
//
// Bytes cross as UTF-8 TEXT or base64: the passthrough carries JSON, and this
// slice's road stops short of pictures (W8 brings them). A caller that declares
// `encoding: "base64"` is writing bytes it already had; the folder stores them
// verbatim either way.

import {
  RunFolderRefusal,
  listRunOutputFiles,
  readRunOutputFile,
  writeRunOutputFile,
} from "./artifacts/run-folder";

/** The three tool names, on the passthrough allowlist by name and scope. */
export const RUN_FOLDER_WRITE_TOOL = "run_folder_write";
export const RUN_FOLDER_LIST_TOOL = "run_folder_list";
export const RUN_FOLDER_READ_TOOL = "run_folder_read";

export const RUN_FOLDER_TOOLS: ReadonlySet<string> = new Set([
  RUN_FOLDER_WRITE_TOOL,
  RUN_FOLDER_LIST_TOOL,
  RUN_FOLDER_READ_TOOL,
]);

export type RunFolderToolResult =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; reason: string; error: string };

function requirePath(raw: Record<string, unknown>): string {
  const value = raw.path;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new RunFolderRefusal(
      "invalid_path",
      `${"path"} must be a non-empty string relative to the run's outputs folder`,
    );
  }
  return value;
}

/** The bytes a write carries: UTF-8 `content`, or base64 when it says so. */
function requireBytes(raw: Record<string, unknown>): Uint8Array {
  const content = raw.content;
  if (typeof content !== "string") {
    throw new RunFolderRefusal(
      "invalid_path",
      `content must be a string (got ${Array.isArray(content) ? "array" : typeof content})`,
    );
  }
  const encoding = raw.encoding;
  if (encoding === "base64") {
    return new Uint8Array(Buffer.from(content, "base64"));
  }
  if (encoding !== undefined && encoding !== "utf8") {
    throw new RunFolderRefusal(
      "invalid_path",
      `encoding, when present, must be "utf8" or "base64" (got ${JSON.stringify(encoding)})`,
    );
  }
  return new TextEncoder().encode(content);
}

/**
 * Dispatch one run-folder file tool under the run the request PROVED.
 *
 * Never throws: every refusal comes back as a stated reason, which the route
 * turns into a visible non-2xx for the calling node.
 */
export async function dispatchRunFolderTool(input: {
  tool: string;
  /** The organisation and run the bridge token proved — never the body's. */
  orgId: string;
  runId: string;
  raw: Record<string, unknown>;
}): Promise<RunFolderToolResult> {
  try {
    switch (input.tool) {
      case RUN_FOLDER_WRITE_TOOL: {
        const written = await writeRunOutputFile({
          orgId: input.orgId,
          runId: input.runId,
          relPath: requirePath(input.raw),
          bytes: requireBytes(input.raw),
        });
        return { ok: true, result: { ...written } };
      }
      case RUN_FOLDER_LIST_TOOL: {
        const files = await listRunOutputFiles({ orgId: input.orgId, runId: input.runId });
        return {
          ok: true,
          // The ABSOLUTE path never leaves the host: a caller learns what it
          // wrote and how big it is, never where the folder lives.
          result: {
            files: files.map((file) => ({
              path: file.relPath,
              byteLength: file.byteLength,
            })),
          },
        };
      }
      case RUN_FOLDER_READ_TOOL: {
        const read = await readRunOutputFile({
          orgId: input.orgId,
          runId: input.runId,
          relPath: requirePath(input.raw),
        });
        const wantsBase64 = input.raw.encoding === "base64";
        return {
          ok: true,
          result: {
            path: read.relPath,
            byteLength: read.byteLength,
            encoding: wantsBase64 ? "base64" : "utf8",
            content: read.bytes.toString(wantsBase64 ? "base64" : "utf8"),
          },
        };
      }
      default:
        return {
          ok: false,
          reason: "unknown_tool",
          error: `"${input.tool}" is not a run-folder file tool`,
        };
    }
  } catch (err) {
    if (err instanceof RunFolderRefusal) {
      return { ok: false, reason: err.reason, error: err.message };
    }
    return {
      ok: false,
      reason: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
