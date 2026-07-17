/**
 * Thin docker-CLI seam (exec-plane S1, cinatra#1706).
 *
 * Every docker interaction in the local-dev worker goes through this argv-only
 * runner: no shell interpolation anywhere (a model-controlled command string is
 * only ever ONE argv element, `bash -c <command>`, inside the container). The
 * seam also gives unit tests a single injection point.
 */

import { execFile } from "node:child_process";

export type DockerRunOutcome = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** True when a stdio stream overflowed the caller's cap. */
  stdioOverflow: boolean;
  /** True when the process was terminated by the caller's timeout. */
  timedOut: boolean;
};

export type DockerCli = (
  args: string[],
  opts?: { timeoutMs?: number; maxBuffer?: number },
) => Promise<DockerRunOutcome>;

/** Real docker CLI runner. */
export const runDocker: DockerCli = (args, opts) =>
  new Promise((resolve) => {
    const child = execFile(
      "docker",
      args,
      {
        timeout: opts?.timeoutMs,
        maxBuffer: opts?.maxBuffer ?? 8 * 1024 * 1024,
        killSignal: "SIGKILL",
      },
      (error: (Error & { code?: unknown; killed?: boolean }) | null, stdout, stderr) => {
        if (!error) {
          resolve({ exitCode: 0, stdout, stderr, stdioOverflow: false, timedOut: false });
          return;
        }
        const stdioOverflow =
          typeof error.code === "string" &&
          error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
        const timedOut = Boolean(error.killed) && !stdioOverflow;
        resolve({
          exitCode: typeof error.code === "number" ? error.code : null,
          stdout: stdout ?? "",
          stderr: stderr ?? "",
          stdioOverflow,
          timedOut,
        });
      },
    );
    void child;
  });
