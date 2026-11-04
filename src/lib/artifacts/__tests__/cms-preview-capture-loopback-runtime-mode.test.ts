/**
 * The preview reader takes a plain-http LOOPBACK preview without the shared
 * egress check only while the instance runs in development mode. The runtime
 * mode decides that (`CINATRA_RUNTIME_MODE`, then `APP_RUNTIME_MODE`, then the
 * build), not the build alone: a production build that its operator runs in
 * development mode reads a local preview, and an instance in production mode
 * never does. Every other address still goes through the egress check.
 *
 * The egress check is replaced by one that always refuses, so a case that
 * reaches it reads `egress-blocked`; `fetch` is stubbed, so no case opens a
 * connection. Every case sets all three environment keys, so the shell's own
 * runtime mode never leaks into a reading.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const egress = vi.hoisted(() => ({
  assertEgressAllowed: vi.fn(async (): Promise<never> => {
    throw new Error("the egress check refuses every address in this suite");
  }),
}));

vi.mock("@cinatra-ai/webhooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@cinatra-ai/webhooks")>();
  return { ...actual, assertEgressAllowed: egress.assertEgressAllowed };
});

import { fetchPreviewGuarded } from "../cms-preview-capture";

const PAGE = "<html><body><p>staged</p></body></html>";
const LOOPBACK_PREVIEW = "http://localhost:8080/?preview=1";

function pageFetch() {
  return vi.fn(
    async () => new Response(PAGE, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }),
  );
}

let fetchMock: ReturnType<typeof pageFetch>;

function setMode(env: { nodeEnv: string; cinatraMode?: string; appMode?: string }): void {
  vi.stubEnv("NODE_ENV", env.nodeEnv);
  vi.stubEnv("CINATRA_RUNTIME_MODE", env.cinatraMode ?? "");
  vi.stubEnv("APP_RUNTIME_MODE", env.appMode ?? "");
}

function read(url: string) {
  return fetchPreviewGuarded({ url, headers: { accept: "text/html" }, timeoutMs: 5_000 });
}

beforeEach(() => {
  fetchMock = pageFetch();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("the preview reader's loopback origin follows the runtime mode", () => {
  it("reads an http localhost preview on a production build that runs in development mode", async () => {
    setMode({ nodeEnv: "production", cinatraMode: "development" });
    const result = await read(LOOPBACK_PREVIEW);
    expect(result).toMatchObject({ ok: true, html: PAGE });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(egress.assertEgressAllowed).not.toHaveBeenCalled();
  });

  it("reads an http localhost preview on a production build whose APP_RUNTIME_MODE reads dev", async () => {
    setMode({ nodeEnv: "production", appMode: "dev" });
    const result = await read(LOOPBACK_PREVIEW);
    expect(result).toMatchObject({ ok: true, html: PAGE });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(egress.assertEgressAllowed).not.toHaveBeenCalled();
  });

  it("refuses an http localhost preview in production mode on a development build", async () => {
    setMode({ nodeEnv: "development", cinatraMode: "production" });
    const result = await read(LOOPBACK_PREVIEW);
    expect(result).toEqual({ ok: false, reason: "egress-blocked" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an http localhost preview on a production build with no runtime-mode declaration", async () => {
    setMode({ nodeEnv: "production" });
    const result = await read(LOOPBACK_PREVIEW);
    expect(result).toEqual({ ok: false, reason: "egress-blocked" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads an http localhost preview on a development build with no runtime-mode declaration", async () => {
    setMode({ nodeEnv: "development" });
    const result = await read(LOOPBACK_PREVIEW);
    expect(result).toMatchObject({ ok: true, html: PAGE });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(egress.assertEgressAllowed).not.toHaveBeenCalled();
  });

  it("sends a non-loopback http address through the egress guard in development mode", async () => {
    setMode({ nodeEnv: "production", cinatraMode: "development" });
    const result = await read("http://preview.example/?preview=1");
    expect(result).toEqual({ ok: false, reason: "egress-blocked" });
    expect(egress.assertEgressAllowed).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends an https localhost address through the egress guard in development mode", async () => {
    setMode({ nodeEnv: "production", cinatraMode: "development" });
    const result = await read("https://localhost:8443/?preview=1");
    expect(result).toEqual({ ok: false, reason: "egress-blocked" });
    expect(egress.assertEgressAllowed).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
