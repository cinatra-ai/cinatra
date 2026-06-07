/**
 * Asserts the shape of the `a2a-peer-*` services in `docker-compose.yml`.
 *
 * Seven service keys exist (three for number-guessing Alice/Bob/Carol). SIX are
 * active under `profiles: ["a2a-peers"]` with distinct host ports
 * 10001/10002/10004/10005/10006/10007 and a healthcheck each. number-bob is a
 * CLI client (no A2A HTTP endpoint), so it sits behind `a2a-peers-disabled` and
 * its port 10003 is intentionally NOT mapped. `GEMINI_API_KEY` is forwarded with
 * a `GOOGLE_API_KEY` fallback.
 *
 * The peer sources are cloned into `dev/a2a-peers/` by `cinatra setup` from
 * cinatra-ai/a2a-servers-dev (package.json `cinatra.devApps`); the compose build
 * contexts point at `./dev/a2a-peers/<agent>`.
 *
 * We do NOT add a YAML parser dependency. The checks are regex + string
 * assertions against the raw file content.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(__dirname, "..", "..");
const composePath = path.join(root, "docker-compose.yml");

// Read once. If the file doesn't exist we want a clean assertion failure
// rather than a framework-level exception, so we guard with existsSync and
// fall back to empty string.
const yaml = fs.existsSync(composePath)
  ? fs.readFileSync(composePath, "utf8")
  : "";

// Active A2A peers: started by `docker compose --profile a2a-peers`.
const ACTIVE_SERVICES = [
  "a2a-peer-helloworld",
  "a2a-peer-number-alice",
  "a2a-peer-number-carol",
  "a2a-peer-dice-rest",
  "a2a-peer-signing",
  "a2a-peer-adk-reimbursement",
];
// number-bob is a CLI client (no A2A HTTP endpoint) — gated off the active profile.
const DISABLED_SERVICE = "a2a-peer-number-bob";
// Active host ports (one per active service). 10003 (Bob) is intentionally absent.
const ACTIVE_PORTS = [10001, 10002, 10004, 10005, 10006, 10007];

describe("a2a peer docker-compose.yml", () => {
  it("declares 7 service keys; 6 active under [a2a-peers], bob under [a2a-peers-disabled]", () => {
    expect(fs.existsSync(composePath)).toBe(true);

    // All seven service names appear as top-level keys (2-space indent under `services:`).
    for (const svc of [...ACTIVE_SERVICES, DISABLED_SERVICE]) {
      const keyRegex = new RegExp(`^  ${svc}:`, "m");
      expect(yaml, `service ${svc} missing from docker-compose.yml`).toMatch(
        keyRegex,
      );
    }

    // Exactly six services are gated by the active `a2a-peers` profile so they
    // stay off by default; bob is on the `a2a-peers-disabled` profile.
    const activeProfileMatches = yaml.match(
      /profiles:\s*\[\s*"a2a-peers"\s*\]/g,
    ) ?? [];
    expect(
      activeProfileMatches.length,
      `expected 6 profiles: ["a2a-peers"] occurrences, got ${activeProfileMatches.length}`,
    ).toBe(6);
    expect(yaml, "bob must be on the a2a-peers-disabled profile").toMatch(
      /profiles:\s*\[\s*"a2a-peers-disabled"\s*\]/,
    );
  });

  it("maps the 6 active host ports (10001/2/4/5/6/7); 10003 (bob) is unmapped", () => {
    // 1. Each active host port appears in the file; 10003 does not.
    for (const port of ACTIVE_PORTS) {
      expect(
        yaml.includes(`"${port}:`),
        `expected active host port ${port} to be mapped`,
      ).toBe(true);
    }
    expect(
      yaml.includes(`"10003:`),
      "bob (10003) must NOT be mapped — it has no A2A HTTP endpoint",
    ).toBe(false);

    // 2. Collect every "<host>:<container>" mapping, restrict to our expected
    // active set, and assert exactly six unique host ports (no duplicates).
    const mappingRegex = /"(\d+):\d+"/g;
    const seenHostPorts: number[] = [];
    let match: RegExpExecArray | null;
    while ((match = mappingRegex.exec(yaml)) !== null) {
      const host = Number(match[1]);
      if (ACTIVE_PORTS.includes(host)) {
        seenHostPorts.push(host);
      }
    }
    const unique = new Set(seenHostPorts);
    expect(
      unique.size,
      `expected 6 unique active a2a-peer host ports, got ${unique.size}`,
    ).toBe(6);
    expect(
      seenHostPorts.length,
      "no duplicate host-port mappings allowed across active a2a-peer services",
    ).toBe(6);
  });

  it("forwards GEMINI_API_KEY with GOOGLE_API_KEY fallback; each active peer has its own healthcheck (bob has none)", () => {
    // Env var forwarding with the fallback string must be present verbatim.
    expect(yaml).toContain(
      "GEMINI_API_KEY: ${GEMINI_API_KEY:-${GOOGLE_API_KEY:-}}",
    );

    // Extract a single service's block: from its "  <name>:" key up to the next
    // top-level (2-space-indented) service key, or EOF. This scopes the
    // healthcheck check to the service itself, so bob (no healthcheck) cannot
    // "borrow" the next service's healthcheck via a non-greedy cross-service match.
    const blockFor = (svc: string): string => {
      const start = yaml.search(new RegExp(`^  ${svc}:`, "m"));
      if (start < 0) return "";
      const rest = yaml.slice(start + 1);
      const nextKey = rest.search(/^ {2}\S/m); // next 2-space-indented service key
      return nextKey < 0 ? yaml.slice(start) : yaml.slice(start, start + 1 + nextKey);
    };

    for (const svc of ACTIVE_SERVICES) {
      expect(blockFor(svc), `${svc} must declare its own healthcheck`).toMatch(
        /healthcheck:/,
      );
    }
    expect(
      blockFor(DISABLED_SERVICE),
      "bob (disabled, no A2A HTTP endpoint) must not declare a healthcheck",
    ).not.toMatch(/healthcheck:/);
  });
});
