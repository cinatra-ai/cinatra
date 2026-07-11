import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Contract test for src/lib/otel-bootstrap.ts (OTel SDK 2.x shape).
//
// History: on the 1.x SDK this suite pinned an explicit `propagator: null`
// so BasicTracerProvider.register() could NOT fall back to the
// OTEL_PROPAGATORS default (`tracecontext,baggage`) — the 1.x
// W3CBaggagePropagator parse path carried advisory GHSA-8988-4f7v-96qf
// (unbounded allocation). The 2.x SDK ships the patched parser, so the
// bootstrap now deliberately RESTORES the SDK default when Sentry is off
// (the property is omitted), and this suite pins the new contract:
//
//   - Sentry ON  -> register() gets Sentry's propagator + context manager
//                   (never the SDK default).
//   - Sentry OFF -> register() gets NO propagator property at all (the 2.x
//                   register() then installs its default composite
//                   tracecontext+baggage propagator — both patched).
//   - Span processors are supplied via the 2.x constructor `spanProcessors`
//     array (provider.addSpanProcessor no longer exists): Postgres exporter
//     always, Sentry's processor appended when Sentry is on.
//   - The provider resource preserves the SDK default resource attributes
//     merged with the service name (2.x dropped the implicit default merge).
// ---------------------------------------------------------------------------

const registerMock = vi.fn();
const ctorOptionsSpy = vi.fn();

vi.mock("@opentelemetry/sdk-trace-node", () => ({
  NodeTracerProvider: class {
    constructor(options: unknown) {
      ctorOptionsSpy(options);
    }
    register = registerMock;
  },
}));

class FakeBatchSpanProcessor {
  constructor(public exporter: unknown) {}
}
vi.mock("@opentelemetry/sdk-trace-base", () => ({
  BatchSpanProcessor: FakeBatchSpanProcessor,
}));

// 2.x resources surface: defaultResource() + resourceFromAttributes(), and
// resources merge() rather than the removed Resource class.
const defaultResourceAttrs = {
  "telemetry.sdk.name": "opentelemetry",
  "telemetry.sdk.language": "nodejs",
};
function makeFakeResource(attrs: Record<string, unknown>) {
  return {
    attributes: attrs,
    merge(other: { attributes: Record<string, unknown> }) {
      return makeFakeResource({ ...attrs, ...other.attributes });
    },
  };
}
vi.mock("@opentelemetry/resources", () => ({
  defaultResource: () => makeFakeResource(defaultResourceAttrs),
  resourceFromAttributes: (attrs: Record<string, unknown>) =>
    makeFakeResource(attrs),
}));

vi.mock("@opentelemetry/semantic-conventions", () => ({
  ATTR_SERVICE_NAME: "service.name",
}));

class FakePostgresSpanExporter {}
vi.mock("@cinatra-ai/metric-cost-api", () => ({
  PostgresSpanExporter: FakePostgresSpanExporter,
}));

const sentryPropagatorInstance = { __kind: "SentryPropagator" };
const sentryContextManagerInstance = { __kind: "SentryAsyncLocalStorageContextManager" };
const sentryProcessorInstance = { __kind: "SentrySpanProcessor" };

vi.mock("@sentry/opentelemetry", () => ({
  SentrySampler: class {},
  SentrySpanProcessor: class {
    constructor() {
      return sentryProcessorInstance;
    }
  },
  SentryPropagator: class {
    constructor() {
      return sentryPropagatorInstance;
    }
  },
  SentryAsyncLocalStorageContextManager: class {
    constructor() {
      return sentryContextManagerInstance;
    }
  },
}));

const getClientMock = vi.fn();
vi.mock("@sentry/nextjs", () => ({
  getClient: getClientMock,
}));

async function importFreshBootstrap() {
  // The module memoizes `initialized`; reset the module registry so each test
  // re-runs initializeOtelTracing() from a clean state.
  vi.resetModules();
  return import("../otel-bootstrap");
}

type CtorOptions = {
  resource: { attributes: Record<string, unknown> };
  spanProcessors: unknown[];
};

describe("otel-bootstrap provider wiring (OTel SDK 2.x contract)", () => {
  const originalDsn = process.env.SENTRY_DSN;
  const originalRuntime = process.env.NEXT_RUNTIME;

  beforeEach(() => {
    registerMock.mockClear();
    ctorOptionsSpy.mockClear();
    getClientMock.mockReset();
    delete process.env.NEXT_RUNTIME; // ensure the nodejs path runs
  });

  afterEach(() => {
    if (originalDsn === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = originalDsn;
    if (originalRuntime === undefined) delete process.env.NEXT_RUNTIME;
    else process.env.NEXT_RUNTIME = originalRuntime;
  });

  it("omits the propagator when Sentry is disabled (SDK default tracecontext+baggage installs — patched in 2.x)", async () => {
    delete process.env.SENTRY_DSN;

    const { initializeOtelTracing } = await importFreshBootstrap();
    await initializeOtelTracing();

    expect(registerMock).toHaveBeenCalledTimes(1);
    const config = registerMock.mock.calls[0][0];
    // The property must be ABSENT (not present-as-null/undefined): omission is
    // what lets the 2.x register() install its patched default propagators,
    // and a
    // literal `propagator: undefined` would document the wrong intent.
    expect(config).toBeDefined();
    expect(config).not.toHaveProperty("propagator");
    expect(config).not.toHaveProperty("contextManager");
  });

  it("omits the propagator when SENTRY_DSN is set but no client is available", async () => {
    process.env.SENTRY_DSN = "https://abc@example.com/1";
    getClientMock.mockReturnValue(undefined);

    const { initializeOtelTracing } = await importFreshBootstrap();
    await initializeOtelTracing();

    expect(registerMock).toHaveBeenCalledTimes(1);
    const config = registerMock.mock.calls[0][0];
    expect(config).not.toHaveProperty("propagator");
  });

  it("uses the Sentry propagator + context manager (never the SDK default) when Sentry is active", async () => {
    process.env.SENTRY_DSN = "https://abc@example.com/1";
    getClientMock.mockReturnValue({ __kind: "SentryClient" });

    const { initializeOtelTracing } = await importFreshBootstrap();
    await initializeOtelTracing();

    expect(registerMock).toHaveBeenCalledTimes(1);
    const config = registerMock.mock.calls[0][0];
    expect(config.propagator).toBe(sentryPropagatorInstance);
    expect(config.contextManager).toBe(sentryContextManagerInstance);
  });

  it("supplies span processors via the 2.x constructor: Postgres exporter always, Sentry's appended when active", async () => {
    process.env.SENTRY_DSN = "https://abc@example.com/1";
    getClientMock.mockReturnValue({ __kind: "SentryClient" });

    const { initializeOtelTracing } = await importFreshBootstrap();
    await initializeOtelTracing();

    expect(ctorOptionsSpy).toHaveBeenCalledTimes(1);
    const options = ctorOptionsSpy.mock.calls[0][0] as CtorOptions;
    expect(Array.isArray(options.spanProcessors)).toBe(true);
    expect(options.spanProcessors).toHaveLength(2);
    const [postgresProcessor, sentryProcessor] = options.spanProcessors as [
      FakeBatchSpanProcessor,
      unknown,
    ];
    expect(postgresProcessor).toBeInstanceOf(FakeBatchSpanProcessor);
    expect(postgresProcessor.exporter).toBeInstanceOf(FakePostgresSpanExporter);
    expect(sentryProcessor).toBe(sentryProcessorInstance);
  });

  it("preserves the SDK default resource attributes merged with the service name (2.x dropped the implicit merge)", async () => {
    delete process.env.SENTRY_DSN;

    const { initializeOtelTracing } = await importFreshBootstrap();
    await initializeOtelTracing();

    expect(ctorOptionsSpy).toHaveBeenCalledTimes(1);
    const options = ctorOptionsSpy.mock.calls[0][0] as CtorOptions;
    // Default SDK attributes retained…
    expect(options.resource.attributes["telemetry.sdk.name"]).toBe("opentelemetry");
    expect(options.resource.attributes["telemetry.sdk.language"]).toBe("nodejs");
    // …and the service name is applied on top.
    expect(options.resource.attributes["service.name"]).toBe("cinatra-app");
    // Only the Postgres processor without Sentry.
    expect(options.spanProcessors).toHaveLength(1);
  });
});
