// ONE DEVELOPMENT COMMAND FOR THE FIVE SETUP WRITES.
//
//   pnpm provision:dev-instance -- \
//     --admin-email operator@example.test --admin-name "The Operator" \
//     --namespace acme-dev --display-name "Acme Development" \
//     --provider anthropic --public-origin https://acme.example
//
// with the secrets read from a file only you can read — NOT from an `echo`,
// which writes every one of them into your shell history:
//
//   (umask 077; cat > secrets.json)   # type the document, then Ctrl-D
//   pnpm provision:dev-instance -- --admin-email operator@example.test \
//     --namespace acme-dev --provider anthropic < secrets.json
//
// THE FIRST ADMINISTRATOR is the step that used to need a browser: the wizard's
// Account step is a sign-up form, and the first account to register is promoted
// by the product's own first-user bootstrap. `--admin-email` names the address
// (an address is not a secret); the PASSWORD travels on stdin as
// "adminPassword", and there is no flag that could carry it. Run against an
// instance that already has a person on it, the step writes nothing and says so.
//
// SECRET TRAVEL — the rule this command is built around, stated here because
// this is the file an operator reads before running it:
//
//     Every secret value reaches the running process over stdin, or an
//     equivalent in-process channel. It is never as a command-line argument,
//     never through an environment file written to disk, and never logged. The
//     argument parser has no flag that could carry one and REFUSES a
//     secret-looking flag rather than ignoring it.
//
//     Each value EXCEPT the administrator password is then sealed by the exact
//     encryption call the corresponding browser screen already uses. The
//     password is not sealed: it is hashed, one way, by the account creation
//     itself, exactly as it would be for an account created in a browser.
//     Nothing stores it in clear, and nothing can read it back.
//
// The command refuses to run outside a development runtime, and so does every
// write it performs — independently, one gate per wrapper.

import process from "node:process";

import {
  isCommandEntryPoint,
  parseProvisionInstanceArgs,
  parseProvisionSecretsPayload,
  readAllText,
  summarizeRunForExit,
  summarizeSecretsForLog,
} from "./lib/provision-dev-instance-args.mjs";

const { assertDeclaredDevelopmentRuntime, assertDevelopmentRuntime } = await import(
  "@/lib/dev-instance-provisioning/runtime-gate"
);
const { provisionDevInstance } = await import(
  "@/lib/dev-instance-provisioning/provision-instance"
);

/**
 * The command, as an exit code rather than a process: every edge is injectable
 * so the suite can drive it — the arguments, the stream the secrets arrive on,
 * the two lines it writes, the gates, and the provisioning call. Only the
 * caller at the bottom of this file owns `process.exitCode`.
 */
export async function runProvisionDevInstance(options = {}) {
  const fail = options.fail ?? ((line) => console.error(line));
  try {
    return await provisionFromCommandLine(options);
  } catch (error) {
    // The CLASS and the message of OUR errors only. Nothing here re-prints a
    // secrets document or a provider's echoed request.
    fail(`[provision:dev-instance] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

/** The body itself, which throws; the wrapper above is what turns that into a code. */
async function provisionFromCommandLine(options) {
  const {
    argv = process.argv.slice(2),
    stdin = process.stdin,
    log = (line) => console.log(line),
    fail = (line) => console.error(line),
    provisionDevInstance: provision = provisionDevInstance,
    assertDevelopmentRuntime: gate = assertDevelopmentRuntime,
    assertDeclaredDevelopmentRuntime: strictGate = assertDeclaredDevelopmentRuntime,
  } = options;

  // The gate before anything is read, so a production instance never even
  // parses a secrets document.
  gate("provision:dev-instance");

  const args = parseProvisionInstanceArgs(argv);

  // THE STRICT GATE BEFORE STDIN IS TOUCHED. The account leg asks it for itself
  // too — one gate per wrapper, and that stays — but the leg is reached only
  // after this process has drained the secrets document into memory and printed
  // which secrets arrived. A run that must not seat an administrator should not
  // have handled the document at all.
  if (args.adminEmail) strictGate("provision:dev-instance --admin-email");

  const secrets = parseProvisionSecretsPayload(await readAllText(stdin));
  log(`[provision:dev-instance] secrets on stdin — ${summarizeSecretsForLog(secrets)}`);

  if (args.adminEmail && !secrets.adminPassword) {
    throw new Error(
      "--admin-email needs a password, and a password travels on stdin: pipe " +
        '{"adminPassword":"…"} in.',
    );
  }
  if (secrets.adminPassword && !args.adminEmail) {
    throw new Error(
      'an "adminPassword" was piped in with no address to use it for. The address is an ' +
        "ordinary argument: pass --admin-email.",
    );
  }
  if (args.adminName && !args.adminEmail) {
    throw new Error('"--admin-name" names the administrator --admin-email creates.');
  }

  if (args.provider && !secrets.providerApiKey) {
    throw new Error(
      `--provider ${args.provider} needs a key, and a key travels on stdin: ` +
        'pipe {"providerApiKey":"…"} in.',
    );
  }

  const report = await provision({
    ...(args.adminEmail
      ? {
          firstAdministrator: {
            email: args.adminEmail,
            ...(args.adminName ? { name: args.adminName } : {}),
            password: secrets.adminPassword,
          },
        }
      : {}),
    ...(args.namespace
      ? {
          namespace: {
            instanceNamespace: args.namespace,
            instanceDisplayName: args.displayName || args.namespace,
          },
        }
      : {}),
    ...(secrets.connectorServiceSecretKey || secrets.connectorServiceUrl
      ? {
          connectorService: {
            secretKey: secrets.connectorServiceSecretKey,
            serverUrl: secrets.connectorServiceUrl,
          },
        }
      : {}),
    ...(args.provider
      ? {
          provider: {
            provider: args.provider,
            apiKey: secrets.providerApiKey,
            projectId: secrets.providerProjectId,
            organizationId: secrets.providerOrganizationId,
          },
        }
      : {}),
    ...(args.publicOrigin !== undefined ? { publicOrigin: args.publicOrigin } : {}),
  });

  for (const notice of report.notices) log(`[provision:dev-instance] ${notice}`);

  // The closing line and the exit code are ONE decision, taken in the
  // dependency-free module beside this one so the suite can drive it: an
  // account created but never promoted is not a success, and an unattended
  // caller reads the code, not the prose.
  const { line, exitCode } = summarizeRunForExit(report);
  if (exitCode === 0) log(`[provision:dev-instance] ${line}`);
  else fail(`[provision:dev-instance] ${line}`);
  return exitCode;
}

// THIS FILE IS BOTH the command and a module the suite imports. It runs only
// when it IS the command the process was started with; imported, it defines
// everything above and runs none of it.
if (isCommandEntryPoint(process.argv[1], import.meta.url)) {
  process.exitCode = await runProvisionDevInstance().catch((error) => {
    console.error(
      `[provision:dev-instance] ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  });
}
