import { defineConfig } from "vitest/config";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..", "..");

// The lane's own .env.local, surfaced into process.env exactly as the sibling
// walks do it — this talks to THIS lane's Postgres and to nothing else.
for (const rawLine of (require("node:fs").existsSync(path.join(ROOT, ".env.local"))
  ? require("node:fs").readFileSync(path.join(ROOT, ".env.local"), "utf8")
  : ""
).split("\n")) {
  const line = rawLine.trim();
  if (!line || line.startsWith("#")) continue;
  const eq = line.indexOf("=");
  if (eq === -1) continue;
  const key = line.slice(0, eq).trim();
  let value = line.slice(eq + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  if (process.env[key] === undefined) process.env[key] = value;
}

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: [{ find: "server-only", replacement: path.join(ROOT, "tests/__stubs__/server-only.ts") }],
  },
  test: {
    root: ROOT,
    include: ["evidence/2936-w6-captures-batch-3-widget/drivers/02-register-widget-instance.test.ts"],
    testTimeout: 600_000,
    hookTimeout: 600_000,
    pool: "forks",
    disableConsoleIntercept: true,
  },
});
