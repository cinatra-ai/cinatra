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

import {
  SECRET_TRAVEL_RULE,
  SecretInArgumentsError,
  parseProvisionInstanceArgs,
  parseProvisionSecretsPayload,
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
    ]);
    assert.equal(parsed.namespace, "acme-dev");
    assert.equal(parsed.displayName, "Acme Development");
    assert.equal(parsed.publicOrigin, "https://origin.example");
    assert.equal(parsed.provider, "anthropic");
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
    ]) {
      assert.throws(
        () => parseProvisionInstanceArgs(["--namespace", "acme-dev", flag, "not-a-real-value"]),
        SecretInArgumentsError,
        `${flag} must be refused, not ignored`,
      );
    }
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
});

describe("parseProvisionSecretsPayload", () => {
  it("reads the secrets from a stdin JSON document", () => {
    const payload = parseProvisionSecretsPayload(
      JSON.stringify({
        providerApiKey: "synthetic-provider-value",
        connectorServiceSecretKey: "synthetic-connector-value",
        connectorServiceUrl: "http://127.0.0.1:3003",
      }),
    );
    assert.equal(payload.providerApiKey, "synthetic-provider-value");
    assert.equal(payload.connectorServiceSecretKey, "synthetic-connector-value");
    assert.equal(payload.connectorServiceUrl, "http://127.0.0.1:3003");
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
    });
    assert.equal(summary.includes("synthetic-provider-value"), false);
    assert.equal(summary.includes("synthetic-connector-value"), false);
    assert.match(summary, /provider api key: supplied/i);
    assert.match(summary, /connector-service secret: supplied/i);
    assert.match(summarizeSecretsForLog({}), /provider api key: absent/i);
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
