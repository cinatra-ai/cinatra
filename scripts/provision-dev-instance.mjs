// ONE DEVELOPMENT COMMAND FOR THE FOUR SETUP WRITES.
//
//   pnpm provision:dev-instance -- \
//     --namespace acme-dev --display-name "Acme Development" \
//     --provider anthropic --public-origin https://acme.example
//
// with the secrets piped in:
//
//   echo '{"providerApiKey":"…","connectorServiceSecretKey":"…"}' \
//     | pnpm provision:dev-instance -- --namespace acme-dev --provider anthropic
//
// SECRET TRAVEL — the rule this command is built around, stated here because
// this is the file an operator reads before running it:
//
//     Every secret value reaches the running process over stdin, or an
//     equivalent in-process channel. It is never as a command-line argument,
//     never through an environment file written to disk, and never logged. The
//     argument parser has no flag that could carry one and REFUSES a
//     secret-looking flag rather than ignoring it. Each value is sealed by the
//     exact encryption call the corresponding browser screen already uses.
//
// The command refuses to run outside a development runtime, and so does every
// write it performs — independently, one gate per wrapper.

import process from "node:process";

import {
  parseProvisionInstanceArgs,
  parseProvisionSecretsPayload,
  readAllText,
  summarizeSecretsForLog,
} from "./lib/provision-dev-instance-args.mjs";

const { assertDevelopmentRuntime } = await import("@/lib/dev-instance-provisioning/runtime-gate");
const { provisionDevInstance } = await import(
  "@/lib/dev-instance-provisioning/provision-instance"
);

async function main() {
  // The gate before anything is read, so a production instance never even
  // parses a secrets document.
  assertDevelopmentRuntime("provision:dev-instance");

  const args = parseProvisionInstanceArgs(process.argv.slice(2));
  const secrets = parseProvisionSecretsPayload(await readAllText(process.stdin));
  console.log(`[provision:dev-instance] secrets on stdin — ${summarizeSecretsForLog(secrets)}`);

  if (args.provider && !secrets.providerApiKey) {
    throw new Error(
      `--provider ${args.provider} needs a key, and a key travels on stdin: ` +
        'pipe {"providerApiKey":"…"} in.',
    );
  }

  const report = await provisionDevInstance({
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

  for (const notice of report.notices) console.log(`[provision:dev-instance] ${notice}`);
  console.log(
    `[provision:dev-instance] done — ${report.wrote ? "the instance was provisioned" : "nothing to do; the instance already stood"}.`,
  );
}

main().catch((error) => {
  // The CLASS and the message of OUR errors only. Nothing here re-prints a
  // secrets document or a provider's echoed request.
  console.error(`[provision:dev-instance] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
