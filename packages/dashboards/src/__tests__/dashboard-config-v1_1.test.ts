import { describe, expect, it } from "vitest";

import {
  CURRENT_CONFIG_VERSION,
  DashboardConfigV1_1Schema,
} from "../store/dashboard-config";
import { DASHBOARD_CONFIG_V12_VERSION } from "../extension/dashboard-config-v12";
import { AGENTS_DEFAULT_CONFIG } from "../components/seed-configs/agents-default";

/**
 * `DashboardConfigV1_1Schema` is the embedded analytics body an apiVersion 1.2
 * `analytics` portlet wraps at `config.dashboard`. It mirrors drizzle-cube's
 * DashboardConfig shape: portlets with w/h/x/y at the root + analysisConfig
 * (canonical) or legacy query (deprecated). The legacy 1.0.0 schema +
 * `parseDashboardConfig` dispatcher were removed in cinatra#329 (one format only).
 *
 * This test asserts the current schema:
 *   - parses the AGENTS_DEFAULT_CONFIG seed cleanly.
 *   - enforces invariants via .superRefine().
 *   - tolerates unknown drizzle-cube fields via .passthrough().
 */

describe("DashboardConfig schema", () => {
  it("CURRENT_CONFIG_VERSION is the apiVersion 1.2 literal (cinatra#326)", () => {
    // NEW operator/agent writes now persist the apiVersion 1.2 envelope; the
    // current-version constant re-exports the apiVersion 1.2 literal (single source).
    expect(CURRENT_CONFIG_VERSION).toBe(DASHBOARD_CONFIG_V12_VERSION);
  });

  it("current schema parses the AGENTS_DEFAULT_CONFIG seed cleanly", () => {
    const result = DashboardConfigV1_1Schema.safeParse(AGENTS_DEFAULT_CONFIG);
    expect(result.success).toBe(true);
  });

  describe(".superRefine invariants", () => {
    it("rejects portlets with no id", () => {
      const result = DashboardConfigV1_1Schema.safeParse({
        portlets: [{ id: "", title: "x", w: 4, h: 4, x: 0, y: 0, analysisConfig: {} }],
      });
      expect(result.success).toBe(false);
    });

    it("rejects portlets with no title", () => {
      const result = DashboardConfigV1_1Schema.safeParse({
        portlets: [{ id: "p1", title: "", w: 4, h: 4, x: 0, y: 0, analysisConfig: {} }],
      });
      expect(result.success).toBe(false);
    });

    it("rejects portlets with negative layout numbers", () => {
      const result = DashboardConfigV1_1Schema.safeParse({
        portlets: [{ id: "p1", title: "x", w: -1, h: 4, x: 0, y: 0, analysisConfig: {} }],
      });
      expect(result.success).toBe(false);
    });

    it("rejects portlets with no analysisConfig AND no query (content-spec requirement)", () => {
      const result = DashboardConfigV1_1Schema.safeParse({
        portlets: [{ id: "p1", title: "x", w: 4, h: 4, x: 0, y: 0 }],
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.issues.map((i) => i.message).join(" | ");
        expect(messages).toMatch(/requires either analysisConfig or query/);
      }
    });

    it("accepts legacy DC `query` (deprecated DC field) as a content spec", () => {
      const result = DashboardConfigV1_1Schema.safeParse({
        portlets: [{ id: "p1", title: "x", w: 4, h: 4, x: 0, y: 0, query: "raw-query-string" }],
      });
      expect(result.success).toBe(true);
    });
  });

  describe(".passthrough() tolerates unknown drizzle-cube fields", () => {
    it("accepts a portlet with extra fields", () => {
      const result = DashboardConfigV1_1Schema.safeParse({
        portlets: [
          {
            id: "p1",
            title: "x",
            w: 4, h: 4, x: 0, y: 0,
            analysisConfig: {},
            // Unknown fields that drizzle-cube might add in a future minor:
            futureField: { nested: true },
            anotherFutureField: [1, 2, 3],
          },
        ],
      });
      expect(result.success).toBe(true);
    });

    it("accepts a dashboard with extra root fields", () => {
      const result = DashboardConfigV1_1Schema.safeParse({
        portlets: [],
        thumbnailData: "data:image/png;base64,...",
        colorPalette: "ocean",
        someFutureKey: "tolerated",
      });
      expect(result.success).toBe(true);
    });
  });
});
