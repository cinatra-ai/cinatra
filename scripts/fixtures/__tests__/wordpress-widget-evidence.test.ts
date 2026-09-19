import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const driver = fileURLToPath(new URL("../verify-wordpress-widget.mts", import.meta.url));
const active = '<div data-embed-assistant data-phase="active"><textarea data-testid="chat-prompt-input"></textarea></div>';

for (const existingSession of [true, false]) {
  test(`widget probe reports ${existingSession ? "an existing session" : "an observed sign-in popup"}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "widget-evidence-test-"));
    const server = createServer((req, res) => {
      res.setHeader("content-type", "text/html");
      if (req.url === "/wp-admin/") {
        res.end('<div id="cinatra-root" data-cinatra-mounted="true"><button class="cw-circle">Open</button><iframe class="cw-frame" src="/widget"></iframe></div>');
      } else if (req.url === "/widget") {
        res.end(existingSession ? active : '<div data-embed-state="signin"><button data-embed-signin onclick="window.open(\'/popup\')">Sign in</button></div>');
      } else if (req.url === "/popup") {
        res.end(`<script>setTimeout(() => { window.opener.document.body.innerHTML = ${JSON.stringify(active)}; window.close(); }, 200);</script>`);
      } else {
        res.writeHead(404).end();
      }
    });
    try {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const state = join(directory, "state.json");
      const evidence = join(directory, "evidence.json");
      await writeFile(state, JSON.stringify({ cookies: [], origins: [] }), { mode: 0o600 });
      await run(process.execPath, ["--import", "tsx", driver,
        "--wordpress", `http://127.0.0.1:${address.port}`,
        "--storage-state", state, "--evidence", evidence], {
        env: { ...process.env, CINATRA_RUNTIME_MODE: "development" }, timeout: 30_000,
      });
      const result = JSON.parse(await readFile(evidence, "utf8"));
      assert.equal(result.widgetFrame, "passed");
      assert.equal(result.signInPopupObserved, !existingSession);
      assert.equal(result.authentication, existingSession ? "existing-frame-session" : "frame-owned-sign-in-popup");
      assert.equal(result.evidence.includes("sign-in popup"), !existingSession);
      assert.equal(result.mediaRows, "not_checked");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  });
}
