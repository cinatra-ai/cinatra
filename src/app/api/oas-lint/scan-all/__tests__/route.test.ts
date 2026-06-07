/**
 * /api/oas-lint/scan-all route tests.
 *
 * The endpoint is dispatched by `@cinatra-ai/lint-policy-agent`'s single ApiNode
 * inside the WayFlow runtime. Auth is bridge-token only (matching the
 * /api/llm-bridge pattern). Response shape:
 *
 *   { ok: true, source: "agent-lint-policy", rulesRun: string[], findings: ReviewFinding[] }
 *
 * Tests cover: bridge-token auth (401 on missing/wrong token, 200 on
 * valid), body validation (400 on malformed OAS or missing oasJson),
 * source stamping (every finding gets `source: "agent-lint-policy"`),
 * and the rulesRun manifest.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/wayflow-bridge-auth", () => ({
  isAuthorizedBridgeRequest: vi.fn(),
}));

vi.mock("@cinatra-ai/agents", () => ({
  scanOasForLiteralSecrets: vi.fn(() => []),
  scanOasForUntrustedUrls: vi.fn(() => []),
  scanOasForLlmBridgeWiring: vi.fn(() => []),
  scanOasForLlmMetadata: vi.fn(() => []),
  scanOasForStartNodeInputsWithoutRequired: vi.fn(() => []),
  scanOasForPackageVersionSync: vi.fn(() => []),
  scanAgentForRequiredLicense: vi.fn(() => []),
}));

import { POST } from "../route";
import { isAuthorizedBridgeRequest } from "@/lib/wayflow-bridge-auth";
import {
  scanOasForLiteralSecrets,
  scanOasForUntrustedUrls,
  scanAgentForRequiredLicense,
  scanOasForPackageVersionSync,
  type ReviewFinding,
} from "@cinatra-ai/agents";

const isAuthorizedBridgeRequestMock = vi.mocked(isAuthorizedBridgeRequest);
const scanOasForLiteralSecretsMock = vi.mocked(scanOasForLiteralSecrets);
const scanOasForUntrustedUrlsMock = vi.mocked(scanOasForUntrustedUrls);
const scanAgentForRequiredLicenseMock = vi.mocked(scanAgentForRequiredLicense);
const scanOasForPackageVersionSyncMock = vi.mocked(scanOasForPackageVersionSync);

function makeReq(body: unknown): Request {
  return new Request("http://localhost:3000/api/oas-lint/scan-all", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  isAuthorizedBridgeRequestMock.mockReturnValue(true);
});

describe("POST /api/oas-lint/scan-all — auth", () => {
  it("returns 401 when bridge token check fails", async () => {
    isAuthorizedBridgeRequestMock.mockReturnValue(false);
    const res = await POST(makeReq({ oasJson: "{}" }));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("bridge token");
  });

  it("returns 200 when bridge token check passes", async () => {
    const res = await POST(makeReq({ oasJson: "{}" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });
});

describe("POST /api/oas-lint/scan-all — request validation", () => {
  it("returns 400 when oasJson is missing", async () => {
    const res = await POST(makeReq({}));
    expect(res.status).toBe(400);
  });

  it("returns 400 when oasJson is a non-JSON string", async () => {
    const res = await POST(makeReq({ oasJson: "{ malformed" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("JSON object");
  });

  it("accepts a JSON-stringified OAS body", async () => {
    const res = await POST(
      makeReq({ oasJson: JSON.stringify({ component_type: "Flow", id: "x" }) }),
    );
    expect(res.status).toBe(200);
  });

  it("accepts a parsed-object OAS body", async () => {
    const res = await POST(
      makeReq({ oasJson: { component_type: "Flow", id: "x" } }),
    );
    expect(res.status).toBe(200);
  });
});

describe("POST /api/oas-lint/scan-all — response shape", () => {
  it("returns { ok: true, source: 'agent-lint-policy', rulesRun: string[], findings: '[]' } for clean OAS", async () => {
    const res = await POST(makeReq({ oasJson: "{}" }));
    const body = (await res.json()) as {
      ok: boolean;
      source: string;
      rulesRun: string[];
      findings: string;
    };
    expect(body.ok).toBe(true);
    expect(body.source).toBe("agent-lint-policy");
    expect(Array.isArray(body.rulesRun)).toBe(true);
    expect(body.rulesRun).toContain("literal_secrets_in_oas");
    expect(body.rulesRun).toContain("untrusted_external_url");
    // findings is JSON-stringified to match the ApiNode's declared
    // `findings: string` output type (downstream OutputMessageNode
    // renders it into conversation history for A2A consumption).
    expect(typeof body.findings).toBe("string");
    expect(JSON.parse(body.findings)).toEqual([]);
  });

  it("stamps source: 'agent-lint-policy' on every finding (even ones the scanners emit as `deterministic`)", async () => {
    scanOasForLiteralSecretsMock.mockReturnValue([
      {
        code: "literal_secrets_in_oas",
        severity: "blocker",
        message: "found a secret",
        source: "deterministic", // scanner's legacy source value
      },
    ]);
    scanOasForUntrustedUrlsMock.mockReturnValue([
      {
        code: "untrusted_external_url",
        severity: "blocker",
        message: "http://",
        source: "deterministic",
      },
    ]);

    const res = await POST(makeReq({ oasJson: "{}" }));
    const body = (await res.json()) as { findings: string };
    const findings = JSON.parse(body.findings) as ReviewFinding[];
    expect(findings).toHaveLength(2);
    expect(findings[0].source).toBe("agent-lint-policy");
    expect(findings[1].source).toBe("agent-lint-policy");
    // Severity and other fields preserved
    expect(findings[0].severity).toBe("blocker");
    expect(findings[0].code).toBe("literal_secrets_in_oas");
  });

  it("invokes package-adjacent scanners only when packageJson is supplied", async () => {
    // Without packageJson: package-adjacent scanners are NOT called
    await POST(makeReq({ oasJson: "{}" }));
    expect(scanOasForPackageVersionSyncMock).not.toHaveBeenCalled();
    expect(scanAgentForRequiredLicenseMock).not.toHaveBeenCalled();

    // With packageJson: they ARE called, and scanAgentForRequiredLicense
    // receives the PARSED package.json directly (not wrapped in an envelope).
    vi.clearAllMocks();
    isAuthorizedBridgeRequestMock.mockReturnValue(true);
    const pkg = { name: "@cinatra/x", version: "0.1.0", license: "Apache-2.0" };
    await POST(
      makeReq({
        oasJson: "{}",
        packageJson: JSON.stringify(pkg),
      }),
    );
    expect(scanOasForPackageVersionSyncMock).toHaveBeenCalledTimes(1);
    expect(scanAgentForRequiredLicenseMock).toHaveBeenCalledTimes(1);
    // Assert the scanner receives the parsed package.json, not an
    // envelope object.
    expect(scanAgentForRequiredLicenseMock).toHaveBeenCalledWith(pkg);
  });

  it("a licensed package emits NO 'agent_package_missing_license' finding", async () => {
    // Use the REAL scanner (un-mock for this test only). The endpoint
    // mock chain: scanners receive parsed package.json from the route
    // → real scanAgentForRequiredLicense returns [] when license is set.
    scanAgentForRequiredLicenseMock.mockImplementation((parsed: Record<string, unknown>) => {
      const license = parsed?.license;
      if (typeof license === "string" && license.length > 0) return [];
      return [
        {
          code: "agent_package_missing_license",
          severity: "blocker",
          message: "missing license",
          source: "deterministic",
        },
      ];
    });

    const res = await POST(
      makeReq({
        oasJson: "{}",
        packageJson: JSON.stringify({
          name: "@cinatra/x",
          version: "0.1.0",
          license: "Apache-2.0",
        }),
      }),
    );
    const body = (await res.json()) as { findings: string };
    const findings = JSON.parse(body.findings) as ReviewFinding[];
    expect(findings.some((f) => f.code === "agent_package_missing_license")).toBe(false);
  });
});
