import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { rejectCrossOrigin } from "../admin-origin-guard";

const CANONICAL = "https://app.cinatra.ai";

function req(origin: string | null, url = `${CANONICAL}/api/admin/default-llm-provider`): Request {
  const headers = new Headers();
  if (origin !== null) headers.set("origin", origin);
  return new Request(url, { method: "PUT", headers });
}

describe("rejectCrossOrigin", () => {
  const ORIGINAL_ENV = { ...process.env };
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", CANONICAL);
    vi.stubEnv("NODE_ENV", "production");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    process.env = { ...ORIGINAL_ENV };
  });

  it("allows a request with no Origin header (same-origin / server-to-server)", () => {
    expect(rejectCrossOrigin(req(null))).toBeNull();
  });

  it("allows a same-origin request (Origin == canonical app origin)", () => {
    expect(rejectCrossOrigin(req(CANONICAL))).toBeNull();
  });

  it("rejects a cross-origin request with 403 and NO CORS headers", async () => {
    const res = rejectCrossOrigin(req("https://evil.test"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    // Critical: never reflect the attacker origin, never emit `*` with creds.
    expect(res!.headers.get("access-control-allow-origin")).toBeNull();
    expect(res!.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("never returns ACAO `*` with credentials for any cross-origin request", () => {
    const res = rejectCrossOrigin(req("https://attacker.example"));
    expect(res!.headers.get("access-control-allow-origin")).not.toBe("*");
  });

  it("in production, a localhost Origin is NOT same-origin -> rejected", () => {
    const res = rejectCrossOrigin(req("http://localhost:3000"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });

  it("in development, a localhost Origin on any port is allowed", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(rejectCrossOrigin(req("http://localhost:3000"))).toBeNull();
    expect(rejectCrossOrigin(req("http://localhost:4321"))).toBeNull();
    expect(rejectCrossOrigin(req("http://127.0.0.1:3000"))).toBeNull();
  });

  it("in development, a non-localhost cross-origin is still rejected", () => {
    vi.stubEnv("NODE_ENV", "development");
    const res = rejectCrossOrigin(req("https://evil.test"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
  });
});
