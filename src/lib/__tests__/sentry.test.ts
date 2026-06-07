import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// shouldInitSentry / buildSentryClientOptions / beforeSendFilter live in the
// runtime-safe @cinatra-ai/errors main (no server-only) so the runtime
// config files can import them from browser/edge bundles. The server-only
// surface (@cinatra-ai/errors/server) re-exports them too.
//
// Sentry lives in packages/errors/. The shims `@/lib/sentry-shared` /
// `@/lib/sentry` still re-export, but for clarity the tests point directly at
// the package entry points.
import {
  beforeBreadcrumbFilter,
  beforeSendFilter,
  buildSentryClientOptions,
  shouldInitSentry,
} from "@cinatra-ai/errors";
import { withSentryServerAction } from "@cinatra-ai/errors/server";

// Mock @sentry/nextjs once, then control its behavior per-test via vi.mocked().
vi.mock("@sentry/nextjs", () => ({
  captureException: vi.fn(),
}));

describe("shouldInitSentry", () => {
  const originalDsn = process.env.SENTRY_DSN;
  const originalPublicDsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

  afterEach(() => {
    if (originalDsn === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = originalDsn;
    if (originalPublicDsn === undefined) delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    else process.env.NEXT_PUBLIC_SENTRY_DSN = originalPublicDsn;
  });

  it("returns false when SENTRY_DSN is unset", () => {
    delete process.env.SENTRY_DSN;
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    expect(shouldInitSentry()).toBe(false);
  });

  it("returns false when SENTRY_DSN is empty", () => {
    process.env.SENTRY_DSN = "";
    delete process.env.NEXT_PUBLIC_SENTRY_DSN;
    expect(shouldInitSentry()).toBe(false);
  });

  it("returns true when SENTRY_DSN is set", () => {
    process.env.SENTRY_DSN = "https://abc@example.com/1";
    expect(shouldInitSentry()).toBe(true);
  });

  it("returns true when only NEXT_PUBLIC_SENTRY_DSN is set (browser path)", () => {
    delete process.env.SENTRY_DSN;
    process.env.NEXT_PUBLIC_SENTRY_DSN = "https://pub@example.com/2";
    expect(shouldInitSentry()).toBe(true);
  });
});

describe("buildSentryClientOptions", () => {
  const originals: Record<string, string | undefined> = {
    SENTRY_DSN: process.env.SENTRY_DSN,
    SENTRY_ENVIRONMENT: process.env.SENTRY_ENVIRONMENT,
    SENTRY_TRACES_SAMPLE_RATE: process.env.SENTRY_TRACES_SAMPLE_RATE,
    NODE_ENV: process.env.NODE_ENV,
  };

  beforeEach(() => {
    process.env.SENTRY_DSN = "https://abc@example.com/1";
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(originals)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("sets skipOpenTelemetrySetup on node runtime", () => {
    const opts = buildSentryClientOptions({ runtime: "node" });
    expect(opts.skipOpenTelemetrySetup).toBe(true);
  });

  it("does not set skipOpenTelemetrySetup on edge runtime", () => {
    const opts = buildSentryClientOptions({ runtime: "edge" });
    expect(opts.skipOpenTelemetrySetup).toBeUndefined();
  });

  it("does not set skipOpenTelemetrySetup on browser runtime", () => {
    const opts = buildSentryClientOptions({ runtime: "browser" });
    expect(opts.skipOpenTelemetrySetup).toBeUndefined();
  });

  it("clamps tracesSampleRate to [0, 1]", () => {
    process.env.SENTRY_TRACES_SAMPLE_RATE = "5";
    expect(buildSentryClientOptions({ runtime: "node" }).tracesSampleRate).toBe(1);
    process.env.SENTRY_TRACES_SAMPLE_RATE = "-1";
    expect(buildSentryClientOptions({ runtime: "node" }).tracesSampleRate).toBe(0);
  });

  it("falls back when SENTRY_TRACES_SAMPLE_RATE is non-numeric", () => {
    process.env.SENTRY_TRACES_SAMPLE_RATE = "not-a-number";
    expect(buildSentryClientOptions({ runtime: "node" }).tracesSampleRate).toBe(0.1);
    expect(
      buildSentryClientOptions({ runtime: "browser" }).tracesSampleRate,
    ).toBe(0);
  });

  it("uses SENTRY_ENVIRONMENT when present", () => {
    process.env.SENTRY_ENVIRONMENT = "staging";
    expect(buildSentryClientOptions({ runtime: "node" }).environment).toBe(
      "staging",
    );
  });
});

describe("beforeSendFilter — PII scrubbing", () => {
  it("redacts authorization, cookie, set-cookie, and x-* secret headers", () => {
    const event = {
      request: {
        headers: {
          authorization: "Bearer abc",
          Cookie: "session=xyz",
          "Set-Cookie": "cleartext",
          "X-Api-Key": "secret-key",
          "X-Auth-Token": "secret-token",
          "user-agent": "vitest",
        },
      },
    } as Parameters<typeof beforeSendFilter>[0];
    const filtered = beforeSendFilter(event);
    const headers = filtered.request!.headers!;
    expect(headers.authorization).toBe("[Filtered]");
    expect(headers["Cookie"]).toBe("[Filtered]");
    expect(headers["Set-Cookie"]).toBe("[Filtered]");
    expect(headers["X-Api-Key"]).toBe("[Filtered]");
    expect(headers["X-Auth-Token"]).toBe("[Filtered]");
    expect(headers["user-agent"]).toBe("vitest");
  });

  it("redacts secret-keyed body fields including nested objects", () => {
    const event = {
      request: {
        data: {
          username: "alice",
          password: "hunter2",
          nested: {
            apiKey: "1234",
            ok: true,
            deeper: { accessToken: "tok-deep" },
          },
          list: [{ refreshToken: "rfsh-1" }, { privateKey: "pk" }],
        },
      },
    } as Parameters<typeof beforeSendFilter>[0];
    const filtered = beforeSendFilter(event) as typeof event;
    const data = filtered.request!.data as Record<string, unknown>;
    expect(data.username).toBe("alice");
    expect(data.password).toBe("[Filtered]");
    const nested = data.nested as Record<string, unknown>;
    expect(nested.apiKey).toBe("[Filtered]");
    expect(nested.ok).toBe(true);
    expect((nested.deeper as Record<string, unknown>).accessToken).toBe(
      "[Filtered]",
    );
    const list = data.list as Array<Record<string, unknown>>;
    expect(list[0].refreshToken).toBe("[Filtered]");
    expect(list[1].privateKey).toBe("[Filtered]");
  });

  it("redacts cookies entirely on the request shape", () => {
    const event = {
      request: { cookies: { sid: "abc" } },
    } as Parameters<typeof beforeSendFilter>[0];
    const filtered = beforeSendFilter(event);
    expect(filtered.request!.cookies).toBe("[Filtered]");
  });

  it("retains only allowlisted keys on event.user", () => {
    const event = {
      user: {
        id: "u_1",
        email: "a@b.com",
        username: "alice",
        ip_address: "1.2.3.4",
        someExtra: "leaked",
      },
    } as Parameters<typeof beforeSendFilter>[0];
    const filtered = beforeSendFilter(event);
    expect(filtered.user).toEqual({
      id: "u_1",
      email: "a@b.com",
      username: "alice",
      ip_address: "1.2.3.4",
    });
  });

  it("redacts JSON-stringified bodies (e.g. captured raw POST body)", () => {
    const event = {
      request: {
        data: JSON.stringify({
          username: "alice",
          password: "hunter2",
          nested: { apiKey: "abc" },
        }),
      },
    } as Parameters<typeof beforeSendFilter>[0];
    const filtered = beforeSendFilter(event);
    const data = filtered.request!.data as string;
    expect(typeof data).toBe("string");
    const reparsed = JSON.parse(data);
    expect(reparsed.username).toBe("alice");
    expect(reparsed.password).toBe("[Filtered]");
    expect(reparsed.nested.apiKey).toBe("[Filtered]");
  });

  it("leaves non-JSON-looking strings alone", () => {
    const event = {
      request: { data: "plain text password=hunter2" },
    } as Parameters<typeof beforeSendFilter>[0];
    const filtered = beforeSendFilter(event);
    // The string body shape isn't recognised JSON; it stays verbatim. Caller
    // patterns that put secrets in plain bodies still need to be reviewed
    // case-by-case at the integration site.
    expect(filtered.request!.data).toBe("plain text password=hunter2");
  });

  it("filters breadcrumb data with the same rules", () => {
    const event = {
      breadcrumbs: [
        { data: { password: "p", ok: 1 } },
        { data: undefined },
      ],
    } as unknown as Parameters<typeof beforeSendFilter>[0];
    const filtered = beforeSendFilter(event);
    expect(filtered.breadcrumbs![0].data).toEqual({
      password: "[Filtered]",
      ok: 1,
    });
    expect(filtered.breadcrumbs![1].data).toBeUndefined();
  });
});

describe("beforeBreadcrumbFilter", () => {
  it("scrubs data on breadcrumbs", () => {
    const out = beforeBreadcrumbFilter({
      data: { secret: "x", ok: "y" },
    }) as { data: Record<string, unknown> };
    expect(out.data.secret).toBe("[Filtered]");
    expect(out.data.ok).toBe("y");
  });

  it("passes through breadcrumbs without data", () => {
    const out = beforeBreadcrumbFilter({});
    expect(out).toEqual({});
  });
});

describe("withSentryServerAction", () => {
  it("returns the action's result when it succeeds", async () => {
    const result = await withSentryServerAction(async () => "ok");
    expect(result).toBe("ok");
  });

  it("captures the error AND re-throws it (no swallow)", async () => {
    process.env.SENTRY_DSN = "https://abc@example.com/1";
    // Force-reload the server module so the cached `_sentry` namespace inside
    // ../sentry.ts re-resolves with the now-set DSN.
    vi.resetModules();
    const { withSentryServerAction: freshHelper } = await import(
      "@cinatra-ai/errors/server"
    );
    const sentry = await import("@sentry/nextjs");
    const captureSpy = vi.mocked(sentry.captureException);
    captureSpy.mockClear();

    const boom = new Error("boom");
    await expect(
      freshHelper(async () => {
        throw boom;
      }, { actionName: "test-action" }),
    ).rejects.toBe(boom);

    expect(captureSpy).toHaveBeenCalledTimes(1);
    const [thrown, options] = captureSpy.mock.calls[0]!;
    expect(thrown).toBe(boom);
    expect(options).toMatchObject({
      tags: {
        component: "server-action",
        actionName: "test-action",
      },
    });
  });

  it("re-throws even when SENTRY_DSN is unset (no capture, no swallow)", async () => {
    delete process.env.SENTRY_DSN;
    const boom = new Error("no-dsn-boom");
    await expect(
      withSentryServerAction(async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });
});
