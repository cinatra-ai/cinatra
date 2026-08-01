/**
 * A REAL broker service in a REAL child process, over REAL mTLS, holding a REAL
 * file-backed audit spool on a REAL directory (cinatra#2266 AC8, slice 3).
 *
 * WHY THIS FILE EXISTS AT ALL. The kill-broker arm's remaining half —
 * "exactly one kernel row per delivery key" — needs the two ends joined: a
 * broker that can be SIGKILLed while holding un-acknowledged records, and an
 * app that writes those records into a real authorization kernel. Neither end
 * can move to the other:
 *
 *   * The KERNEL end cannot come into this package. `@cinatra-ai/execution-plane`
 *     does not depend on the app, and inverting that to reach
 *     `src/lib/authz/audit.ts` would be a dependency cycle the workspace gates
 *     refuse — correctly, since the broker is the process that must NOT hold the
 *     app's database.
 *   * The BROKER end cannot be composed in-process by the app-side test. A
 *     SIGKILL is the whole point of the arm, and a test cannot SIGKILL itself
 *     and then go on to assert anything.
 *
 * So the broker runs HERE, as a child process the app-side test spawns and
 * kills, and the two talk over the same mTLS wire a deployed app uses. The
 * app-side arm (`src/lib/execution/__tests__/integration/`) spawns this script,
 * drains it with a real `BrokerServiceClient`, kills it, restarts it against the
 * SAME spool directory, and writes both deliveries through the real strict
 * kernel path into a real Postgres.
 *
 * WHAT IS REAL HERE, AND WHAT IS A DOUBLE — stated so no reader has to infer it:
 *
 *   REAL: the file spool (`openAuditSpool`) and its fsyncs; the relay
 *   (`createAuditRelay`) with its reservation/commit/admission seams; the
 *   `ExecutionBroker` itself, including the pre-dispatch reservation; the wire
 *   server (`createBrokerService`) and its mTLS peer check; the sealed
 *   execution-session carrier; the process, and therefore the SIGKILL.
 *
 *   DOUBLE: the `SandboxWorker` (returns a canned result instead of running a
 *   container) and the voucher verifier (accepts). Both are deliberate and
 *   neither is on the path under test — this arm is about the DURABILITY and
 *   IDENTITY of audit records across a crash, not about sandbox isolation, which
 *   the container battery in `service-boundary.e2e.test.ts` covers with real
 *   containers and real commands. Using real containers here would add a docker
 *   dependency and minutes of runtime to an arm that would assert nothing more.
 *
 * THE PKI IS MINTED ONCE AND REUSED ACROSS RESTARTS, which is what makes the
 * restart a restart: a fresh CA on the second boot would present the app with a
 * different identity and the arm would be testing a redeploy, not a crash.
 *
 * Usage (all paths absolute):
 *   node kill-broker-harness.ts <spoolDir> <pkiDir> <port>
 *
 * On success it prints one line — `READY <port> <spoolId>` — and then stays
 * alive until it is killed. Any failure exits non-zero with the reason on
 * stderr, so a parent never mistakes a dead harness for an empty spool.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import { ExecutionBroker } from "../../../broker.ts";
import { openAuditSpool } from "../../../service/audit-spool.ts";
import { createAuditRelay, createBrokerService } from "../../../service/broker-server.ts";
import type { ExecTlsMaterial } from "../../../service/mtls.ts";
import {
  DEFAULT_SANDBOX_LIMITS,
  type SandboxCommandResult,
  type SandboxWorker,
} from "../../../types.ts";
import { createThrowawayCa, issueExecLeaf, type ExecCertificateAuthority } from "./throwaway-pki.ts";

/** Fixed so the parent can mint the same carrier shape; not a secret. */
export const HARNESS_INSTANCE = "kill-arm-inst";
export const HARNESS_SERVICE_TOKEN = "kill-arm-service-token-cccccccccccccccc";
export const HARNESS_CARRIER_SECRET = "kill-arm-carrier-secret-dddddddddddddddd";
export const HARNESS_ORG = "org-kill-arm";
export const HARNESS_USER = "user-kill-arm";

const RESULT: SandboxCommandResult = {
  exitCode: 0,
  stdout: "kill-arm\n",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  termination: "exited",
  wallMs: 7,
  imageDigest: "sha256:deadbeef",
  workspaceKb: 4,
};

/**
 * The PKI, minted on first boot and READ on every later one.
 *
 * The app's client leaf is written out too, because the parent needs a
 * credential this server will actually admit and has no other way to get one —
 * `mtls.ts` authorizes an exact `cinatra-exec://<instance>/app-client` URI SAN
 * under this CA, so the parent cannot mint its own.
 */
export type HarnessPki = {
  brokerServer: ExecTlsMaterial;
  appClient: ExecTlsMaterial;
};

export function loadOrMintPki(pkiDir: string): HarnessPki {
  const files = {
    caPem: path.join(pkiDir, "ca.pem"),
    serverCert: path.join(pkiDir, "broker-server.cert.pem"),
    serverKey: path.join(pkiDir, "broker-server.key.pem"),
    clientCert: path.join(pkiDir, "app-client.cert.pem"),
    clientKey: path.join(pkiDir, "app-client.key.pem"),
  };
  if (!existsSync(files.caPem)) {
    mkdirSync(pkiDir, { recursive: true });
    const ca: ExecCertificateAuthority = createThrowawayCa("cinatra-exec kill-arm ca");
    const server = issueExecLeaf(ca, HARNESS_INSTANCE, "broker-server");
    const client = issueExecLeaf(ca, HARNESS_INSTANCE, "app-client");
    writeFileSync(files.caPem, ca.certPem);
    writeFileSync(files.serverCert, server.certPem);
    writeFileSync(files.serverKey, server.keyPem);
    writeFileSync(files.clientCert, client.certPem);
    writeFileSync(files.clientKey, client.keyPem);
  }
  const caPem = readFileSync(files.caPem, "utf8");
  return {
    brokerServer: {
      certPem: readFileSync(files.serverCert, "utf8"),
      keyPem: readFileSync(files.serverKey, "utf8"),
      caPem,
    },
    appClient: {
      certPem: readFileSync(files.clientCert, "utf8"),
      keyPem: readFileSync(files.clientKey, "utf8"),
      caPem,
    },
  };
}

function cannedWorker(): SandboxWorker {
  return {
    async runCommand(): Promise<SandboxCommandResult> {
      return RESULT;
    },
  };
}

async function main(): Promise<void> {
  const [, , spoolDir, pkiDir, portText] = process.argv;
  if (!spoolDir || !pkiDir || !portText) {
    throw new Error("usage: kill-broker-harness.ts <spoolDir> <pkiDir> <port>");
  }
  const port = Number.parseInt(portText, 10);

  // The carrier secret must be in the environment BEFORE a carrier is opened.
  process.env.EXECUTION_BROKER_SECRET = HARNESS_CARRIER_SECRET;

  const pki = loadOrMintPki(pkiDir);
  mkdirSync(spoolDir, { recursive: true });

  // THE REAL SPOOL on a real directory. A restart opens the SAME one, which is
  // what carries the un-acknowledged records across the kill.
  const spool = openAuditSpool({ dir: spoolDir });
  const relay = createAuditRelay({ spool });

  let commandId = 0;
  const broker = new ExecutionBroker({
    worker: cannedWorker(),
    auditSink: relay.auditSink,
    auditReserver: relay.auditReserver,
    auditAdmission: relay.auditAdmission,
    livenessProbe: async () => "alive",
    voucherVerifier: {
      verify: () => ({
        ok: true as const,
        claims: {
          commandId: `kill-arm-cmd-${(commandId += 1)}`,
          egressPolicy: { mode: "none" as const },
        },
      }),
      checkFreshness: () => ({ ok: true as const }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    egressPolicyResolver: () => ({ mode: "none" }),
    limits: DEFAULT_SANDBOX_LIMITS,
    volumeOps: {
      ensureWorkspace: async (key: string) => `vol-${key}`,
      removeWorkspace: async () => {},
      stageSkills: async () => "skills-vol",
      removeSkills: async () => {},
    },
  });

  const service = createBrokerService({
    broker,
    instance: HARNESS_INSTANCE,
    serviceToken: HARNESS_SERVICE_TOKEN,
    tls: pki.brokerServer,
    relay,
  });

  await new Promise<void>((resolve, reject) => {
    service.server.once("error", reject);
    service.server.listen(port, "127.0.0.1", () => resolve());
  });

  // The parent waits for this line. It carries the spool identity so the parent
  // can assert the restart came back on the SAME volume rather than a fresh one.
  process.stdout.write(`READY ${port} ${spool.spoolId}\n`);

  // Stay alive until killed. No shutdown hook is registered ON PURPOSE: a
  // SIGKILL would not run one anyway, and having one would invite the reader to
  // believe the durability came from a graceful flush.
  await new Promise<never>(() => {});
}

main().catch((err: unknown) => {
  process.stderr.write(
    `kill-broker-harness failed: ${err instanceof Error ? err.stack : String(err)}\n`,
  );
  process.exit(1);
});
