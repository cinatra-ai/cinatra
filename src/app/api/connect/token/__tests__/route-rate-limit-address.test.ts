import { beforeEach, describe, expect, it, vi } from "vitest";

// cinatra#4217 — POST /api/connect/token charges the SAME per-address bucket as
// the frame's sign-in and renewal (connect-rate-limit.ts), so it must key that
// bucket on the same address: the hop the platform appended to X-Forwarded-For
// (the LAST one), never a hop the caller wrote.
//
// RED BEFORE: the route keyed the bucket on the FIRST hop, so a forged hop
// naming another address charged that address's bucket, and with it that
// address's frame sign-ins and renewals.

const allowConnectTokenRequest = vi.fn();
const emitConnectAudit = vi.fn();

vi.mock("@/lib/connect-provisioning", () => ({
  CONNECT_SCOPE: "connect",
  exchangeAuthorizationCode: vi.fn(),
  exchangeInstallCode: vi.fn(),
  sha256Base64Url: (v: string) => `h(${v})`,
}));
vi.mock("@/lib/widget-auth-provider", () => ({ requireWordPressWidgetAuth: vi.fn() }));
vi.mock("@/lib/connect-rate-limit", () => ({
  allowConnectTokenRequest: (...a: unknown[]) => allowConnectTokenRequest(...a),
}));
vi.mock("@/lib/connect-audit", () => ({
  emitConnectAudit: (...a: unknown[]) => emitConnectAudit(...a),
}));

import { POST as connectToken } from "../route";

const CLIENT = "2001:db8::9";
const VICTIM = "2001:db8::5";

function tokenRequest(body: Record<string, unknown>, xff: string) {
  return new Request("https://app.cinatra.test/api/connect/token", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": xff },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Refuse at the limiter: the address it was asked about is the whole question.
  allowConnectTokenRequest.mockReturnValue(false);
});

describe("POST /api/connect/token — the per-address bucket (cinatra#4217)", () => {
  it.each([
    ["authorization_code", { grant_type: "authorization_code", code: "c", client: "wordpress" }],
    ["install_code", { grant_type: "install_code", install_code: "i", client: "wordpress" }],
  ])("%s: forged first hops charge the client's own address, never the one they name", async (_g, body) => {
    for (const xff of [`${VICTIM}, ${CLIENT}`, `2001:db8::a1, 2001:db8::a2, ${CLIENT}`]) {
      const res = await connectToken(tokenRequest(body, xff));
      expect(res.status).toBe(429);
    }
    const ips = allowConnectTokenRequest.mock.calls.map((c) => (c[0] as { ip: string }).ip);
    expect(ips).toEqual([CLIENT, CLIENT]);
    expect(JSON.stringify(emitConnectAudit.mock.calls)).not.toContain(VICTIM);
  });
});
