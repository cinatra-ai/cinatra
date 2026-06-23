// Verdaccio works-after round-trip helper (cinatra#352) — user provisioning.
//
// The repo's config.yaml requires `$authenticated` to publish. This mints a
// per-run THROWAWAY registry user by REUSING the repo's own createNpmUser
// (packages/registries/src/verdaccio/user-provisioning.ts — anonymous
// PUT /-/user/org.couchdb.user:<ns> → returns a token), then prints the token
// to stdout for the arm's .npmrc. No npm-cli-login dep, no ops/broker identity.
//
// Run: node --import tsx scripts/ci/works-after/rt/verdaccio-roundtrip.ts
// Env: VERDACCIO_URL (required), WORKS_AFTER_NS (the throwaway username).

import { randomBytes } from "node:crypto";
import { createNpmUser } from "../../../../packages/registries/src/verdaccio/user-provisioning.ts";

const REGISTRY = process.env.VERDACCIO_URL;
const NS = process.env.WORKS_AFTER_NS;
if (!REGISTRY || !NS) {
  console.error("verdaccio-roundtrip: VERDACCIO_URL and WORKS_AFTER_NS are required");
  process.exit(2);
}

async function main(): Promise<void> {
  // A throwaway per-run password for the ephemeral registry user. Use CSPRNG
  // bytes (not Math.random) — the value lands in a credential field, so a
  // cryptographically strong source is the correct posture even though the
  // registry + user are destroyed at the end of the run.
  const { token } = await createNpmUser({
    instanceNamespace: NS!,
    password: `wa-${randomBytes(24).toString("hex")}`,
    email: `${NS}@works-after.invalid`,
    registryUrl: REGISTRY!,
  });
  // Print ONLY the token (the arm captures it into a temp .npmrc).
  process.stdout.write(token);
}

main().catch((err) => {
  console.error(`verdaccio-roundtrip (user provisioning) FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
