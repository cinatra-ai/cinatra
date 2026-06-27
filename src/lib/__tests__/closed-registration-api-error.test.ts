/**
 * Contract for the FORBIDDEN APIError the closed-registration hook throws (D2).
 *
 * auth.ts cannot be loaded for real in the vitest sandbox (top-level await +
 * full better-auth plugin graph; it is always mocked). This test pins the exact
 * error the hook constructs — the SAME `APIError.from("FORBIDDEN", {code,
 * message})` call from `better-auth/api` — so the email/social endpoints return
 * HTTP 403 with the REGISTRATION_CLOSED code (not the generic "unable to create
 * user" that `return false` / `{data:false}` would yield).
 */
import { describe, expect, it } from "vitest";
import { APIError } from "better-auth/api";
import {
  REGISTRATION_CLOSED_CODE,
  REGISTRATION_CLOSED_MESSAGE,
} from "../closed-registration-gate";

describe("REGISTRATION_CLOSED APIError (D2)", () => {
  it("maps FORBIDDEN → HTTP 403 with the stable code + message", () => {
    const err = APIError.from("FORBIDDEN", {
      code: REGISTRATION_CLOSED_CODE,
      message: REGISTRATION_CLOSED_MESSAGE,
    });

    expect(err).toBeInstanceOf(APIError);
    // better-call maps the "FORBIDDEN" status string to HTTP 403.
    expect((err as unknown as { status: string }).status).toBe("FORBIDDEN");
    expect((err as unknown as { statusCode: number }).statusCode).toBe(403);
    // The body carries the precise machine code + operator-facing message.
    const body = (err as unknown as { body?: { code?: string; message?: string } }).body;
    expect(body?.code).toBe("REGISTRATION_CLOSED");
    expect(body?.message).toBe(REGISTRATION_CLOSED_MESSAGE);
  });
});
