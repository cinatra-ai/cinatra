// wayflow-reload-client unit tests.

import { describe, expect, it, vi } from "vitest";

import {
  triggerWayflowReload,
  type ReloadResult,
} from "../wayflow-reload-client";

function _makeFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  return vi.fn(impl) as unknown as typeof fetch;
}

describe("triggerWayflowReload", () => {
  it("returns no_base_url when WAYFLOW_BASE_URL is empty", async () => {
    const result = await triggerWayflowReload({
      baseUrl: "",
      bridgeToken: "any",
    });
    expect(result).toEqual({ ok: false, reason: "no_base_url" });
  });

  it("returns no_token when CINATRA_BRIDGE_TOKEN is empty or whitespace", async () => {
    const r1 = await triggerWayflowReload({
      baseUrl: "http://wayflow:3010",
      bridgeToken: "",
    });
    expect(r1).toEqual({ ok: false, reason: "no_token" });

    const r2 = await triggerWayflowReload({
      baseUrl: "http://wayflow:3010",
      bridgeToken: "   \t  ",
    });
    expect(r2).toEqual({ ok: false, reason: "no_token" });
  });

  it("happy path: POSTs to /.internal/reload-agents with the bridge token", async () => {
    const fetchSpy = _makeFetch(async (url, init) => {
      expect(url).toBe("http://wayflow:3010/.internal/reload-agents");
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers["X-Cinatra-Bridge-Token"]).toBe("secret-token");
      expect(init?.method).toBe("POST");
      return new Response(
        JSON.stringify({
          added: ["cinatra/new"],
          changed: [],
          removed: [],
          failed: [],
          agents: 1,
          last_reload_at: "2026-05-12T22:00:00+00:00",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    const result = await triggerWayflowReload({
      baseUrl: "http://wayflow:3010",
      bridgeToken: "secret-token",
      fetchImpl: fetchSpy,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.added).toEqual(["cinatra/new"]);
    expect(result.report.agents).toBe(1);
  });

  it("normalizes trailing slashes on baseUrl", async () => {
    let observedUrl = "";
    const fetchSpy = _makeFetch(async (url) => {
      observedUrl = String(url);
      return new Response(
        JSON.stringify({
          added: [],
          changed: [],
          removed: [],
          failed: [],
          agents: 0,
          last_reload_at: null,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    await triggerWayflowReload({
      baseUrl: "http://wayflow:3010///",
      bridgeToken: "tok",
      fetchImpl: fetchSpy,
    });
    expect(observedUrl).toBe("http://wayflow:3010/.internal/reload-agents");
  });

  it("returns http_error on 403", async () => {
    const fetchSpy = _makeFetch(async () => {
      return new Response("{}", { status: 403 });
    });
    const result = await triggerWayflowReload({
      baseUrl: "http://wayflow:3010",
      bridgeToken: "wrong",
      fetchImpl: fetchSpy,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("http_error");
    expect(result.detail).toBe("HTTP 403");
  });

  it("returns timeout when AbortController fires", async () => {
    const fetchSpy = _makeFetch(async (_url, init) => {
      // Honor the abort signal — simulate a slow response.
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const abortErr = new Error("aborted") as Error & { name: string };
          abortErr.name = "AbortError";
          reject(abortErr);
        });
      });
    });
    const result = await triggerWayflowReload({
      baseUrl: "http://wayflow:3010",
      bridgeToken: "tok",
      fetchImpl: fetchSpy,
      timeoutMs: 50,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("timeout");
  });

  it("returns network on connect failure", async () => {
    const fetchSpy = _makeFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = await triggerWayflowReload({
      baseUrl: "http://wayflow:3010",
      bridgeToken: "tok",
      fetchImpl: fetchSpy,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("network");
    expect(result.detail).toBe("ECONNREFUSED");
  });

  it("returns http_error when body is non-JSON", async () => {
    const fetchSpy = _makeFetch(async () => {
      return new Response("not json {", { status: 200 });
    });
    const result = await triggerWayflowReload({
      baseUrl: "http://wayflow:3010",
      bridgeToken: "tok",
      fetchImpl: fetchSpy,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("http_error");
    expect(result.detail).toMatch(/parse failure/);
  });

  it("never throws — every error path returns a result", async () => {
    const fetchSpy = _makeFetch(async () => {
      throw "string error not Error subclass" as unknown as Error;
    });
    const result: ReloadResult = await triggerWayflowReload({
      baseUrl: "http://wayflow:3010",
      bridgeToken: "tok",
      fetchImpl: fetchSpy,
    });
    expect(result.ok).toBe(false);
  });
});
