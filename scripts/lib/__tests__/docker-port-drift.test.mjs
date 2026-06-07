// Regression coverage for the Docker DB/cache host-port drift guard
// (scripts/lib/docker-port-drift.mjs). Pure-logic tests — no Docker required.
//
// Run: node --test scripts/lib/__tests__/docker-port-drift.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  BUNDLED_DB_SERVICES,
  isLoopbackHost,
  shouldDiagnoseDrift,
  detectDriftFromInspect,
  resolveMainRepoRoot,
  formatDriftRemedy,
  parseHostPort,
} from "../docker-port-drift.mjs";

const PG = BUNDLED_DB_SERVICES.find((s) => s.composeService === "postgres");
const REDIS = BUNDLED_DB_SERVICES.find((s) => s.composeService === "redis");

test("base-only stack: container running, port unpublished → DRIFT", () => {
  const r = detectDriftFromInspect({
    running: true,
    containerPort: PG.containerPort,
    expectedHostPort: PG.defaultHostPort,
    portsJson: { "5432/tcp": null },
  });
  assert.equal(r.drift, true);
  assert.match(r.reason, /not published/);
});

test("base-only stack: empty ports map, container running → DRIFT", () => {
  const r = detectDriftFromInspect({
    running: true,
    containerPort: REDIS.containerPort,
    expectedHostPort: REDIS.defaultHostPort,
    portsJson: {},
  });
  assert.equal(r.drift, true);
});

test("healthy dev stack: port published to the expected host port → NO drift", () => {
  const r = detectDriftFromInspect({
    running: true,
    containerPort: PG.containerPort,
    expectedHostPort: PG.defaultHostPort,
    portsJson: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "5434" }] },
  });
  assert.equal(r.drift, false);
  assert.match(r.reason, /published/);
});

test("container not running → NOT drift (stack-down is a different problem)", () => {
  const r = detectDriftFromInspect({
    running: false,
    containerPort: PG.containerPort,
    expectedHostPort: PG.defaultHostPort,
    portsJson: { "5432/tcp": null },
  });
  assert.equal(r.drift, false);
  assert.equal(r.running, false);
});

test("published but to a DIFFERENT host port → DRIFT (expected binding absent)", () => {
  const r = detectDriftFromInspect({
    running: true,
    containerPort: PG.containerPort,
    expectedHostPort: PG.defaultHostPort,
    portsJson: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "5599" }] },
  });
  assert.equal(r.drift, true);
});

test("external DB URL (hosted) → NOT a drift candidate (skip docker diagnosis)", () => {
  assert.equal(shouldDiagnoseDrift({ host: "db.prod.example.com", port: 5432 }, PG), false);
  assert.equal(shouldDiagnoseDrift({ host: "10.1.2.3", port: 5434 }, PG), false);
});

test("isolated branch schema: shared PG on loopback default → IS a drift candidate", () => {
  // `cinatra setup branch` keeps SUPABASE_DB_URL on 127.0.0.1:5434 (its own
  // SCHEMA, same shared server), so the bundled-stack port guard still applies.
  assert.equal(shouldDiagnoseDrift({ host: "127.0.0.1", port: 5434 }, PG), true);
});

test("heavy clone DB: separate database on the SHARED loopback server → IS a candidate", () => {
  // `setup clone` makes a separate database inside the shared Postgres server,
  // still reached on 127.0.0.1:5434 — the shared port must be published.
  assert.equal(shouldDiagnoseDrift({ host: "localhost", port: 5434 }, PG), true);
});

test("loopback Postgres URL with NO explicit port resolves to scheme default 5432 → NOT a candidate", () => {
  // postgresql://postgres@localhost/postgres means :5432 (a non-bundled local
  // DB), NOT the bundled 5434 — must not trigger a false drift exit.
  const { host, port } = parseHostPort("postgresql://postgres@localhost/postgres", {
    host: "127.0.0.1",
    port: PG.defaultHostPort,
  });
  assert.equal(host, "localhost");
  assert.equal(port, 5432);
  assert.equal(shouldDiagnoseDrift({ host, port }, PG), false);
});

test("explicit bundled port in the URL is honored over scheme default", () => {
  const { port } = parseHostPort("postgresql://postgres:postgres@127.0.0.1:5434/postgres", {
    host: "127.0.0.1",
    port: PG.defaultHostPort,
  });
  assert.equal(port, 5434);
  assert.equal(shouldDiagnoseDrift({ host: "127.0.0.1", port }, PG), true);
});

test("non-default loopback port (unrelated/clone runtime project) → NOT a candidate", () => {
  // A clone's own runtime compose project publishes different ports; the main
  // bundled-stack guard only fires on the canonical default port.
  assert.equal(shouldDiagnoseDrift({ host: "127.0.0.1", port: 5599 }, PG), false);
});

test("isLoopbackHost matrix", () => {
  for (const h of ["127.0.0.1", "localhost", "::1", "0.0.0.0"]) assert.equal(isLoopbackHost(h), true);
  for (const h of ["db.example.com", "10.0.0.5", "", null]) assert.equal(isLoopbackHost(h), false);
});

test("formatDriftRemedy names the services + the canonical fix commands", () => {
  const msg = formatDriftRemedy(["PostgreSQL", "Redis"]);
  assert.match(msg, /PostgreSQL, Redis/);
  assert.match(msg, /pnpm services/);
  assert.match(msg, /docker-compose\.dev\.yml/);
});

test("resolveMainRepoRoot returns an absolute path (smoke)", () => {
  const root = resolveMainRepoRoot(process.cwd());
  assert.equal(typeof root, "string");
  assert.ok(root.length > 0);
  assert.ok(path.isAbsolute(root));
});
