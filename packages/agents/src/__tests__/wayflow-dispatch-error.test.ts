import { describe, it, expect } from "vitest";

import {
  describeWayflowDispatchError,
  normalizeWayflowRuntimeMode,
} from "../wayflow-url";

const URL = "http://localhost:8001/agents/cinatra/blog-idea-generator/";

function fetchFailedError(code = "ECONNREFUSED") {
  const cause = Object.assign(new Error(`connect ${code} 127.0.0.1:8001`), {
    code,
  });
  return Object.assign(new TypeError("fetch failed"), { cause });
}

describe("describeWayflowDispatchError (#562), mode-aware by recorded runtime", () => {
  it("rewrites a bare undici 'fetch failed' into an actionable message naming the URL + cause (default/local mode)", () => {
    const err = fetchFailedError();

    const out = describeWayflowDispatchError(err, URL);

    expect(out).toContain("Could not reach the agent runtime at");
    expect(out).toContain(URL);
    expect(out).toContain("ECONNREFUSED");
    // The dev remediation names the exact start command (#2654): a fresh dev
    // install never starts the profile-gated runtime, so the connectivity
    // failure must tell the operator how to start it.
    expect(out).toContain("cinatra instance wayflow start");
    // The CLI command is not on every released CLI yet — the message must
    // caveat it, not assert it unconditionally as a phantom command.
    expect(out).toContain("if your cinatra-cli has it");
    // The docker fallback must be complete and pinned to the live stack's
    // compose project, or it forks a separate `cinatra` project that can't
    // see the running network (the exact footgun this text used to cause).
    expect(out).toContain("-p cinatra_cinatra");
    expect(out).toContain("docker-compose.yml");
    expect(out).toContain("docker-compose.dev.yml");
    expect(out).toContain("--profile wayflow");
    // The bridge-token env file must be generated before compose comes up,
    // or the wayflow container refuses to boot.
    expect(out).toContain("gen-wayflow-env.mjs --require-bridge-token");
    // No longer the bare, undebuggable message.
    expect(out).not.toBe("fetch failed");
  });

  it("falls back to the cause message when no .code is present", () => {
    const cause = new Error("getaddrinfo ENOTFOUND wayflow.invalid");
    const err = Object.assign(new TypeError("fetch failed"), { cause });

    const out = describeWayflowDispatchError(err, URL);

    expect(out).toContain(URL);
    expect(out).toContain("getaddrinfo ENOTFOUND wayflow.invalid");
  });

  it("walks a nested cause chain to find the underlying code", () => {
    const inner = Object.assign(new Error("connect ETIMEDOUT"), {
      code: "ETIMEDOUT",
    });
    const mid = Object.assign(new Error("socket hang up"), { cause: inner });
    const err = Object.assign(new TypeError("fetch failed"), { cause: mid });

    const out = describeWayflowDispatchError(err, URL);

    expect(out).toContain("ETIMEDOUT");
  });

  it("still produces an actionable URL-bearing message when there is no cause at all", () => {
    const err = new TypeError("fetch failed");

    const out = describeWayflowDispatchError(err, URL);

    expect(out).toContain("Could not reach the agent runtime at");
    expect(out).toContain(URL);
    // No parenthetical reason when the cause is absent.
    expect(out).not.toContain("()");
  });

  it("passes through a non-'fetch failed' error verbatim (e.g. a WayFlow 500 / OpenAI 401)", () => {
    const msg =
      "401 Incorrect API key provided. You can find your API key at https://platform.openai.com/account/api-keys.";
    expect(describeWayflowDispatchError(new Error(msg), URL)).toBe(msg);
  });

  it("stringifies a non-Error throw", () => {
    expect(describeWayflowDispatchError("boom", URL)).toBe("boom");
  });

  describe("mode: off — deliberate opt-out", () => {
    const out = describeWayflowDispatchError(fetchFailedError(), URL, {
      runtimeMode: "off",
    });

    it("says the runtime is disabled for this install, not that it crashed", () => {
      expect(out).toContain("CINATRA_WAYFLOW_RUNTIME=off");
      expect(out).toContain("--no-wayflow");
    });

    it("still gives both recoveries: start it, or re-run install without the opt-out", () => {
      expect(out).toContain("cinatra instance wayflow start");
      expect(out).toContain("if your cinatra-cli has it");
      expect(out).toContain("without the");
      expect(out).toContain("opt-out");
    });

    it("gives the complete, project-pinned compose fallback", () => {
      expect(out).toContain("-p cinatra_cinatra");
      expect(out).toContain("--profile wayflow");
      expect(out).toContain("gen-wayflow-env.mjs --require-bridge-token");
    });
  });

  describe("mode: external — this install owns no local stack", () => {
    const out = describeWayflowDispatchError(fetchFailedError(), URL, {
      runtimeMode: "external",
    });

    it("names the env key pointing at the external runtime, not a local start command", () => {
      expect(out).toContain("CINATRA_WAYFLOW_RUNTIME=external");
      expect(out).toContain("WAYFLOW_BASE_URL");
    });

    it("never tells the operator to start a local container this install doesn't own", () => {
      expect(out).not.toContain("cinatra instance wayflow start");
      expect(out).not.toContain("docker compose");
    });
  });

  describe("mode: local (explicit) and legacy/unset — this install should own a runtime", () => {
    it("explicit local names the recorded mode", () => {
      const out = describeWayflowDispatchError(fetchFailedError(), URL, {
        runtimeMode: "local",
      });
      expect(out).toContain("CINATRA_WAYFLOW_RUNTIME=local");
    });

    it("an unset/unknown mode still produces the full local-style recovery (never silently excused)", () => {
      const out = describeWayflowDispatchError(fetchFailedError(), URL, {});
      expect(out).toContain("cinatra instance wayflow start");
      expect(out).toContain("-p cinatra_cinatra");
      expect(out).toContain("--profile wayflow");
      expect(out).toContain("gen-wayflow-env.mjs --require-bridge-token");
    });

    it("an unrecognized mode value normalizes to local rather than erroring", () => {
      const out = describeWayflowDispatchError(fetchFailedError(), URL, {
        runtimeMode: "banana",
      });
      expect(out).toContain("cinatra instance wayflow start");
    });
  });
});

describe("normalizeWayflowRuntimeMode", () => {
  it("passes through the three valid modes", () => {
    expect(normalizeWayflowRuntimeMode("local")).toBe("local");
    expect(normalizeWayflowRuntimeMode("off")).toBe("off");
    expect(normalizeWayflowRuntimeMode("external")).toBe("external");
  });

  it("is case/whitespace tolerant", () => {
    expect(normalizeWayflowRuntimeMode(" OFF \n")).toBe("off");
  });

  it("falls back to local for absent/unknown values", () => {
    expect(normalizeWayflowRuntimeMode(undefined)).toBe("local");
    expect(normalizeWayflowRuntimeMode(null)).toBe("local");
    expect(normalizeWayflowRuntimeMode("")).toBe("local");
    expect(normalizeWayflowRuntimeMode("banana")).toBe("local");
  });
});
