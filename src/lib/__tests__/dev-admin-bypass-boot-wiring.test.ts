/**
 * The boot hook installs the development admin bypass behind the transport's
 * port.
 *
 * The transport module cannot import the composition: a filesystem reader and a
 * `node:http` capture would travel into every graph that imports the transport
 * for unrelated reasons. It asks a port instead, and the port answers only
 * after the boot hook fills it — so if this wiring ever disappears, the bypass
 * goes quietly dead on the MCP surface while the `/api/cli/*` guard, which
 * calls the composition directly, keeps working. That asymmetry is exactly the
 * kind of drift a reader would not notice, so it is pinned here.
 *
 * The assertion reads the boot entry's SOURCE rather than importing it:
 * `register()` pulls the whole Node startup graph (crash handlers, database
 * warmup, subscribers), none of which belongs in a unit test.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const INSTRUMENTATION = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../instrumentation.ts",
);

/**
 * Comments are removed before anything is asserted: this file's subject is
 * executable wiring, and `instrumentation.ts` documents these very module names
 * in prose, so a call NAMED in a comment must never satisfy the assertions
 * below.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

describe("the Node boot hook", () => {
  const source = stripComments(readFileSync(INSTRUMENTATION, "utf8"));

  it("installs the one composition behind the transport's port", () => {
    expect(source).toContain("@cinatra-ai/mcp-server/dev-admin-bypass-request");
    expect(source).toContain("installDevAdminBypassRequestPort()");
  });

  it("installs it in the Node runtime branch, after the capture and the credential", () => {
    const nodeBranch = source.indexOf('process.env.NEXT_RUNTIME === "nodejs"');
    const capture = source.indexOf("installLocalConnectionCapture()");
    const mint = source.indexOf("mintDevLocalToken()");
    const install = source.indexOf("installDevAdminBypassRequestPort()");
    expect(nodeBranch).toBeGreaterThanOrEqual(0);
    expect(capture).toBeGreaterThan(nodeBranch);
    expect(mint).toBeGreaterThan(capture);
    // The port is filled only once the two facts it reads exist, so the
    // readiness notice it emits reports the truth about this process.
    expect(install).toBeGreaterThan(mint);
  });
});
