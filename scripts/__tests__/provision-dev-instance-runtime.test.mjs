import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

describe("development provisioning in the actual tsx runtime", () => {
  it("refuses Anthropic before handling secrets or making setup writes", () => {
    const sentinel = "synthetic-provider-secret-never-print-3766";
    const result = spawnSync(process.execPath, [
      "--conditions=react-server", "--import", "tsx",
      "scripts/provision-dev-instance.mjs",
      "--namespace", "refused-before-write",
      "--provider", "anthropic",
    ], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 30_000,
      input: JSON.stringify({ providerApiKey: sentinel }),
      env: {
        ...process.env,
        NODE_ENV: "development",
        CINATRA_RUNTIME_MODE: "development",
        APP_RUNTIME_MODE: "development",
        // No database is needed to refuse the provider. Reaching the database
        // would fail the one-line refusal contract below.
        SUPABASE_DB_URL: "postgres://postgres@127.0.0.1:1/unused",
      },
    });

    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^\[provision:dev-instance\] .*Anthropic.*setup wizard.*--provider openai[^\n]*\n$/);
    assert.equal(result.stderr.includes(sentinel), false);
  }, 35_000);
});
