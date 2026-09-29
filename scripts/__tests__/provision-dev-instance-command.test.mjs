/**
 * THE COMMAND'S OWN ORDER OF OPERATIONS.
 *
 * One claim, and it is about WHEN rather than what: on an instance that must
 * not seat an administrator, the refusal happens before the secrets document is
 * read into this process and before a line about it is printed.
 *
 * The leg gates itself too — one gate per wrapper, and that stays — but the leg
 * is reached only after the command has drained stdin and logged which secrets
 * arrived. Nothing leaks either way; the difference is that a refused run
 * should not have handled the document at all.
 *
 * The stdin double here throws on ANY access, `isTTY` included. That is the
 * instrument: a test that merely asserted "the parser was not called" would
 * still pass if the stream had been drained.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "vitest";

import { runProvisionDevInstance } from "../provision-dev-instance.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME_ENV_KEYS = ["CINATRA_RUNTIME_MODE", "APP_RUNTIME_MODE"];

afterEach(() => {
  for (const key of RUNTIME_ENV_KEYS) delete process.env[key];
});

function declareRuntime(value) {
  for (const key of RUNTIME_ENV_KEYS) delete process.env[key];
  if (value !== undefined) process.env.CINATRA_RUNTIME_MODE = value;
}

/** A stream that fails the test the moment anything looks at it. */
function untouchableStdin() {
  const touched = [];
  const stream = new Proxy(
    {},
    {
      get(_target, property) {
        touched.push(String(property));
        throw new Error(`stdin was touched (${String(property)})`);
      },
    },
  );
  return { stream, touched };
}

function readableStdin(text) {
  return {
    isTTY: false,
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(text, "utf8");
    },
  };
}

function ports(overrides = {}) {
  const lines = [];
  const failures = [];
  const provisioned = [];
  return {
    lines,
    failures,
    provisioned,
    options: {
      argv: [],
      stdin: readableStdin(""),
      log: (line) => lines.push(line),
      fail: (line) => failures.push(line),
      provisionDevInstance: async (request) => {
        provisioned.push(request);
        return { wrote: true, notices: [], firstAdministrator: null };
      },
      ...overrides,
    },
  };
}

describe("the command refuses an administrator BEFORE it reads stdin", () => {
  for (const declared of [undefined, "staging", "developement"]) {
    it(`does not touch stdin when the runtime is ${declared ?? "undeclared"}`, async () => {
      declareRuntime(declared);
      const stdin = untouchableStdin();
      const p = ports({
        argv: ["--admin-email", "operator@example.test"],
        stdin: stdin.stream,
      });

      const exitCode = await runProvisionDevInstance(p.options);

      assert.notEqual(exitCode, 0);
      assert.deepEqual(stdin.touched, [], "the secrets document must never be read");
      // Nothing about the document was printed either — not even its shape.
      assert.equal(
        p.lines.some((line) => /secrets on stdin/i.test(line)),
        false,
      );
      assert.equal(p.provisioned.length, 0);
      assert.match(p.failures.join("\n"), /CINATRA_RUNTIME_MODE/);
    });
  }

  it("leaves a run that seats nobody exactly as it was", async () => {
    // The strict gate is the ACCOUNT leg's. A namespace-only run on an instance
    // that declares nothing must behave as it always has.
    declareRuntime(undefined);
    const p = ports({
      argv: ["--namespace", "acme-dev"],
      stdin: readableStdin(""),
    });

    const exitCode = await runProvisionDevInstance(p.options);

    assert.equal(exitCode, 0);
    assert.equal(
      p.lines.some((line) => /secrets on stdin/i.test(line)),
      true,
      "the ordinary run still reads and reports the document",
    );
    assert.equal(p.provisioned.length, 1);
  });

  it("reads the document as usual once the runtime is declared", async () => {
    declareRuntime("development");
    const p = ports({
      argv: ["--admin-email", "operator@example.test"],
      stdin: readableStdin(JSON.stringify({ adminPassword: "synthetic-password-9a" })),
    });

    const exitCode = await runProvisionDevInstance(p.options);

    assert.equal(exitCode, 0);
    assert.match(p.lines.join("\n"), /administrator password: supplied/);
    assert.equal(p.provisioned[0].firstAdministrator.email, "operator@example.test");
  });
});

describe("the command reports a failure as a non-zero exit rather than a throw", () => {
  it("turns a refusal from the provisioning call into exit 1", async () => {
    declareRuntime("development");
    const p = ports({
      argv: ["--namespace", "acme-dev"],
      provisionDevInstance: async () => {
        throw new Error("synthetic provisioning refusal");
      },
    });

    const exitCode = await runProvisionDevInstance(p.options);

    assert.equal(exitCode, 1);
    assert.match(p.failures.join("\n"), /synthetic provisioning refusal/);
  });

  it("carries the summary's exit code out of a completed run", async () => {
    declareRuntime("development");
    const p = ports({
      argv: ["--admin-email", "operator@example.test"],
      stdin: readableStdin(JSON.stringify({ adminPassword: "synthetic-password-9a" })),
      provisionDevInstance: async () => ({
        wrote: true,
        notices: [],
        // Created, never promoted: the one outcome that must not read as success.
        firstAdministrator: { written: true, alreadySeated: false, administrator: false },
      }),
    });

    const exitCode = await runProvisionDevInstance(p.options);

    assert.notEqual(exitCode, 0);
    assert.match(p.failures.join("\n"), /not an administrator/i);
  });
});

describe("importing the command does not run it", () => {
  it("left no exit code behind when this file imported it", () => {
    // The module is the command AND a module the suite drives. If its
    // entry-point guard were too loose, importing it above would have run the
    // real command against vitest's own argv and set an exit code here.
    assert.ok(
      process.exitCode === undefined || process.exitCode === 0,
      `importing the command set process.exitCode to ${String(process.exitCode)}`,
    );
    assert.ok(path.resolve(HERE, "..", "provision-dev-instance.mjs").endsWith(".mjs"));
  });
});
