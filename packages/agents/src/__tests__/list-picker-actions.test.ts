/**
 * Unit test for fetchAvailableLists (CRM-facade backed).
 *
 * The picker source-of-truth now routes through `crmFacade.list.search` (the
 * provider-agnostic CRM connector). The outward `AvailableListSummary` shape
 * is preserved so downstream consumers don't have to migrate in lockstep.
 *
 * Contract locked here:
 *   - Admin gate fires FIRST — no CRM read if requireAdminSession rejects.
 *   - `crmFacade.list.search({ query: "", objectType: "contact" })` is the
 *     single call.
 *   - CrmList[] is mapped 1:1 to AvailableListSummary[], with `memberCount`
 *     + `lastUpdated` set to null (the new provider doesn't surface them)
 *     and `memberType` derived from `CrmList.objectType`.
 *   - Upstream failures (no Twenty row, no bearer, network errors) degrade
 *     to `[]` rather than 500-ing the picker UI.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// --- mocks (must hoist BEFORE the source-under-test import) ---

vi.mock("@/lib/auth-session", () => ({
  requireAdminSession: vi.fn(),
}));

vi.mock("@cinatra-ai/crm-connector", () => ({
  crmFacade: {
    list: { search: vi.fn() },
    account: {},
    contact: {},
  },
}));

import { fetchAvailableLists } from "../list-picker-actions";
import { requireAdminSession } from "@/lib/auth-session";
import { crmFacade } from "@cinatra-ai/crm-connector";

const searchMock = vi.mocked(crmFacade.list.search);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("fetchAvailableLists", () => {
  it("rejects when requireAdminSession throws — CRM facade is NOT called", async () => {
    vi.mocked(requireAdminSession).mockRejectedValueOnce(new Error("not admin"));

    await expect(fetchAvailableLists()).rejects.toThrow(/not admin/);
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("calls crmFacade.list.search with objectType:'contact'", async () => {
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

  it("degrades to [] when the facade throws (no Twenty row / no bearer / upstream unreachable)", async () => {
    vi.mocked(requireAdminSession).mockResolvedValueOnce({
      user: { id: "u1" },
      session: { activeOrganizationId: "org1" },
    } as unknown as Awaited<ReturnType<typeof requireAdminSession>>);
    searchMock.mockRejectedValueOnce(new Error("Twenty workspace row not configured"));

    expect(await fetchAvailableLists()).toEqual([]);
  });

  it("returns an empty array when the facade returns no lists", async () => {
    vi.mocked(requireAdminSession).mockResolvedValueOnce({
      user: { id: "u1" },
      session: { activeOrganizationId: "org1" },
    } as unknown as Awaited<ReturnType<typeof requireAdminSession>>);
    searchMock.mockResolvedValueOnce([]);

    expect(await fetchAvailableLists()).toEqual([]);
  });
});
