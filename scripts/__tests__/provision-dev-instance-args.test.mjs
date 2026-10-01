/**
 * SECRET TRAVEL, PROVED AT THE ONLY PLACE A SECRET COULD LEAK OUT OF THE
 * COMMAND'S INTERFACE: its argument surface.
 *
 * The rule the command records in its own header is that every secret value
 * reaches the process over stdin (or an equivalent in-process channel) — never
 * as a command-line argument, never through an environment file written to
 * disk, never logged. The three claims below are the mechanical form of it:
 *
 *   - the argument parser has NO flag that could carry a secret, and REFUSES
 *     one rather than quietly ignoring it (a silently-ignored `--api-key` is
 *     still a key in the shell history and in `ps`);
 *   - the stdin payload is where the secrets come from, and it parses;
 *   - the redaction helper the command logs through never emits a value.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

import { pathToFileURL } from "node:url";

import {
  PROVISION_VALUE_FLAGS,
  SECRET_FLAG_PATTERN,
  SECRET_TRAVEL_RULE,
  SecretInArgumentsError,
  parseProvisionInstanceArgs,
  parseProvisionSecretsPayload,
  isCommandEntryPoint,
  summarizeRunForExit,
  summarizeSecretsForLog,
} from "../lib/provision-dev-instance-args.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");

describe("parseProvisionInstanceArgs", () => {
  it("accepts the non-secret arguments the command documents", () => {
    const parsed = parseProvisionInstanceArgs([
      "--namespace",
      "acme-dev",
      "--display-name",
      "Acme Development",
      "--public-origin",
      "https://origin.example",
      "--provider",
      "anthropic",
      "--admin-email",
      "operator@example.test",
      "--admin-name",
      "The Operator",
    ]);
    assert.equal(parsed.namespace, "acme-dev");
    assert.equal(parsed.displayName, "Acme Development");
    assert.equal(parsed.publicOrigin, "https://origin.example");
    assert.equal(parsed.provider, "anthropic");
    // An address is not a secret, and neither is a display name.
    assert.equal(parsed.adminEmail, "operator@example.test");
    assert.equal(parsed.adminName, "The Operator");
  });

  it("has no secret-bearing flag at all, and REFUSES one", () => {
    for (const flag of [
      "--api-key",
      "--apikey",
      "--secret",
      "--secret-key",
      "--token",
      "--password",
      "--credential",
      // The first administrator's password has no flag either — the address
      // beside it does, and that is the whole distinction.
      "--admin-password",
      "--administrator-password",
      "--admin-secret",
      "--admin-token",
      "--admin-key",
      "--admin-credential",
      "--admin-passphrase",
    ]) {
      assert.throws(
        () => parseProvisionInstanceArgs(["--namespace", "acme-dev", flag, "not-a-real-value"]),
        SecretInArgumentsError,
        `${flag} must be refused, not ignored`,
      );
    }
  });

  it("has no value-bearing flag whose NAME could be read as a secret", () => {
    // The list above is examples; this is the invariant behind them. A flag
    // added later whose name trips the refusal pattern would be BOTH accepted
    // (it is a known flag) and secret-looking — the exact shape this command's
    // whole argument surface exists to make impossible.
    for (const flag of PROVISION_VALUE_FLAGS) {
      assert.equal(
        SECRET_FLAG_PATTERN.test(flag),
        false,
        `"${flag}" is an accepted flag whose name reads as a secret`,
      );
    }
    assert.ok(PROVISION_VALUE_FLAGS.length > 0);
  });

  it("refuses an unknown flag rather than dropping it", () => {
    assert.throws(() => parseProvisionInstanceArgs(["--nope", "x"]), /unknown argument/i);
  });

  it("refuses a provider it cannot provision", () => {
    assert.throws(
      () => parseProvisionInstanceArgs(["--provider", "not-a-provider"]),
      /provider/i,
    );
  });

  it("never echoes an ARGUMENT VALUE in a refusal — the command prints these messages", () => {
    // A pasted credential can land in any of these positions. The refusal is
    // printed to the terminal, so the message may name the FLAG and never the
    // value beside it.
    const sentinel = "synthetic-pasted-value-9d41";
    const refusals = [
      ["--api-key", sentinel],
      [`--api-key=${sentinel}`],
      ["--secret-key", sentinel],
      ["--admin-password", sentinel],
      [`--admin-password=${sentinel}`],
      [sentinel],
      ["--namespace", "acme-dev", sentinel],
      ["--provider", sentinel],
      ["--nope", sentinel],
      [`--nope=${sentinel}`],
    ];
    for (const argv of refusals) {
      let thrown = null;
      try {
        parseProvisionInstanceArgs(argv);
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown, `${argv.join(" ")} must be refused`);
      assert.equal(
        String(thrown.message).includes(sentinel),
        false,
        `the refusal for "${argv[0]}" must not echo the value`,
      );
    }
  });

  it("drops a bare `--` in the FIRST position, where a package manager puts it", () => {
    // `pnpm provision:dev-instance -- --namespace acme-dev` is the invocation
    // the workflow page documents, and the pinned package manager forwards the
    // separator to the script verbatim. The parse must come out identical to
    // the same arguments typed without it.
    const withSeparator = parseProvisionInstanceArgs([
      "--",
      "--namespace",
      "acme-dev",
      "--admin-email",
      "operator@example.test",
    ]);
    const without = parseProvisionInstanceArgs([
      "--namespace",
      "acme-dev",
      "--admin-email",
      "operator@example.test",
    ]);
    assert.deepEqual(withSeparator, without);
    assert.equal(withSeparator.namespace, "acme-dev");
    assert.equal(withSeparator.adminEmail, "operator@example.test");
  });

  it("reads a lone `--` as no arguments at all", () => {
    assert.deepEqual(parseProvisionInstanceArgs(["--"]), parseProvisionInstanceArgs([]));
  });

  it("refuses a `--` anywhere but the first position", () => {
    // Only a LEADING separator is the package manager's. A second one is
    // something the operator typed, and an unknown argument stays refused.
    assert.throws(
      () => parseProvisionInstanceArgs(["--namespace", "acme-dev", "--"]),
      /unknown argument/i,
    );
    assert.throws(() => parseProvisionInstanceArgs(["--", "--"]), /unknown argument/i);
  });

  it("still refuses a secret-bearing flag behind a leading separator", () => {
    // The separator must not become a way past the one property this surface
    // exists to hold.
    for (const flag of ["--admin-password", "--api-key", "--secret-key"]) {
      assert.throws(
        () => parseProvisionInstanceArgs(["--", flag, "not-a-real-value"]),
        SecretInArgumentsError,
        `${flag} must be refused behind a leading separator too`,
      );
    }
  });

  it("leaves a `--` standing in a VALUE position exactly as it was", () => {
    // `--` is dropped as a leading token only. In a value position it is the
    // flag's value, before this change and after it.
    assert.equal(parseProvisionInstanceArgs(["--namespace", "--"]).namespace, "--");
    assert.equal(parseProvisionInstanceArgs(["--namespace=--"]).namespace, "--");
    assert.equal(parseProvisionInstanceArgs(["--", "--namespace", "--"]).namespace, "--");
  });
});

describe("parseProvisionSecretsPayload", () => {
  it("reads the secrets from a stdin JSON document", () => {
    const payload = parseProvisionSecretsPayload(
      JSON.stringify({
        providerApiKey: "synthetic-provider-value",
        connectorServiceSecretKey: "synthetic-connector-value",
        connectorServiceUrl: "http://127.0.0.1:3003",
        adminPassword: "synthetic-administrator-value",
      }),
    );
    assert.equal(payload.providerApiKey, "synthetic-provider-value");
    assert.equal(payload.connectorServiceSecretKey, "synthetic-connector-value");
    assert.equal(payload.connectorServiceUrl, "http://127.0.0.1:3003");
    assert.equal(payload.adminPassword, "synthetic-administrator-value");
  });

  it("stores the administrator password EXACTLY as given, whitespace and all", () => {
    // A password is bytes. Trimming one stores a different secret than the
    // operator typed, and the account then refuses the password they wrote
    // down — with nothing anywhere to say why.
    const padded = "  synthetic pass phrase  ";
    const payload = parseProvisionSecretsPayload(
      JSON.stringify({ adminPassword: padded, connectorServiceUrl: "  http://127.0.0.1:3003  " }),
    );
    assert.equal(payload.adminPassword, padded);
    // Everything else still trims: those are names, not secrets by shape.
    assert.equal(payload.connectorServiceUrl, "http://127.0.0.1:3003");
  });

  it("refuses a whitespace-only or empty administrator password instead of calling it absent", () => {
    for (const value of ["", "   ", "\t\n "]) {
      let thrown = null;
      try {
        parseProvisionSecretsPayload(JSON.stringify({ adminPassword: value }));
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown, `${JSON.stringify(value)} must be refused`);
      assert.match(String(thrown.message), /adminPassword/);
      // "absent" would send the operator hunting for a key that is present.
      assert.equal(/absent/i.test(String(thrown.message)), false);
    }
  });

  it("never echoes the administrator password in that refusal", () => {
    // A non-blank value is accepted, so the refusal path is driven with a value
    // that is whitespace around a sentinel the message must not carry.
    let thrown = null;
    try {
      parseProvisionSecretsPayload(JSON.stringify({ adminPassword: "   " }));
    } catch (error) {
      thrown = error;
    }
    assert.equal(String(thrown.message).includes("   "), false);
  });

  it("treats an empty stdin as no secrets rather than as a parse error", () => {
    const payload = parseProvisionSecretsPayload("   \n");
    assert.equal(payload.providerApiKey, undefined);
    assert.equal(payload.connectorServiceSecretKey, undefined);
  });

  it("refuses a payload that is not a JSON object", () => {
    assert.throws(() => parseProvisionSecretsPayload("[1,2,3]"), /object/i);
    assert.throws(() => parseProvisionSecretsPayload("{oops"), /could not be read/i);
  });

  it("refuses an unknown key so a typo never silently drops a secret", () => {
    assert.throws(
      () => parseProvisionSecretsPayload(JSON.stringify({ providerApikey: "x" })),
      /unknown/i,
    );
  });
});

describe("summarizeSecretsForLog", () => {
  it("reports PRESENCE only — never a character of a value", () => {
    const summary = summarizeSecretsForLog({
      providerApiKey: "synthetic-provider-value",
      connectorServiceSecretKey: "synthetic-connector-value",
      adminPassword: "synthetic-administrator-value",
    });
    assert.equal(summary.includes("synthetic-provider-value"), false);
    assert.equal(summary.includes("synthetic-connector-value"), false);
    assert.equal(summary.includes("synthetic-administrator-value"), false);
    assert.match(summary, /provider api key: supplied/i);
    assert.match(summary, /connector-service secret: supplied/i);
    assert.match(summary, /administrator password: supplied/i);
    assert.match(summarizeSecretsForLog({}), /provider api key: absent/i);
    assert.match(summarizeSecretsForLog({}), /administrator password: absent/i);
  });
});

describe("summarizeRunForExit", () => {
  it("reports a provisioned instance as a success", () => {
    const { line, exitCode } = summarizeRunForExit({ wrote: true, firstAdministrator: null });
    assert.equal(exitCode, 0);
    assert.match(line, /provisioned/i);
  });

  it("reports an untouched instance as a success", () => {
    const { line, exitCode } = summarizeRunForExit({ wrote: false, firstAdministrator: null });
    assert.equal(exitCode, 0);
    assert.match(line, /nothing to do/i);
  });

  it("reports a SEATED administrator as a success", () => {
    const { line, exitCode } = summarizeRunForExit({
      wrote: true,
      firstAdministrator: { written: true, alreadySeated: false, administrator: true },
    });
    assert.equal(exitCode, 0);
    assert.equal(/not an administrator/i.test(line), false);
  });

  it("an instance that already had one is still a success", () => {
    const { exitCode } = summarizeRunForExit({
      wrote: false,
      firstAdministrator: { written: false, alreadySeated: true, administrator: false },
    });
    assert.equal(exitCode, 0);
  });

  it("FAILS when the account was created but never promoted", () => {
    // An unattended caller reads the exit code. "done — the instance was
    // provisioned" over an account with no administrator rights is the one
    // outcome that must never look like success.
    const { line, exitCode } = summarizeRunForExit({
      wrote: true,
      firstAdministrator: { written: true, alreadySeated: false, administrator: false },
    });
    assert.notEqual(exitCode, 0);
    assert.match(line, /not an administrator/i);
    assert.equal(/^.*the instance was provisioned\.$/.test(line), false);
  });
});

describe("isCommandEntryPoint", () => {
  const COMMAND = path.join(ROOT, "scripts/provision-dev-instance.mjs");
  const COMMAND_URL = pathToFileURL(COMMAND).href;

  it("says yes for the command's own file, however the path was spelled", () => {
    assert.equal(isCommandEntryPoint(COMMAND, COMMAND_URL), true);
    // The way a package script spells it: relative to the repository root.
    const relative = path.relative(process.cwd(), COMMAND);
    assert.equal(isCommandEntryPoint(relative, COMMAND_URL), true);
    // And with a redundant segment in the middle.
    assert.equal(
      isCommandEntryPoint(path.join(ROOT, "scripts", "..", "scripts", "provision-dev-instance.mjs"), COMMAND_URL),
      true,
    );
  });

  it("says no for anything else, and never throws on a path that is not there", () => {
    assert.equal(isCommandEntryPoint(path.join(ROOT, "package.json"), COMMAND_URL), false);
    assert.equal(isCommandEntryPoint(path.join(ROOT, "no-such-file-9f21.mjs"), COMMAND_URL), false);
    assert.equal(isCommandEntryPoint(undefined, COMMAND_URL), false);
    assert.equal(isCommandEntryPoint("", COMMAND_URL), false);
  });
});

describe("the command uses that summary rather than a closing line of its own", () => {
  it("prints it and takes its exit code", () => {
    const source = readFileSync(path.join(ROOT, "scripts/provision-dev-instance.mjs"), "utf8");
    assert.match(source, /summarizeRunForExit\(/);
    assert.match(source, /process\.exitCode\s*=/);
  });

  it("asks the strict gate BEFORE it drains stdin or reports what arrived", () => {
    // The behavioural proof of this lives beside it, in the command's own
    // suite, with a stdin that throws the moment anything looks at it. This is
    // the second instrument: the order as written, so a reorder is visible in
    // the diff as well as in a failing run.
    const source = readFileSync(path.join(ROOT, "scripts/provision-dev-instance.mjs"), "utf8");
    assert.match(
      source,
      /assertDeclaredDevelopmentRuntime: strictGate/,
      "the command must take the strict gate as a port of its own",
    );
    const gateCall = source.indexOf("strictGate(");
    const read = source.indexOf("readAllText(");
    const summary = source.indexOf("summarizeSecretsForLog(");
    assert.ok(gateCall > -1, "the command must ask the strict gate itself");
    assert.ok(gateCall < read, "the strict gate must come before stdin is drained");
    assert.ok(gateCall < summary, "the strict gate must come before the document is reported");
  });
});

describe("the command states the secret-travel rule in its own header", () => {
  it("names stdin and all three prohibitions", () => {
    const header = readFileSync(path.join(ROOT, "scripts/provision-dev-instance.mjs"), "utf8").slice(
      0,
      6000,
    );
    for (const phrase of [
      "stdin",
      "never as a command-line argument",
      "never through an environment file written to disk",
      "never logged",
    ]) {
      assert.ok(header.includes(phrase), `the header must state: ${phrase}`);
    }
    assert.ok(SECRET_TRAVEL_RULE.includes("stdin"));
  });
});
