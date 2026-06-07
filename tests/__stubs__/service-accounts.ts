// Test stub for vi.mock("@/lib/service-accounts")
import { vi } from "vitest";
import type { ServiceAccountRecord } from "@/lib/service-accounts";

export const mockServiceAccount: ServiceAccountRecord = {
  id: "acct-test",
  name: "test",
  orgId: "org-test",
  clientId: "client-test",
  scopes: "run.read",
  revokedAt: null,
  rotatedAt: null,
  previousClientId: null,
  gracePeriodSeconds: 900,
  createdBy: null,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

export const readServiceAccount = vi.fn(async () => mockServiceAccount);
export const readServiceAccountByClientId = vi.fn(async () => mockServiceAccount);
export const listServiceAccounts = vi.fn(async () => [mockServiceAccount]);
export const createServiceAccount = vi.fn();
export const revokeServiceAccount = vi.fn();
export const rotateServiceAccount = vi.fn();
export const deleteServiceAccount = vi.fn();
