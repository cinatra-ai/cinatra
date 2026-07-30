// The exec-plane compose SCOPING gate (exec-plane L3, epic cinatra#1705).
//
// Dependency-free (`node --test` + `node:assert`), like the actions-pinned
// gate: the gate itself must run without a `pnpm install`, and so must its
// tests.
//
// Two halves:
//   - the SHIPPED compose file passes (the positive case that would otherwise
//     rot silently);
//   - hand-built violations are CAUGHT (the negative cases that are the actual
//     point — a gate nobody has seen fail is a gate nobody knows works).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  BANNED_APP_KEYS,
  DEFAULT_COMPOSE_PATH,
  SCOPED_ENV_FILE_RE,
  checkExecComposeScoping,
  parseComposeSubset,
  resolveInterpolation,
} from "../exec-compose-scoping-check.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function shippedDoc() {
  return parseComposeSubset(
    readFileSync(resolve(REPO_ROOT, DEFAULT_COMPOSE_PATH), "utf8"),
  );
}

// ---------------------------------------------------------------------------
// The shipped file
// ---------------------------------------------------------------------------

test("the shipped docker-compose.exec.yml passes the gate", () => {
  assert.deepEqual(checkExecComposeScoping(shippedDoc()), []);
});

test("the shipped file declares the three exec services", () => {
  const doc = shippedDoc();
  assert.deepEqual(Object.keys(doc.services).sort(), [
    "cinatra-exec-broker",
    "cinatra-exec-gateway",
    "cinatra-exec-worker",
  ]);
});

test("only the worker carries the docker socket", () => {
  const doc = shippedDoc();
  const withSocket = Object.entries(doc.services)
    .filter(([, svc]) =>
      (svc.volumes ?? []).some((v) => typeof v === "string" && v.includes("docker.sock")),
    )
    .map(([name]) => name);
  assert.deepEqual(withSocket, ["cinatra-exec-worker"]);
});

test("the broker binds the lease DIRECTORY, never the lease file", () => {
  const doc = shippedDoc();
  const binds = doc.services["cinatra-exec-broker"].volumes ?? [];
  const lease = binds.find((v) => v.includes("lease"));
  assert.ok(lease, "the broker must bind the lease directory");
  // A file bind would pin the container to the inode the lease has TODAY; the
  // provisioning side replaces it with an atomic rename.
  assert.ok(
    !lease.includes(".lease:"),
    "the bind target must be the directory, not the lease document",
  );
  assert.ok(lease.endsWith(":rw"), "renewal has to be able to write");
});

test("every env_file is a per-service scoped file under the exec directory", () => {
  const doc = shippedDoc();
  for (const [name, svc] of Object.entries(doc.services)) {
    const entries = (svc.env_file ?? []).map((e) => (typeof e === "string" ? e : e.path));
    assert.ok(entries.length > 0, `${name} must declare a scoped env_file`);
    for (const entry of entries) {
      // The committed value carries a `${VAR:-default}` wrapper; the DEFAULT is
      // what a deployment gets when it configures nothing, so that is what has
      // to be in-scope.
      const resolved = resolveInterpolation(entry);
      assert.ok(resolved.includes("/opt/cinatra-exec"), `${name}: ${entry}`);
      assert.match(resolved, SCOPED_ENV_FILE_RE, `${name}: ${entry}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Violations
// ---------------------------------------------------------------------------

function docWith(mutate) {
  const doc = shippedDoc();
  mutate(doc);
  return doc;
}

test("a banned app key on any exec service fails the gate", () => {
  for (const key of ["SUPABASE_DB_URL", "BETTER_AUTH_SECRET", "CINATRA_ENCRYPTION_KEY"]) {
    const doc = docWith((d) => {
      d.services["cinatra-exec-broker"].environment[key] = "x";
    });
    const violations = checkExecComposeScoping(doc);
    assert.ok(
      violations.some((v) => v.includes(key)),
      `${key} must be reported: ${JSON.stringify(violations)}`,
    );
  }
});

test("the voucher SIGNING key is banned — the broker is verify-only", () => {
  assert.ok(BANNED_APP_KEYS.includes("EXECUTION_VOUCHER_SIGNING_KEY"));
  const doc = docWith((d) => {
    d.services["cinatra-exec-broker"].environment.EXECUTION_VOUCHER_SIGNING_KEY = "x";
  });
  assert.ok(
    checkExecComposeScoping(doc).some((v) => v.includes("EXECUTION_VOUCHER_SIGNING_KEY")),
  );
});

test("an unknown key fails even when it is not on the banned list", () => {
  const doc = docWith((d) => {
    d.services["cinatra-exec-worker"].environment.SOME_FUTURE_APP_KEY = "x";
  });
  assert.ok(
    checkExecComposeScoping(doc).some((v) => v.includes("SOME_FUTURE_APP_KEY")),
    "the fence is an allowlist, not a blocklist",
  );
});

test("the app's env file is rejected outright", () => {
  const doc = docWith((d) => {
    d.services["cinatra-exec-broker"].env_file = [".env.local"];
  });
  const violations = checkExecComposeScoping(doc);
  assert.ok(violations.some((v) => v.includes("outside /opt/cinatra-exec")));
});

test("a shared exec env file is rejected — scoping is PER SERVICE", () => {
  const doc = docWith((d) => {
    d.services["cinatra-exec-broker"].env_file = ["/opt/cinatra-exec/.env"];
  });
  assert.ok(
    checkExecComposeScoping(doc).some((v) => v.includes("per-service")),
    "one shared file would put every service's secrets in every service",
  );
});

test("a service with no env_file at all is rejected", () => {
  const doc = docWith((d) => {
    delete d.services["cinatra-exec-gateway"].env_file;
  });
  assert.ok(checkExecComposeScoping(doc).some((v) => v.includes("no scoped env_file")));
});

test("the docker socket on the broker fails the gate", () => {
  const doc = docWith((d) => {
    d.services["cinatra-exec-broker"].volumes.push(
      "/var/run/docker.sock:/var/run/docker.sock",
    );
  });
  assert.ok(checkExecComposeScoping(doc).some((v) => v.includes("mounts the docker socket")));
});

test("the docker socket on the gateway fails the gate", () => {
  const doc = docWith((d) => {
    d.services["cinatra-exec-gateway"].volumes = [
      "/var/run/docker.sock:/var/run/docker.sock",
    ];
  });
  assert.ok(checkExecComposeScoping(doc).some((v) => v.includes("mounts the docker socket")));
});

test("a worker with NO socket fails too — the topology could not run a command", () => {
  const doc = docWith((d) => {
    d.services["cinatra-exec-worker"].volumes = [];
  });
  assert.ok(checkExecComposeScoping(doc).some((v) => v.includes("cannot run a command")));
});

test("a non-internal sandbox network fails the gate", () => {
  const doc = docWith((d) => {
    d.networks["cinatra-exec-internal"].internal = "false";
  });
  assert.ok(checkExecComposeScoping(doc).some((v) => v.includes("internal: true")));
});

// ---------------------------------------------------------------------------
// The parser fails closed
// ---------------------------------------------------------------------------

test("the parser refuses constructs it does not model", () => {
  assert.throws(() => parseComposeSubset("services:\n  a: &anchor\n    x: 1\n"));
  assert.throws(() => parseComposeSubset("services:\n  a:\n    x: {y: 1}\n"));
  assert.throws(() => parseComposeSubset("services:\n  a:\n    x: |\n      text\n"));
  assert.throws(() => parseComposeSubset("services:\n  a:\n    x: [[1]]\n"));
});

test("the parser keeps a `#` inside a quoted scalar", () => {
  const doc = parseComposeSubset('services:\n  a:\n    image: "repo/img#tag"\n');
  assert.equal(doc.services.a.image, "repo/img#tag");
});

test("a missing services mapping is a violation, not a crash", () => {
  assert.deepEqual(checkExecComposeScoping({}), [
    "the compose file declares no `services` mapping",
  ]);
});
