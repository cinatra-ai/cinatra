/**
 * Unit test for fetchAppointmentSchedules (appointment-schedules capability
 * backed, cinatra#151 Stage 4).
 *
 * Contract locked here:
 *   - schedules resolve through `@/lib/appointment-schedules` (the
 *     `appointment-schedules` capability registered by the google-calendar
 *     connector's register(ctx)) — the action imports no connector package;
 *   - provider ABSENT (connector not installed/active — it is
 *     acquirable-on-demand, NOT required) -> [] — the action never throws
 *     for a missing connector;
 *   - the session user id is forwarded; an unauthenticated session forwards
 *     undefined (provider contract handles anonymous).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/register-host-connector-services", () => ({}));
vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: vi.fn(),
}));
vi.mock("@/lib/appointment-schedules", () => ({
  listAppointmentSchedules: vi.fn(async () => []),
}));

import { fetchAppointmentSchedules } from "../cta-actions";
import { requireAuthSession } from "@/lib/auth-session";
import { listAppointmentSchedules } from "@/lib/appointment-schedules";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("fetchAppointmentSchedules", () => {
  it("returns the resolver's schedules for the session user", async () => {
    vi.mocked(requireAuthSession).mockResolvedValueOnce({
      user: { id: "u1" },
    } as unknown as Awaited<ReturnType<typeof requireAuthSession>>);
    vi.mocked(listAppointmentSchedules).mockResolvedValueOnce([
      { title: "Intro call", bookingPageUrl: "https://calendar.app.google/abc" },
    ]);

    expect(await fetchAppointmentSchedules()).toEqual([
      { title: "Intro call", bookingPageUrl: "https://calendar.app.google/abc" },
    ]);
    expect(listAppointmentSchedules).toHaveBeenCalledWith("u1");
  });

  it("degrades to [] when NO provider is registered (connector absent — never throws)", async () => {
    vi.mocked(requireAuthSession).mockResolvedValueOnce({
      user: { id: "u1" },
    } as unknown as Awaited<ReturnType<typeof requireAuthSession>>);
    vi.mocked(listAppointmentSchedules).mockResolvedValueOnce([]);

    expect(await fetchAppointmentSchedules()).toEqual([]);
  });

  it("forwards undefined for an unauthenticated session (requireAuthSession rejection is swallowed)", async () => {
    vi.mocked(requireAuthSession).mockRejectedValueOnce(new Error("no session"));
    vi.mocked(listAppointmentSchedules).mockResolvedValueOnce([]);

    expect(await fetchAppointmentSchedules()).toEqual([]);
    expect(listAppointmentSchedules).toHaveBeenCalledWith(undefined);
  });
});
