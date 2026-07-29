import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetSiteInventoryRateLimitForTests,
  allowSiteInventoryIpRequest,
  checkSiteInventoryDebounce,
  SITE_INVENTORY_DEBOUNCE_MS,
} from "@/lib/site-inventory-rate-limit";

describe("site-inventory-rate-limit", () => {
  beforeEach(() => {
    __resetSiteInventoryRateLimitForTests();
  });

  describe("allowSiteInventoryIpRequest (pre-auth IP bucket)", () => {
    it("allows requests under the per-minute cap", () => {
      const now = 1_000_000;
      for (let i = 0; i < 30; i++) {
        expect(allowSiteInventoryIpRequest({ ip: "1.2.3.4", now })).toBe(true);
      }
    });

    it("denies the 31st request within the same window", () => {
      const now = 1_000_000;
      for (let i = 0; i < 30; i++) {
        allowSiteInventoryIpRequest({ ip: "1.2.3.4", now });
      }
      expect(allowSiteInventoryIpRequest({ ip: "1.2.3.4", now })).toBe(false);
    });

    it("resets the bucket after the window elapses", () => {
      const now = 1_000_000;
      for (let i = 0; i < 30; i++) {
        allowSiteInventoryIpRequest({ ip: "1.2.3.4", now });
      }
      expect(allowSiteInventoryIpRequest({ ip: "1.2.3.4", now })).toBe(false);
      // 60s + 1ms later, a fresh window opens.
      expect(allowSiteInventoryIpRequest({ ip: "1.2.3.4", now: now + 60_001 })).toBe(true);
    });

    it("tracks distinct IPs independently", () => {
      const now = 1_000_000;
      for (let i = 0; i < 30; i++) {
        allowSiteInventoryIpRequest({ ip: "1.2.3.4", now });
      }
      expect(allowSiteInventoryIpRequest({ ip: "1.2.3.4", now })).toBe(false);
      expect(allowSiteInventoryIpRequest({ ip: "5.6.7.8", now })).toBe(true);
    });
  });

  describe("checkSiteInventoryDebounce (post-auth per-site 60s debounce)", () => {
    it("allows the first send for a never-seen site", () => {
      const result = checkSiteInventoryDebounce({ siteId: "site-a", now: 1_000_000 });
      expect(result).toEqual({ allowed: true });
    });

    it("denies a second send inside the 60s window and reports Retry-After seconds", () => {
      const now = 1_000_000;
      expect(checkSiteInventoryDebounce({ siteId: "site-a", now })).toEqual({ allowed: true });
      const second = checkSiteInventoryDebounce({ siteId: "site-a", now: now + 10_000 });
      expect(second.allowed).toBe(false);
      if (!second.allowed) {
        // 60s window - 10s elapsed = 50s remaining.
        expect(second.retryAfterSeconds).toBe(50);
      }
    });

    it("allows again once the debounce window has fully elapsed", () => {
      const now = 1_000_000;
      expect(checkSiteInventoryDebounce({ siteId: "site-a", now })).toEqual({ allowed: true });
      expect(
        checkSiteInventoryDebounce({ siteId: "site-a", now: now + SITE_INVENTORY_DEBOUNCE_MS }),
      ).toEqual({ allowed: true });
    });

    it("does not advance the window on a denied call (a burst cannot extend its own lockout)", () => {
      const now = 1_000_000;
      expect(checkSiteInventoryDebounce({ siteId: "site-a", now })).toEqual({ allowed: true });
      // Denied calls at +10s, +20s, +30s must not push the eligible time out.
      checkSiteInventoryDebounce({ siteId: "site-a", now: now + 10_000 });
      checkSiteInventoryDebounce({ siteId: "site-a", now: now + 20_000 });
      checkSiteInventoryDebounce({ siteId: "site-a", now: now + 30_000 });
      expect(
        checkSiteInventoryDebounce({ siteId: "site-a", now: now + SITE_INVENTORY_DEBOUNCE_MS }),
      ).toEqual({ allowed: true });
    });

    it("tracks distinct siteIds independently", () => {
      const now = 1_000_000;
      expect(checkSiteInventoryDebounce({ siteId: "site-a", now })).toEqual({ allowed: true });
      expect(checkSiteInventoryDebounce({ siteId: "site-b", now })).toEqual({ allowed: true });
    });
  });
});
