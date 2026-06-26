import { describe, it, expect } from "vitest";
import { refineStatusFromHttp } from "../src/span-status";

describe("refineStatusFromHttp (#492)", () => {
  it("respects an explicitly-recorded ok/error (never overrides)", () => {
    expect(
      refineStatusFromHttp("ok", { "http.response.status_code": 500 }),
    ).toBe("ok");
    expect(
      refineStatusFromHttp("error", { "http.response.status_code": 200 }),
    ).toBe("error");
  });

  it("derives ok from a 2xx/3xx when OTel left it unset", () => {
    expect(
      refineStatusFromHttp("unset", { "http.response.status_code": 200 }),
    ).toBe("ok");
    expect(
      refineStatusFromHttp("unset", { "http.response.status_code": 304 }),
    ).toBe("ok");
  });

  it("derives error from a 4xx/5xx when OTel left it unset", () => {
    expect(
      refineStatusFromHttp("unset", { "http.response.status_code": 404 }),
    ).toBe("error");
    expect(
      refineStatusFromHttp("unset", { "http.response.status_code": 503 }),
    ).toBe("error");
  });

  it("reads the legacy http.status_code key and string-encoded codes", () => {
    expect(refineStatusFromHttp("unset", { "http.status_code": 200 })).toBe("ok");
    expect(refineStatusFromHttp("unset", { "http.status_code": "500" })).toBe(
      "error",
    );
  });

  it("stays unset for genuinely-unknown (non-HTTP / unrecorded) spans", () => {
    expect(refineStatusFromHttp("unset", {})).toBe("unset");
    expect(refineStatusFromHttp("unset", { "agent.run_id": "x" })).toBe("unset");
  });
});
