import { describe, it, expect } from "vitest";

import { describeWayflowDispatchError } from "../wayflow-url";

const URL = "http://localhost:8001/agents/cinatra/blog-idea-generator/";

describe("describeWayflowDispatchError (#562)", () => {
  it("rewrites a bare undici 'fetch failed' into an actionable message naming the URL + cause", () => {
    // Shape of an undici connectivity failure: TypeError('fetch failed') whose
    // `.cause` is the connect error carrying `.code`.
    const cause = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8001"), {
      code: "ECONNREFUSED",
    });
    const err = Object.assign(new TypeError("fetch failed"), { cause });

    const out = describeWayflowDispatchError(err, URL);

    expect(out).toContain("Could not reach the agent runtime at");
    expect(out).toContain(URL);
    expect(out).toContain("ECONNREFUSED");
    // The dev remediation names the exact start command (#2654): a fresh dev
    // install never starts the profile-gated runtime, so the connectivity
    // failure must tell the operator how to start it.
    expect(out).toContain("cinatra instance wayflow start");
    // The CLI command is only real on cinatra-cli newer than the last
    // release (v0.1.8 lacks it) — the message must caveat it, not assert it
    // unconditionally as a phantom command.
    expect(out).toContain("newer than v0.1.8");
    // The docker fallback must be complete and pinned to the live stack's
    // compose project, or it forks a separate `cinatra` project that can't
    // see the running network (the exact footgun this text used to cause).
    expect(out).toContain("-p cinatra_cinatra");
    expect(out).toContain("docker-compose.yml");
    expect(out).toContain("docker-compose.dev.yml");
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
});
