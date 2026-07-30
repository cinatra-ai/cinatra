/**
 * The worker SERVICE's typed volume/container ops, on the wire (exec-plane L3).
 *
 * `volume-guard.test.ts` proves the policy in isolation. This file proves the
 * worker actually APPLIES it at the boundary — that a refused name never
 * reaches a docker argv, that a refusal is answered as `malformed_request`
 * (an argument that can never become legal, not a transient op failure), and
 * that the legal path still does exactly what it did before.
 */

import { describe, expect, it } from "vitest";

import type { DockerCli, DockerRunOutcome } from "../../docker-cli";
import { SANDBOX_CONTAINER_JOB_LABEL } from "../../l0-profile";
import { WORKSPACE_LABEL } from "../../workspace";
import { createInMemoryCommandLedger } from "../command-ledger";
import { EXEC_ERROR_STATUS, WORKER_OPS, execRequestEnvelope } from "../protocol";
import { createWorkerDispatch } from "../worker-server";

const CTX = { peerUri: "cinatra-exec://test/broker-client" };

/**
 * @param labels what `volume inspect` reports. `"absent"` makes the inspect
 *        fail, which is what docker does for a volume that does not exist —
 *        the normal case for a CREATE.
 */
function harness(
  labels: Record<string, string> | null | "absent" = "absent",
) {
  const seen: string[][] = [];
  const docker: DockerCli = async (args): Promise<DockerRunOutcome> => {
    seen.push([...args]);
    const isInspect = args[0] === "volume" && args[1] === "inspect";
    if (isInspect && labels === "absent") {
      return {
        exitCode: 1,
        stdout: "",
        stderr: "no such volume",
        stdioOverflow: false,
        timedOut: false,
      };
    }
    const stdout = isInspect
      ? JSON.stringify(labels)
      : args[0] === "volume" && args[1] === "create"
        ? args[args.length - 1]
        : "";
    return { exitCode: 0, stdout, stderr: "", stdioOverflow: false, timedOut: false };
  };
  const dispatch = createWorkerDispatch({
    worker: { runCommand: async () => { throw new Error("unused"); } },
    docker,
    instance: "test",
    serviceToken: "token",
    // `createWorkerDispatch` builds only the dispatcher — nothing listens here,
    // so the TLS material is never used. The real handshake is exercised in
    // service-loopback.test.ts against a real PKI.
    tls: { certPem: "", keyPem: "", caPem: "" },
    ledger: createInMemoryCommandLedger(),
  });
  return { dispatch, seen };
}

describe("worker service — the typed ops are wired", () => {
  it("declares the drain op in the wire vocabulary", () => {
    expect(WORKER_OPS).toContain("cancelJobContainers");
  });

  it("ensureWorkspace creates the volume for a legal key", async () => {
    const { dispatch, seen } = harness();
    const reply = await dispatch(
      execRequestEnvelope("ensureWorkspace", { workspaceKey: "run-1" }),
      CTX,
    );
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ ok: true, result: { volumeName: "cinatra-exec-l2-run-1" } });
    // Ownership is checked BEFORE the create, because `volume create` ADOPTS an
    // existing name rather than failing.
    expect(seen.map((argv) => argv.slice(0, 2))).toEqual([
      ["volume", "inspect"],
      ["volume", "create"],
    ]);
  });

  it("ensureWorkspace REFUSES to adopt a foreign volume squatting the name", async () => {
    const { dispatch, seen } = harness({ "com.example": "someone-else" });
    const reply = await dispatch(
      execRequestEnvelope("ensureWorkspace", { workspaceKey: "run-1" }),
      CTX,
    );
    expect(reply.status).toBe(EXEC_ERROR_STATUS.malformed_request);
    expect(seen.some((argv) => argv[1] === "create")).toBe(false);
  });

  it("stageSkills REFUSES to write into a foreign volume squatting the name", async () => {
    const { dispatch, seen } = harness({ "com.example": "someone-else" });
    const reply = await dispatch(
      execRequestEnvelope("stageSkills", { jobId: "job-1", skills: [], imageRef: "l0:dev" }),
      CTX,
    );
    // Staging COPIES files in and force-removes the volume on failure, so
    // adopting a foreign one would both write to it and delete it.
    expect(reply.status).toBe(EXEC_ERROR_STATUS.malformed_request);
    expect(seen.some((argv) => argv[1] === "create")).toBe(false);
  });

  it("removeWorkspace checks the LABEL before removing", async () => {
    const { dispatch, seen } = harness({ [WORKSPACE_LABEL]: "l2" });
    const reply = await dispatch(
      execRequestEnvelope("removeWorkspace", { volumeName: "cinatra-exec-l2-run-1" }),
      CTX,
    );
    expect(reply.status).toBe(200);
    expect(seen.map((argv) => argv.slice(0, 2))).toEqual([
      ["volume", "inspect"],
      ["volume", "rm"],
    ]);
  });

  it("removeWorkspace REFUSES a volume the execution plane did not label", async () => {
    const { dispatch, seen } = harness({ "com.example": "other" });
    const reply = await dispatch(
      execRequestEnvelope("removeWorkspace", { volumeName: "cinatra-exec-l2-run-1" }),
      CTX,
    );
    expect(reply.status).toBe(EXEC_ERROR_STATUS.malformed_request);
    expect(seen.some((argv) => argv[1] === "rm")).toBe(false);
  });

  it("removeSkills refuses an L2 name presented under the skills op", async () => {
    const { dispatch, seen } = harness();
    const reply = await dispatch(
      execRequestEnvelope("removeSkills", { volumeName: "cinatra-exec-l2-run-1" }),
      CTX,
    );
    expect(reply.status).toBe(EXEC_ERROR_STATUS.malformed_request);
    expect(seen).toEqual([]);
  });

  const hostileNames = [
    "postgres-data",
    "/var/lib/docker",
    "--privileged",
    "cinatra-exec-l2-",
    "cinatra-exec-l2-../../etc",
  ];

  for (const volumeName of hostileNames) {
    it(`removeWorkspace refuses "${volumeName}" WITHOUT touching docker`, async () => {
      const { dispatch, seen } = harness();
      const reply = await dispatch(
        execRequestEnvelope("removeWorkspace", { volumeName }),
        CTX,
      );
      // Either the protocol parser or the name guard refuses it; both answer
      // `malformed_request`, and neither reaches an argv.
      expect(reply.status).toBe(EXEC_ERROR_STATUS.malformed_request);
      expect(seen).toEqual([]);
    });
  }

  it("cancelJobContainers takes a JOB ID and selects on the ownership label", async () => {
    const { dispatch, seen } = harness();
    const reply = await dispatch(
      execRequestEnvelope("cancelJobContainers", { jobId: "job-9" }),
      CTX,
    );
    expect(reply.status).toBe(200);
    expect(reply.body).toMatchObject({ ok: true, result: { cancelled: [] } });
    // A NAME is not proof that this worker started the container; the label the
    // hardened run profile stamps is.
    expect(seen[0]).toEqual([
      "ps",
      "--all",
      "--filter",
      `label=${SANDBOX_CONTAINER_JOB_LABEL}=job-9`,
      "--format",
      "{{.Names}}",
    ]);
  });

  it("cancelJobContainers refuses an empty job id before any docker call", async () => {
    const { dispatch, seen } = harness();
    const reply = await dispatch(
      execRequestEnvelope("cancelJobContainers", { jobId: "" }),
      CTX,
    );
    expect(reply.status).toBe(EXEC_ERROR_STATUS.malformed_request);
    expect(seen).toEqual([]);
  });

  it("a refusal answers malformed_request, never op_failed", async () => {
    const { dispatch } = harness();
    const reply = await dispatch(
      execRequestEnvelope("removeWorkspace", { volumeName: "postgres-data" }),
      CTX,
    );
    // `op_failed` would invite a retry of an argument that can never be legal.
    expect(reply.status).not.toBe(EXEC_ERROR_STATUS.op_failed);
    expect(reply.body).toMatchObject({ ok: false, error: { code: "malformed_request" } });
  });
});
