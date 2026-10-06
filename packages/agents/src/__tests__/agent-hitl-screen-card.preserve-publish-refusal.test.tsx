// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Button } from "@/components/ui/button";
import { LifecycleCardSurfaceProvider } from "../lifecycle-card-runtime";
import { fieldRendererRegistry, type FieldRendererProps } from "../field-renderer-registry";
import { GROUPED_SETUP_FORM_RENDERER_ID } from "../agent-builder-ids";
import { AgentHitlScreenCard } from "../agent-hitl-screen-card";

const ports = vi.hoisted(() => ({ read: vi.fn(), approve: vi.fn() }));
vi.mock("../agent-hitl-screen-actions", () => ({ getAgentHitlScreenStateAction: ports.read }));
vi.mock("../hitl-actions", () => ({ approveReviewTask: ports.approve }));
vi.mock("../server-actions", () => ({
  getFieldRendererContextForAgentBuilderAction: vi.fn(async () => ({ connectedApps: [] })),
}));

const RENDERER = "@example/publish:confirm";
const asking = {
  state: "asking" as const, runId: "run-refusal", screenRef: null,
  gate: { reviewTaskId: "wayflow-publish", xRenderer: RENDERER,
    inputSchema: { type: "object", properties: { approved: { type: "boolean" } } },
    currentValues: {}, fieldName: undefined },
};
// An extension stages its choice; the actual fallback card owns Continue.
function Choice({ onChange, value }: FieldRendererProps) {
  return <div>
    <output data-testid="staged-choice">{JSON.stringify(value)}</output>
    <span>{String((value as Record<string, unknown> | undefined)?.gateMarker ?? "")}</span>
    <Button type="button" onClick={() => onChange({ approved: false, draftId: "kept" })}>Do not publish</Button>
    <Button type="button" onClick={() => onChange({ approved: false, userResponse: '{"approved":false,"draftId":"kept"}' })}>Decline with response</Button>
    <Button type="button" onClick={() => onChange({ approved: true, userResponse: '{"approved":true}' })}>Publish with response</Button>
    <Button type="button" onClick={() => onChange({ approved: true })}>Publish</Button>
    <Button type="button" onClick={() => onChange({ note: "edited" })}>Edit note</Button>
  </div>;
}
let originalFetch: typeof fetch;
let brokerPayloads: Record<string, unknown>[];
let brokerLands: boolean;
let brokerState: typeof asking;
let brokerReply: Record<string, unknown>;
beforeEach(() => {
  ports.read.mockReset().mockResolvedValue(asking);
  ports.approve.mockReset().mockResolvedValue({ ok: true });
  fieldRendererRegistry.clear();
  fieldRendererRegistry.register({ id: RENDERER, priority: 100, midRunHitl: true,
    credentialSafe: true, condition: (_f, _s, c) => c.xRenderer === RENDERER, renderer: Choice });
  originalFetch = globalThis.fetch; brokerPayloads = []; brokerLands = true; brokerState = asking; brokerReply = {};
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith("/hitl-screen/submit")) {
      const body = JSON.parse(String(init?.body)) as { values: Record<string, unknown> };
      brokerPayloads.push(body.values);
      return new Response(JSON.stringify({ outcome: { ok: brokerLands, ...brokerReply } }), { status: 200 });
    }
    return new Response(JSON.stringify(brokerState), { status: 200 });
  });
});
afterEach(() => { cleanup(); fieldRendererRegistry.clear(); globalThis.fetch = originalFetch; });

async function press(label: string) {
  const button = await screen.findByRole("button", { name: label });
  await act(async () => { fireEvent.click(button); });
}
function payloadFor(host: string, index = 0): Record<string, unknown> {
  return host === "site_widget" ? brokerPayloads[index] : ports.approve.mock.calls[index][1];
}
async function continued(host: string, count = 1) {
  await press("Continue");
  await waitFor(() => expect(host === "site_widget" ? brokerPayloads.length : ports.approve.mock.calls.length).toBe(count));
  await screen.findByRole("button", { name: "Continue" });
  return payloadFor(host, count - 1);
}
// Actual server precedence is userResponse before approvalNote and approved metadata.
// Assert the response forwarded to WayFlow describes refusal, not merely its metadata.
function expectRefusal(payload: Record<string, unknown>) {
  expect(payload.approved).toBe(false);
  expect(typeof payload.approvedAt).toBe("string");
  expect(JSON.parse(String(payload.userResponse)).approved).toBe(false);
}

describe.each(["chat_thread", "run_card", "page_gate_region", "site_widget"] as const)("fallback Continue on %s", (host) => {
  beforeEach(() => {
    render(<LifecycleCardSurfaceProvider host={host}
      {...(host === "site_widget" ? { auth: { headers: () => ({ Authorization: "Bearer cwu_test" }), credentials: "omit" as const } } : {})}>
      <AgentHitlScreenCard runId={asking.runId} />
    </LifecycleCardSurfaceProvider>);
  });
  it("sends a stored decline through Continue and server response precedence", async () => {
    await press("Do not publish"); expectRefusal(await continued(host));
  });
  it("preserves refusal through an unrelated field edit", async () => {
    await press("Decline with response");
    await waitFor(() => expect(JSON.parse(screen.getByTestId("staged-choice").textContent ?? "{}").approved).toBe(false));
    await press("Edit note");
    await waitFor(() => expect(JSON.parse(screen.getByTestId("staged-choice").textContent ?? "{}")).toMatchObject({ approved: false, note: "edited" }));
    const payload = await continued(host); expectRefusal(payload); expect(payload.note).toBe("edited");
  });
  it("late confirming choice discards the previous decline response", async () => {
    await press("Decline with response"); await press("Publish");
    const payload = await continued(host); expect(payload.approved).toBe(true); expect(payload.userResponse).toBeUndefined();
  });
  it("late declining choice discards the previous approval response", async () => {
    await press("Publish with response"); await press("Do not publish"); expectRefusal(await continued(host));
  });
  it("keeps refusal for retry after a refused send", async () => {
    if (host === "site_widget") brokerLands = false;
    else ports.approve.mockResolvedValueOnce({ ok: false, blocked: "not-authorized" });
    await press("Do not publish"); expectRefusal(await continued(host));
    brokerLands = true; expectRefusal(await continued(host, 2));
  });
  it.each(["no-longer-pending", "already resolved"])("%s reply rereads the next gate without carrying refusal", async (reply) => {
    await press("Decline with response");
    const next = { ...asking, gate: { ...asking.gate, reviewTaskId: "wayflow-next", currentValues: { gateMarker: "next gate" } } };
    ports.read.mockResolvedValue(next); brokerState = next;
    if (host === "site_widget") {
      brokerLands = false;
      brokerReply = reply === "already resolved" ? { error: reply } : { blocked: reply };
    } else if (reply === "already resolved") ports.approve.mockRejectedValueOnce(new Error("Review task already resolved"));
    else ports.approve.mockResolvedValueOnce({ ok: false, blocked: reply });
    expectRefusal(await continued(host));
    await screen.findByText("next gate");
    brokerLands = true; brokerReply = {};
    const payload = await continued(host, 2);
    expect(payload.approved).toBe(true); expect(payload.userResponse).toBeUndefined();
    if (host !== "site_widget") expect(ports.approve.mock.calls[1][0]).toBe("wayflow-next");
  });
  it("the confirming road and unset decision retain approval default", async () => {
    const payload = await continued(host); expect(payload.approved).toBe(true); expect(payload.userResponse).toBeUndefined();
  });
});

describe("fallback grouped renderer submission", () => {
  async function openGrouped(taskId: string) {
    const grouped = { ...asking, gate: { ...asking.gate, reviewTaskId: taskId, xRenderer: GROUPED_SETUP_FORM_RENDERER_ID } };
    ports.read.mockResolvedValue(grouped);
    fieldRendererRegistry.register({ id: GROUPED_SETUP_FORM_RENDERER_ID, priority: 100,
      midRunHitl: true, condition: (_f, _s, c) => c.xRenderer === GROUPED_SETUP_FORM_RENDERER_ID,
      renderer: Choice });
    render(<LifecycleCardSurfaceProvider host="chat_thread"><AgentHitlScreenCard runId={asking.runId} /></LifecycleCardSurfaceProvider>);
  }
  it("grouped mid-run submission carries its renderer's decline", async () => {
    await openGrouped("wayflow-grouped"); await press("Do not publish");
    await waitFor(() => expect(ports.approve).toHaveBeenCalledTimes(1));
    expectRefusal(payloadFor("chat_thread"));
  });
  it("grouped setup treats approved:false as field data without approval metadata", async () => {
    await openGrouped("setup-grouped"); await press("Do not publish");
    await waitFor(() => expect(ports.approve).toHaveBeenCalledTimes(1));
    expect(payloadFor("chat_thread")).toEqual({ approved: false, draftId: "kept" });
  });
});
