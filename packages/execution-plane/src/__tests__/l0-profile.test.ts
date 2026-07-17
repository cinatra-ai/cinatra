import { describe, expect, it } from "vitest";

import {
  assertNoBindMounts,
  buildHardenedRunArgs,
  containerNameFor,
  DEFAULT_L0_IMAGE_LOCAL_DEV,
  assertSafeImageRef,
  resolveL0ImageRef,
  sandboxEnvironment,
  SANDBOX_RUNTIME_GID,
  SANDBOX_RUNTIME_UID,
  wrapSandboxCommand,
} from "../l0-profile";
import { DEFAULT_SANDBOX_LIMITS, type SandboxCommandSpec } from "../types";

const baseSpec = (egress: SandboxCommandSpec["egress"]): SandboxCommandSpec => ({
  jobId: "job-1",
  command: "echo hi",
  workspaceVolume: "cinatra-exec-l2-run1",
  egress,
  limits: DEFAULT_SANDBOX_LIMITS,
});

const gatewayEgress: SandboxCommandSpec["egress"] = {
  kind: "gateway",
  mode: "default_internet",
  network: "cinatra-exec-internal",
  gateway: { host: "cinatra-exec-gateway", port: 3128 },
  jobToken: "job-abc",
};

describe("resolveL0ImageRef", () => {
  it("prefers the explicit override, then env, then the local-dev tag", () => {
    expect(resolveL0ImageRef("img@sha256:beef")).toBe("img@sha256:beef");
    const prev = process.env.CINATRA_SANDBOX_L0_IMAGE;
    process.env.CINATRA_SANDBOX_L0_IMAGE = "registry/pinned@sha256:cafe";
    try {
      expect(resolveL0ImageRef()).toBe("registry/pinned@sha256:cafe");
    } finally {
      if (prev === undefined) delete process.env.CINATRA_SANDBOX_L0_IMAGE;
      else process.env.CINATRA_SANDBOX_L0_IMAGE = prev;
    }
  });

  it("falls back to the local-dev tag", () => {
    const prev = process.env.CINATRA_SANDBOX_L0_IMAGE;
    delete process.env.CINATRA_SANDBOX_L0_IMAGE;
    try {
      expect(resolveL0ImageRef()).toBe(DEFAULT_L0_IMAGE_LOCAL_DEV);
    } finally {
      if (prev !== undefined) process.env.CINATRA_SANDBOX_L0_IMAGE = prev;
    }
  });
});

describe("buildHardenedRunArgs — the hardened-container contract", () => {
  const args = buildHardenedRunArgs(baseSpec({ kind: "none" }), {
    imageRef: "l0:test",
    containerName: "cinatra-exec-job-1-0",
  });

  it("runs non-root with the fixed runtime identity", () => {
    const userIdx = args.indexOf("--user");
    expect(userIdx).toBeGreaterThan(-1);
    expect(args[userIdx + 1]).toBe(`${SANDBOX_RUNTIME_UID}:${SANDBOX_RUNTIME_GID}`);
  });

  it("applies read-only rootfs, cap-drop ALL and no-new-privileges", () => {
    expect(args).toContain("--read-only");
    const capIdx = args.indexOf("--cap-drop");
    expect(args[capIdx + 1]).toBe("ALL");
    const secIdx = args.indexOf("--security-opt");
    expect(args[secIdx + 1]).toBe("no-new-privileges:true");
  });

  it("applies cpu/memory/pids quotas with swap pinned to memory", () => {
    expect(args[args.indexOf("--pids-limit") + 1]).toBe(
      String(DEFAULT_SANDBOX_LIMITS.pidsLimit),
    );
    expect(args[args.indexOf("--memory") + 1]).toBe(
      `${DEFAULT_SANDBOX_LIMITS.memoryMb}m`,
    );
    expect(args[args.indexOf("--memory-swap") + 1]).toBe(
      `${DEFAULT_SANDBOX_LIMITS.memoryMb}m`,
    );
    expect(args[args.indexOf("--cpus") + 1]).toBe(
      String(DEFAULT_SANDBOX_LIMITS.cpus),
    );
  });

  it("mounts ONLY the named L2 volume (empty workspace, no host bind mounts)", () => {
    const volumeIndices = args
      .map((a, i) => (a === "--volume" || a === "-v" ? i : -1))
      .filter((i) => i >= 0);
    expect(volumeIndices).toHaveLength(1);
    expect(args[volumeIndices[0] + 1]).toBe("cinatra-exec-l2-run1:/workspace");
    expect(() => assertNoBindMounts(args)).not.toThrow();
  });

  it("egress none maps to --network none (kernel-level deny)", () => {
    expect(args[args.indexOf("--network") + 1]).toBe("none");
  });

  it("gateway egress attaches ONLY to the internal network and sets proxy env", () => {
    const gwArgs = buildHardenedRunArgs(baseSpec(gatewayEgress), {
      imageRef: "l0:test",
      containerName: "c",
    });
    expect(gwArgs[gwArgs.indexOf("--network") + 1]).toBe("cinatra-exec-internal");
    const joined = gwArgs.join("\n");
    expect(joined).toContain(
      "HTTPS_PROXY=http://job-abc:x@cinatra-exec-gateway:3128",
    );
    expect(joined).toContain(
      "HTTP_PROXY=http://job-abc:x@cinatra-exec-gateway:3128",
    );
  });

  it("scrubs the environment by omission — only the enumerated allowlist", () => {
    const env = sandboxEnvironment({ kind: "none" });
    expect(Object.keys(env).sort()).toEqual(
      [
        "HOME",
        "PATH",
        "PIP_CACHE_DIR",
        "PYTHONUSERBASE",
        "npm_config_cache",
        "npm_config_prefix",
      ].sort(),
    );
    // Nothing points outside the workspace.
    for (const value of Object.values(env)) {
      for (const segment of value.split(":")) {
        expect(
          segment.startsWith("/workspace") ||
            ["/usr/local/bin", "/usr/bin", "/bin"].includes(segment),
        ).toBe(true);
      }
    }
  });

  it("wraps the command with the per-file ulimit write cap", () => {
    const wrapped = wrapSandboxCommand("echo hi", 1024);
    expect(wrapped.startsWith("ulimit -f 1024 && ")).toBe(true);
    expect(wrapped).toContain("echo hi");
  });

  it("assertNoBindMounts rejects host paths and bind --mounts", () => {
    expect(() =>
      assertNoBindMounts(["--volume", "/etc:/workspace"]),
    ).toThrow(/bind mount/);
    expect(() =>
      assertNoBindMounts(["--volume", "./here:/workspace"]),
    ).toThrow(/bind mount/);
    expect(() =>
      assertNoBindMounts(["--mount", "type=bind,src=/,dst=/host"]),
    ).toThrow(/bind --mount/);
    expect(() =>
      assertNoBindMounts(["--volume", "named-vol:/workspace"]),
    ).not.toThrow();
  });

  it("container names are deterministic and docker-safe", () => {
    expect(containerNameFor("job/1:x", 3)).toBe("cinatra-exec-job-1-x-3");
  });
});

describe("assertSafeImageRef — docker option-injection guard", () => {
  it("accepts normal image references", () => {
    expect(assertSafeImageRef("cinatra-sandbox-l0:dev")).toBe("cinatra-sandbox-l0:dev");
    expect(assertSafeImageRef("registry.example.com/ns/img@sha256:" + "a".repeat(64))).toContain(
      "@sha256:",
    );
  });
  it("rejects option-like and metacharacter-bearing references", () => {
    expect(() => assertSafeImageRef("--privileged")).toThrow();
    expect(() => assertSafeImageRef("-v/etc:/etc")).toThrow();
    expect(() => assertSafeImageRef("img; rm -rf /")).toThrow();
    expect(() => assertSafeImageRef("img name")).toThrow();
  });
});

describe("buildHardenedRunArgs — argv separator", () => {
  it("inserts `--` before the image reference so it can never be read as an option", () => {
    const args = buildHardenedRunArgs(baseSpec({ kind: "none" }), {
      imageRef: "l0:test",
      containerName: "c",
    });
    const sepIdx = args.indexOf("--");
    const imgIdx = args.indexOf("l0:test");
    expect(sepIdx).toBeGreaterThan(-1);
    expect(imgIdx).toBe(sepIdx + 1);
  });
});
