import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Security-contract test for src/lib/otel-bootstrap.ts.
//
// The OpenTelemetry 1.x BasicTracerProvider.register(config) installs a default
// global propagator from OTEL_PROPAGATORS (default `tracecontext,baggage`) when
// `config.propagator` is `undefined`. The `baggage` entry is a
// W3CBaggagePropagator whose parse path carries advisory GHSA-8988-4f7v-96qf
// (unbounded allocation, patched only in the 2.x SDK we don't yet ship).
//
// cinatra never extracts/propagates W3C baggage, so the bootstrap must pass an
// EXPLICIT propagator: Sentry's when available, otherwise `null` (which
// suppresses the default global propagator). These tests pin that contract so a
// future refactor can't silently reintroduce the vulnerable default.
// ---------------------------------------------------------------------------

const registerMock = vi.fn();
const addSpanProcessorMock = vi.fn();

vi.mock("@opentelemetry/sdk-trace-node", () => ({
  NodeTracerProvider: class {
    register = registerMock;
    addSpanProcessor = addSpanProcessorMock;
  },
}));

vi.mock("@opentelemetry/sdk-trace-base", () => ({
  BatchSpanProcessor: class {},
}));

vi.mock("@opentelemetry/resources", () => ({
  Resource: class {
    constructor(public attrs: Record<string, unknown>) {}
  },
}));

vi.mock("@opentelemetry/semantic-conventions", () => ({
  SemanticResourceAttributes: { SERVICE_NAME: "service.name" },
}));

vi.mock("@cinatra-ai/metric-cost-api", () => ({
  PostgresSpanExporter: class {},
}));

const sentryPropagatorInstance = { __kind: "SentryPropagator" };
const sentryContextManagerInstance = { __kind: "SentryAsyncLocalStorageContextManager" };

vi.mock("@sentry/opentelemetry", () => ({
  SentrySampler: class {},
  SentrySpanProcessor: class {},
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

describe("otel-bootstrap propagator hardening (GHSA-8988-4f7v-96qf)", () => {
  const originalDsn = process.env.SENTRY_DSN;
  const originalRuntime = process.env.NEXT_RUNTIME;

  beforeEach(() => {
    registerMock.mockClear();
    addSpanProcessorMock.mockClear();
    getClientMock.mockReset();
    delete process.env.NEXT_RUNTIME; // ensure the nodejs path runs
  });

  afterEach(() => {
    if (originalDsn === undefined) delete process.env.SENTRY_DSN;
    else process.env.SENTRY_DSN = originalDsn;
    if (originalRuntime === undefined) delete process.env.NEXT_RUNTIME;
    else process.env.NEXT_RUNTIME = originalRuntime;
  });

  it("passes propagator: null when Sentry is disabled (suppresses default W3C baggage propagator)", async () => {
    delete process.env.SENTRY_DSN;

    const { initializeOtelTracing } = await importFreshBootstrap();
    await initializeOtelTracing();

    expect(registerMock).toHaveBeenCalledTimes(1);
    const config = registerMock.mock.calls[0][0];
    // Must be an explicit object with propagator === null — NOT undefined and
    // NOT a missing/omitted key, either of which would trigger the SDK's
    // OTEL_PROPAGATORS default (which installs the vulnerable baggage parser).
    expect(config).toBeDefined();
    expect(config).toHaveProperty("propagator");
    expect(config.propagator).toBeNull();
  });

  it("passes propagator: null when SENTRY_DSN is set but no client is available", async () => {
    process.env.SENTRY_DSN = "https://abc@example.com/1";
    getClientMock.mockReturnValue(undefined);

    const { initializeOtelTracing } = await importFreshBootstrap();
    await initializeOtelTracing();

    expect(registerMock).toHaveBeenCalledTimes(1);
    const config = registerMock.mock.calls[0][0];
    expect(config.propagator).toBeNull();
  });

  it("uses the Sentry propagator (never the default baggage propagator) when Sentry is active", async () => {
    process.env.SENTRY_DSN = "https://abc@example.com/1";
    getClientMock.mockReturnValue({ __kind: "SentryClient" });

    const { initializeOtelTracing } = await importFreshBootstrap();
    await initializeOtelTracing();

    expect(registerMock).toHaveBeenCalledTimes(1);
    const config = registerMock.mock.calls[0][0];
    expect(config.propagator).toBe(sentryPropagatorInstance);
    expect(config.contextManager).toBe(sentryContextManagerInstance);
  });
});
