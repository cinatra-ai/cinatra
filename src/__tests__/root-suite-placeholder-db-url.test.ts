import { readFileSync } from "node:fs";
import net from "node:net";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT_SUITE_PLACEHOLDER_DB_URL } from "../../vitest.placeholder-db-url";

/**
 * The root unit suite must never reach a real database. Its placeholder
 * connection string is therefore pinned to `localhost` on TCP port 1, an
 * endpoint nothing in the test environment answers. A placeholder on the
 * PostgreSQL default port met a PostgreSQL that happened to listen on the
 * conventional local endpoint and turned fifteen unrelated tests red with
 * "password authentication failed" instead of a refused connection.
 */
describe("the root suite's placeholder database endpoint is never answered", () => {
  const url = new URL(ROOT_SUITE_PLACEHOLDER_DB_URL);

  it("keeps the placeholder prefix the integration tiers recognise, off the PostgreSQL default port", () => {
    expect(ROOT_SUITE_PLACEHOLDER_DB_URL.startsWith("postgres://unused:unused@localhost:")).toBe(true);
    expect(url.port).toBe("1");
    expect(url.port).not.toBe("5432");
  });

  it("is the address the root configuration hands to the suite", () => {
    const config = readFileSync(resolve(process.cwd(), "vitest.config.ts"), "utf8");
    expect(config).toContain("ROOT_SUITE_PLACEHOLDER_DB_URL");
    expect(config).not.toMatch(/unused:unused@localhost:5432/);
  });

  it("is refused at the socket, never answered", async () => {
    const outcome = await new Promise<string>((done) => {
      const socket = net.connect({ host: url.hostname, port: Number(url.port) });
      socket.setTimeout(2000, () => { socket.destroy(); done("timeout"); });
      socket.on("connect", () => { socket.destroy(); done("connected"); });
      socket.on("error", (error: NodeJS.ErrnoException) => done(error.code ?? "error"));
    });
    expect(outcome).toBe("ECONNREFUSED");
  });
});
