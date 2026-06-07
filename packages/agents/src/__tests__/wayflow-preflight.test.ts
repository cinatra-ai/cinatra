/**
 * Tests for `preflightWayflowAgent` — the WayFlow agent-card probe that
 * gates `agent_run` dispatch so freshly published Verdaccio packages don't
 * silently dispatch a BullMQ job that fails ~60s later with a 404.
 *
 * Failure semantics covered:
 *   - WayFlow returns 404 → WAYFLOW_AGENT_NOT_REGISTERED (surfaced verbatim
 *     to the chat assistant; no BullMQ job created)
 *   - WayFlow returns 200/5xx/4xx-non-404 → OK (proceed with normal
 *     dispatch; BullMQ worker handles transient runtime issues)
 *   - WAYFLOW_BASE_URL unset / malformed packageName → WAYFLOW_NOT_CONFIGURED
 *     (deterministic config failure; short-circuit so the chat surfaces an
 *     actionable error instead of creating a doomed run row)
 *   - fetch timeout / network error → PREFLIGHT_UNAVAILABLE (proceed;
 *     preflight should not block dispatch on transient probe failures)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  preflightWayflowAgent,
  WAYFLOW_PREFLIGHT_TIMEOUT_MS,
} from "../wayflow-preflight";

const ORIGINAL_BASE_URL = process.env.WAYFLOW_BASE_URL;

describe("preflightWayflowAgent", () => {
  beforeEach(() => {
    process.env.WAYFLOW_BASE_URL = "http://localhost:3010";
  });

  afterEach(() => {
    if (ORIGINAL_BASE_URL === undefined) {
      delete process.env.WAYFLOW_BASE_URL;
    } else {
      process.env.WAYFLOW_BASE_URL = ORIGINAL_BASE_URL;
    }
    vi.restoreAllMocks();
  });

  it("returns WAYFLOW_AGENT_NOT_REGISTERED when the agent-card endpoint returns 404 AND reload-recovery also fails", async () => {
    // CINATRA_BRIDGE_TOKEN unset → reload is skipped with reason "no_token".
    delete process.env.CINATRA_BRIDGE_TOKEN;
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe(
        "http://localhost:3010/agents/cinatra/publish-preflight-test/.well-known/agent-card.json",
      );
      return { status: 404 };
    });

    const result = await preflightWayflowAgent(
      "@cinatra/publish-preflight-test",
      { fetchImpl },
    );

    expect(result.code).toBe("WAYFLOW_AGENT_NOT_REGISTERED");
    if (result.code !== "WAYFLOW_AGENT_NOT_REGISTERED") return;
    expect(result.packageName).toBe("@cinatra/publish-preflight-test");
    expect(result.expectedUrl).toBe(
      "http://localhost:3010/agents/cinatra/publish-preflight-test/.well-known/agent-card.json",
    );
    expect(result.error).toContain("not registered with the WayFlow runtime");
    // The error should not recommend a full WayFlow container restart as the
    // primary remedy. It should surface the reload-attempt outcome plus the
    // likely causes: stale runtime image, tarball missing oas.json, or parse
    // failure.
    expect(result.error).toContain("auto-recovery attempted a reload");
    expect(result.error).toMatch(/build wayflow.*force-recreate wayflow/);
    expect(result.reloadAttempt).toBeDefined();
    if (result.reloadAttempt && result.reloadAttempt.ok === false) {
      expect(result.reloadAttempt.reason).toBe("no_token");
    }
  });

  it("auto-recovers via reload+retry when 404 resolves after a reload", async () => {
    process.env.CINATRA_BRIDGE_TOKEN = "test-bridge-token";
    // Stub global fetch (triggerWayflowReload uses it for the reload POST).
    const realFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url: unknown) => {
      const s = String(url);
      if (s.endsWith("/.internal/reload-agents")) {
        return new Response(
          JSON.stringify({
            added: ["cinatra/reload-recovery-test"],
            changed: [],
            removed: [],
            failed: [],
            agents: 1,
            last_reload_at: "2026-05-12T22:00:00+00:00",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`unexpected global fetch: ${s}`);
    }) as typeof fetch;

    // fetchImpl (probe path): first call 404, second call 200 (post-reload).
    let probeCount = 0;
    const fetchImpl = vi.fn(async () => {
      probeCount += 1;
      return { status: probeCount === 1 ? 404 : 200 };
    });

    const result = await preflightWayflowAgent(
      "@cinatra/reload-recovery-test",
      { fetchImpl },
    );

    globalThis.fetch = realFetch;
    delete process.env.CINATRA_BRIDGE_TOKEN;

    expect(result.code).toBe("OK");
    if (result.code !== "OK") return;
    expect(result.recoveredViaReload).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns OK when the agent-card endpoint returns 200", async () => {
    const fetchImpl = vi.fn(async () => ({ status: 200 }));
    const result = await preflightWayflowAgent("@cinatra-ai/email-test-delivery-agent", {
      fetchImpl,
    });
    expect(result).toEqual({ code: "OK" });
  });

  it("returns OK for non-404 error statuses (5xx) — preflight should not block dispatch on runtime hiccups", async () => {
    for (const status of [500, 502, 503]) {
      const fetchImpl = vi.fn(async () => ({ status }));
      const result = await preflightWayflowAgent("@cinatra/some-agent", {
        fetchImpl,
      });
      expect(result.code).toBe("OK");
    }
  });

  it("returns OK for non-404 4xx statuses other than 404 (e.g. 401/403 — auth issues are not 'not registered')", async () => {
    for (const status of [401, 403]) {
      const fetchImpl = vi.fn(async () => ({ status }));
      const result = await preflightWayflowAgent("@cinatra/some-agent", {
        fetchImpl,
      });
      expect(result.code).toBe("OK");
    }
  });

  it("returns PREFLIGHT_UNAVAILABLE when fetch throws a network error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:3010");
    });

    const result = await preflightWayflowAgent("@cinatra-ai/email-test-delivery-agent", {
      fetchImpl,
    });

    expect(result.code).toBe("PREFLIGHT_UNAVAILABLE");
    if (result.code !== "PREFLIGHT_UNAVAILABLE") return;
    expect(result.reason).toContain("ECONNREFUSED");
  });

  it("returns PREFLIGHT_UNAVAILABLE when fetch times out (AbortError)", async () => {
    const fetchImpl = vi.fn(
      async (_url: string, init: { signal: AbortSignal }) =>
        new Promise<{ status: number }>((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
          // never resolves
        }),
    );

    const result = await preflightWayflowAgent("@cinatra-ai/email-test-delivery-agent", {
      fetchImpl,
      timeoutMs: 50,
    });

    expect(result.code).toBe("PREFLIGHT_UNAVAILABLE");
  });

  it("returns WAYFLOW_NOT_CONFIGURED when WAYFLOW_BASE_URL is not set", async () => {
    delete process.env.WAYFLOW_BASE_URL;
    const fetchImpl = vi.fn();

    const result = await preflightWayflowAgent("@cinatra-ai/email-test-delivery-agent", {
      fetchImpl,
    });

    expect(result.code).toBe("WAYFLOW_NOT_CONFIGURED");
    if (result.code !== "WAYFLOW_NOT_CONFIGURED") return;
    expect(result.reason).toContain("WAYFLOW_BASE_URL");
    expect(result.error).toContain("WayFlow is not configured");
    expect(result.error).toContain("@cinatra-ai/email-test-delivery-agent");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns WAYFLOW_NOT_CONFIGURED when packageName is malformed", async () => {
    const fetchImpl = vi.fn();

    const result = await preflightWayflowAgent("not-a-scoped-name", {
      fetchImpl,
    });

    expect(result.code).toBe("WAYFLOW_NOT_CONFIGURED");
    if (result.code !== "WAYFLOW_NOT_CONFIGURED") return;
    expect(result.reason).toContain("strict @vendor/slug pattern");
    expect(result.error).toContain("WayFlow is not configured");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns PREFLIGHT_UNAVAILABLE when timeout fires before fetch resolves (Promise.race robustness)", async () => {
    // Custom fetchImpl that NEVER resolves/rejects — exercises the
    // Promise.race timeout path that is robust to fetch impls ignoring
    // the AbortSignal (mocks, polyfills).
    const fetchImpl = vi.fn(
      () => new Promise<{ status: number }>(() => undefined),
    );

    const result = await preflightWayflowAgent("@cinatra-ai/email-test-delivery-agent", {
      fetchImpl,
      timeoutMs: 25,
    });

    expect(result.code).toBe("PREFLIGHT_UNAVAILABLE");
    if (result.code !== "PREFLIGHT_UNAVAILABLE") return;
    expect(result.reason).toContain("timeout");
  });

  it("strips trailing slashes from WAYFLOW_BASE_URL so the probe URL has no double-slash", async () => {
    process.env.WAYFLOW_BASE_URL = "http://localhost:3010///";
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe(
        "http://localhost:3010/agents/cinatra/test/.well-known/agent-card.json",
      );
      return { status: 200 };
    });

    await preflightWayflowAgent("@cinatra/test", { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("exposes WAYFLOW_PREFLIGHT_TIMEOUT_MS as a stable constant", () => {
    expect(WAYFLOW_PREFLIGHT_TIMEOUT_MS).toBe(2000);
  });
});
