/**
 * Unit test for fetchAvailableLists (crm-list-reader capability backed).
 *
 * The picker source-of-truth routes through the `crm-list-reader` capability
 * surface registered by the crm-connector's register(ctx) — resolved via
 * `@/lib/crm-integration-providers` (cinatra#151 Stage 4), never by
 * value-importing the connector package. The outward `AvailableListSummary`
 * shape is preserved so downstream consumers don't have to migrate in
 * lockstep.
 *
 * Contract locked here:
 *   - Admin gate fires FIRST — no CRM read if requireAdminSession rejects.
 *   - `searchLists({ query: "", objectType: "contact" })` is the single call.
 *   - CrmList[] is mapped 1:1 to AvailableListSummary[], with `memberCount`
 *     + `lastUpdated` set to null (the provider doesn't surface them)
 *     and `memberType` derived from `CrmList.objectType`.
 *   - Capability ABSENT (connector not installed/active) degrades to `[]`.
 *   - Upstream failures (no Twenty row, no bearer, network errors) degrade
 *     to `[]` rather than 500-ing the picker UI.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// --- mocks (must hoist BEFORE the source-under-test import) ---

vi.mock("@/lib/auth-session", () => ({
  requireAdminSession: vi.fn(),
}));

vi.mock("@/lib/crm-integration-providers", () => ({
  resolveCrmListReader: vi.fn(),
}));

import { fetchAvailableLists } from "../list-picker-actions";
import { requireAdminSession } from "@/lib/auth-session";
import { resolveCrmListReader } from "@/lib/crm-integration-providers";

const searchMock = vi.fn();
vi.mocked(resolveCrmListReader).mockImplementation(() => ({ searchLists: searchMock }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveCrmListReader).mockImplementation(() => ({ searchLists: searchMock }));
});

describe("fetchAvailableLists", () => {
  it("rejects when requireAdminSession throws — CRM facade is NOT called", async () => {
    vi.mocked(requireAdminSession).mockRejectedValueOnce(new Error("not admin"));

    await expect(fetchAvailableLists()).rejects.toThrow(/not admin/);
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("calls searchLists with objectType:'contact'", async () => {
    vi.mocked(requireAdminSession).mockResolvedValueOnce({
      user: { id: "u1" },
      session: { activeOrganizationId: "org1" },
    } as unknown as Awaited<ReturnType<typeof requireAdminSession>>);
    searchMock.mockResolvedValueOnce([]);

    await fetchAvailableLists();

    expect(searchMock).toHaveBeenCalledTimes(1);
    expect(searchMock).toHaveBeenCalledWith({ query: "", objectType: "contact" });
  });

  it("maps CrmList[] to AvailableListSummary[] with objectType -> memberType + null counts/timestamps", async () => {
    vi.mocked(requireAdminSession).mockResolvedValueOnce({
      user: { id: "u1" },
      session: { activeOrganizationId: "org1" },
    } as unknown as Awaited<ReturnType<typeof requireAdminSession>>);
    searchMock.mockResolvedValueOnce([
      { id: "v1", slug: "leaders", name: "Leaders", objectType: "contact" },
      { id: "v2", slug: "customers", name: "Customers", objectType: "contact" },
    ]);

    const result = await fetchAvailableLists();

    expect(result).toEqual([
      {
        id: "v1",
        name: "Leaders",
        memberCount: null,
        lastUpdated: null,
        memberType: "contact",
      },
      {
        id: "v2",
        name: "Customers",
        memberCount: null,
        lastUpdated: null,
        memberType: "contact",
      },
    ]);
  });

  it("degrades to [] when the reader throws (no CRM provider / no Twenty row / upstream unreachable)", async () => {
    vi.mocked(requireAdminSession).mockResolvedValueOnce({
      user: { id: "u1" },
      session: { activeOrganizationId: "org1" },
    } as unknown as Awaited<ReturnType<typeof requireAdminSession>>);
    searchMock.mockRejectedValueOnce(new Error("Twenty workspace row not configured"));

    expect(await fetchAvailableLists()).toEqual([]);
  });

  it("returns an empty array when the reader returns no lists", async () => {
    vi.mocked(requireAdminSession).mockResolvedValueOnce({
      user: { id: "u1" },
      session: { activeOrganizationId: "org1" },
    } as unknown as Awaited<ReturnType<typeof requireAdminSession>>);
    searchMock.mockResolvedValueOnce([]);

    expect(await fetchAvailableLists()).toEqual([]);
  });

  it("degrades to [] when the crm-list-reader capability is ABSENT (connector not installed/active)", async () => {
    vi.mocked(requireAdminSession).mockResolvedValueOnce({
      user: { id: "u1" },
      session: { activeOrganizationId: "org1" },
    } as unknown as Awaited<ReturnType<typeof requireAdminSession>>);
    vi.mocked(resolveCrmListReader).mockReturnValueOnce(null);

    expect(await fetchAvailableLists()).toEqual([]);
    expect(searchMock).not.toHaveBeenCalled();
  });
});
