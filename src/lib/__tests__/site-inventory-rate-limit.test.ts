import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetSiteInventoryRateLimitForTests,
  allowSiteInventoryRequest,
  checkSiteInventoryDebounce,
  DEBOUNCE_MAX_TRACKED_SITES,
  markSiteInventoryAccepted,
  SITE_INVENTORY_DEBOUNCE_MS,
  SITE_INVENTORY_MAX_TRACKED_BUCKETS,
} from "@/lib/site-inventory-rate-limit";

describe("site-inventory-rate-limit", () => {
  beforeEach(() => {
    __resetSiteInventoryRateLimitForTests();
  });

  describe("allowSiteInventoryRequest (pre-auth ip + credential-hash buckets)", () => {
    it("allows requests under the per-minute IP cap (distinct credentials)", () => {
      const now = 1_000_000;
      for (let i = 0; i < 30; i++) {
        expect(
          allowSiteInventoryRequest({ ip: "1.2.3.4", credentialKey: `cred-${i}`, now }),
        ).toBe(true);
      }
    });

    it("denies the 31st request from one IP within the window — attributable to the IP bucket (credentials all distinct)", () => {
      const now = 1_000_000;
      for (let i = 0; i < 30; i++) {
        allowSiteInventoryRequest({ ip: "1.2.3.4", credentialKey: `cred-${i}`, now });
      }
      expect(
        allowSiteInventoryRequest({ ip: "1.2.3.4", credentialKey: "cred-fresh", now }),
      ).toBe(false);
    });

    it("denies the 11th request under one credential even when the IP rotates every call (the anti-spoof pairing)", () => {
      const now = 1_000_000;
      for (let i = 0; i < 10; i++) {
        expect(
          allowSiteInventoryRequest({ ip: `10.0.0.${i}`, credentialKey: "cred-fixed", now }),
        ).toBe(true);
      }
      // Fresh IP, same credential: the credential bucket denies — rotating
      // the forwarded-for header buys nothing under a fixed credential.
      expect(
        allowSiteInventoryRequest({ ip: "10.0.99.99", credentialKey: "cred-fixed", now }),
      ).toBe(false);
    });

    it("resets buckets after the window elapses", () => {
      const now = 1_000_000;
      for (let i = 0; i < 30; i++) {
        allowSiteInventoryRequest({ ip: "1.2.3.4", credentialKey: `cred-${i}`, now });
      }
      expect(
        allowSiteInventoryRequest({ ip: "1.2.3.4", credentialKey: "cred-x", now }),
      ).toBe(false);
      // 60s + 1ms later, a fresh window opens.
      expect(
        allowSiteInventoryRequest({ ip: "1.2.3.4", credentialKey: "cred-x", now: now + 60_001 }),
      ).toBe(true);
    });

    it("tracks distinct IPs independently", () => {
      const now = 1_000_000;
      for (let i = 0; i < 30; i++) {
        allowSiteInventoryRequest({ ip: "1.2.3.4", credentialKey: `cred-${i}`, now });
      }
      expect(
        allowSiteInventoryRequest({ ip: "1.2.3.4", credentialKey: "cred-a", now }),
      ).toBe(false);
      expect(
        allowSiteInventoryRequest({ ip: "5.6.7.8", credentialKey: "cred-b", now }),
      ).toBe(true);
    });

    it("fails CLOSED at bucket-table saturation: new keys are denied, established keys keep working, expiry sweeps make room", () => {
      const now = 1_000_000;
      // Fill the table to the cap with live buckets (each call mints an ip:
      // and a cred: key — two entries).
      const fillCalls = SITE_INVENTORY_MAX_TRACKED_BUCKETS / 2;
      for (let i = 0; i < fillCalls; i++) {
        allowSiteInventoryRequest({ ip: `fill-${i}`, credentialKey: `fill-cred-${i}`, now });
      }
      // A brand-new key pair at saturation is DENIED (never tracked
      // unboundedly, never waved through untracked).
      expect(
        allowSiteInventoryRequest({ ip: "new-ip", credentialKey: "new-cred", now }),
      ).toBe(false);
      // An ESTABLISHED key pair still works at the cap.
      expect(
        allowSiteInventoryRequest({ ip: "fill-0", credentialKey: "fill-cred-0", now }),
      ).toBe(true);
      // Once the fill expires, the sweep reclaims the table for new keys.
      expect(
        allowSiteInventoryRequest({ ip: "new-ip", credentialKey: "new-cred", now: now + 60_001 }),
      ).toBe(true);
    });
  });

  describe("checkSiteInventoryDebounce + markSiteInventoryAccepted (post-auth per-site 60s window)", () => {
    it("allows a never-marked site, and repeated checks do not self-advance the window", () => {
      const now = 1_000_000;
      expect(checkSiteInventoryDebounce({ siteId: "site-a", now })).toEqual({ allowed: true });
      // The check is read-only: without a mark, an immediate re-check is
      // still allowed (a rejected send burned nothing).
      expect(checkSiteInventoryDebounce({ siteId: "site-a", now: now + 1 })).toEqual({
        allowed: true,
      });
    });

    it("denies inside the window after an ACCEPTED send and reports Retry-After seconds", () => {
      const now = 1_000_000;
      markSiteInventoryAccepted({ siteId: "site-a", now });
      const second = checkSiteInventoryDebounce({ siteId: "site-a", now: now + 10_000 });
      expect(second.allowed).toBe(false);
      if (!second.allowed) {
        // 60s window - 10s elapsed = 50s remaining.
        expect(second.retryAfterSeconds).toBe(50);
      }
    });

    it("allows again once the window has fully elapsed", () => {
      const now = 1_000_000;
      markSiteInventoryAccepted({ siteId: "site-a", now });
      expect(
        checkSiteInventoryDebounce({ siteId: "site-a", now: now + SITE_INVENTORY_DEBOUNCE_MS }),
      ).toEqual({ allowed: true });
    });

    it("denied checks never extend the lockout (window anchored to the accepted send only)", () => {
      const now = 1_000_000;
      markSiteInventoryAccepted({ siteId: "site-a", now });
      checkSiteInventoryDebounce({ siteId: "site-a", now: now + 10_000 });
      checkSiteInventoryDebounce({ siteId: "site-a", now: now + 20_000 });
      checkSiteInventoryDebounce({ siteId: "site-a", now: now + 30_000 });
      expect(
        checkSiteInventoryDebounce({ siteId: "site-a", now: now + SITE_INVENTORY_DEBOUNCE_MS }),
      ).toEqual({ allowed: true });
    });

    it("tracks distinct siteIds independently", () => {
      const now = 1_000_000;
      markSiteInventoryAccepted({ siteId: "site-a", now });
      expect(checkSiteInventoryDebounce({ siteId: "site-a", now: now + 1 }).allowed).toBe(false);
      expect(checkSiteInventoryDebounce({ siteId: "site-b", now: now + 1 })).toEqual({
        allowed: true,
      });
    });

    it("still records a just-accepted site's window at the tracked-site cap — never a silent no-op that would let its next request bypass the 60s window", () => {
      const now = 1_000_000;
      // Fill the debounce map to the cap with distinct, still-live sites.
      for (let i = 0; i < DEBOUNCE_MAX_TRACKED_SITES; i++) {
        markSiteInventoryAccepted({ siteId: `fill-site-${i}`, now });
      }
      markSiteInventoryAccepted({ siteId: "new-site", now });
      expect(checkSiteInventoryDebounce({ siteId: "new-site", now: now + 1 }).allowed).toBe(false);
    });
  });
});
