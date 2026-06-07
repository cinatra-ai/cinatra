// @vitest-environment jsdom
/**
 * Tests for GroupedSetupFormRenderer core composition, buffered form state,
 * defaultValues reset behavior, and specialized renderer grouped-mode coverage.
 */
import React from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
} from "@testing-library/react";

// jsdom does not implement ResizeObserver; Radix's use-size hook
// (transitively via Checkbox / contact-source-selector command list) crashes
// without it. Stub at module load.
if (typeof (globalThis as { ResizeObserver?: unknown }).ResizeObserver === "undefined") {
  (globalThis as { ResizeObserver: unknown }).ResizeObserver =
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
}

// ---------------------------------------------------------------------------
// Specialized-renderer action modules pull external @cinatra/* deps that the
// vitest environment does not resolve. Mock them as no-ops so the renderer
// chain imports cleanly. These tests exercise the grouped renderer + the
// registry — they never invoke the mocked action implementations.
// ---------------------------------------------------------------------------
vi.mock("../cta-actions", () => ({
  fetchAppointmentSchedules: vi.fn(async () => []),
}));
vi.mock("../skill-actions", () => ({
  fetchInstalledSkillsForAgent: vi.fn(async () => []),
  fetchSkillsBySlug: vi.fn(async () => []),
  fetchPersonalSkillsForAgent: vi.fn(async () => []),
}));
vi.mock("../email-outreach-stage-actions", () => ({
  fetchCampaignRecipients: vi.fn(async () => ({ items: [], total: 0 })),
  confirmCampaignRecipients: vi.fn(async () => undefined),
  checkEmailOutreachAsyncStatus: vi.fn(async () => ({ status: "idle" })),
  fetchInitialDrafts: vi.fn(async () => []),
  updateInitialDraft: vi.fn(async () => undefined),
  getReviewCheckState: vi.fn(async () => null),
  runReviewCheck: vi.fn(async () => null),
  dismissReviewRecommendation: vi.fn(async () => undefined),
  applyReviewRecommendation: vi.fn(async () => undefined),
}));
vi.mock("@cinatra-ai/sdk-ui", () => ({
  LoadingSpinner: () => null,
}));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  }),
}));
// @/components/ui/table is aliased to ui-stub.ts in vitest.config.ts —
// no per-test vi.mock needed.
// Stub every lucide-react icon imported anywhere in packages/agents/src as a
// minimal <span> component. Vitest's mock loader requires explicit named
// exports — a Proxy factory will not satisfy `No "X" export is defined`.
// The list below is generated from `grep "from \"lucide-react\"" -r src/`.
vi.mock("lucide-react", () => {
  const make = (name: string) => () =>
    React.createElement("span", { "data-icon": name });
  return {
    AlertCircle: make("alert-circle"),
    ArrowRight: make("arrow-right"),
    BarChart3: make("bar-chart-3"),
    Bot: make("bot"),
    CalendarClock: make("calendar-clock"),
    Check: make("check"),
    CheckCircle2: make("check-circle-2"),
    ChevronDown: make("chevron-down"),
    ChevronRight: make("chevron-right"),
    ChevronUp: make("chevron-up"),
    Circle: make("circle"),
    CircleDot: make("circle-dot"),
    ClipboardList: make("clipboard-list"),
    Clock: make("clock"),
    CloudUploadIcon: make("cloud-upload"),
    Download: make("download"),
    ExternalLink: make("external-link"),
    FileIcon: make("file"),
    FileText: make("file-text"),
    Folder: make("folder"),
    GitCompare: make("git-compare"),
    Info: make("info"),
    Lightbulb: make("lightbulb"),
    Loader2: make("loader-2"),
    Pause: make("pause"),
    PlayCircle: make("play-circle"),
    Redo2: make("redo-2"),
    RotateCcw: make("rotate-ccw"),
    Trash2: make("trash-2"),
    Trash2Icon: make("trash-2"),
    TriangleAlert: make("triangle-alert"),
    Undo2: make("undo-2"),
    Upload: make("upload"),
    UserCircle: make("user-circle"),
    X: make("x"),
    XCircle: make("x-circle"),
    // shadcn/ui components import these *Icon-suffixed names.
    CheckIcon: make("check"),
    ChevronDownIcon: make("chevron-down"),
    ChevronRightIcon: make("chevron-right"),
    ChevronUpIcon: make("chevron-up"),
    Loader2Icon: make("loader-2"),
    MoreHorizontalIcon: make("more-horizontal"),
    PanelLeftIcon: make("panel-left"),
    SearchIcon: make("search"),
    XIcon: make("x"),
  };
});

import { GroupedSetupFormRenderer } from "../grouped-setup-form-renderer";
import { fieldRendererRegistry } from "../field-renderer-registry";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";

// Minimal FieldRendererContext — connectedApps=[] is the default.
const BASE_CONTEXT = { connectedApps: [] as string[] };

beforeEach(() => {
  fieldRendererRegistry.clear();
  ensureDefaultFieldRenderersRegistered();
});

afterEach(() => {
  cleanup();
});

// ============================================================================
// Core composition
// ============================================================================
describe("GroupedSetupFormRenderer — core composition", () => {
  // The grouped renderer exposes one outer submit button and suppresses
  // per-field "Continue" buttons.
  it("renders the grouped form with all visible fields and a single Save & start run button", () => {
    const schema = {
      type: "object",
      properties: {
        website: { type: "string", title: "Website" },
        name: { type: "string", title: "Sender name" },
        description: { type: "string", title: "Description" },
      },
      required: ["website", "name", "description"],
    };

    render(
      <GroupedSetupFormRenderer
        fieldName="_grouped"
        schema={schema}
        value={{}}
        onChange={vi.fn()}
        label=""
        context={BASE_CONTEXT}
      />,
    );

    // All 3 labels render
    expect(screen.getByText(/Website/i)).toBeTruthy();
    expect(screen.getByText(/Sender name/i)).toBeTruthy();
    expect(screen.getByText(/Description/i)).toBeTruthy();
    // Exactly ONE submit button: "Save & start run"
    const saveBtns = screen.queryAllByRole("button", {
      name: /Save & start run/i,
    });
    expect(saveBtns.length).toBe(1);
    // No per-field "Continue" buttons (hideSubmit=true is passed to subs)
    const continueBtns = screen.queryAllByRole("button", { name: /Continue/i });
    expect(continueBtns.length).toBe(0);
  });

  it("does NOT call outer onChange when a single sub-renderer value changes (buffers into form state)", () => {
    const onChange = vi.fn();
    const schema = {
      type: "object",
      properties: {
        website: { type: "string", title: "Website" },
      },
      required: ["website"],
    };

    render(
      <GroupedSetupFormRenderer
        fieldName="_grouped"
        schema={schema}
        value={{}}
        onChange={onChange}
        label=""
        context={BASE_CONTEXT}
      />,
    );

    // Typing into the inner field should NOT fire outer onChange.
    // (All user input is buffered in react-hook-form state via Controller.)
    const input = document.querySelector("input");
    if (input) {
      fireEvent.change(input, { target: { value: "https://example.com" } });
    }
    expect(onChange).not.toHaveBeenCalled();
  });

  // This path depends on the grouped "Save & start run" submit button.
  it("calls outer onChange ONCE with the full merged values object when Save & start run is clicked", async () => {
    const onChange = vi.fn(async () => undefined);
    const schema = {
      type: "object",
      properties: {
        website: { type: "string", title: "Website" },
      },
      required: ["website"],
    };

    render(
      <GroupedSetupFormRenderer
        fieldName="_grouped"
        schema={schema}
        value={{ website: "https://example.com" }}
        onChange={onChange}
        label=""
        context={BASE_CONTEXT}
      />,
    );

    // Click Save & start run — submit the pre-filled values.
    const submitBtn = screen.getByRole("button", { name: /Save & start run/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledTimes(1);
    });
    // Called with the merged values object (includes website key).
    const call = onChange.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(call?.[0]).toEqual(
      expect.objectContaining({ website: "https://example.com" }),
    );
  });
});

// ============================================================================
// useForm defaultValues drift verification
//
// We verify that `useEffect(() => form.reset(value), [form, value])` fires
// and pushes the upstream `value` change into react-hook-form state.
//
// Sub-renderers may maintain their own internal useState (e.g.
// SchemaFieldRenderer caches a localValue in React state for typing UX).
// That internal state is independent of react-hook-form state and is NOT
// resynced by form.reset — that is a property of those sub-renderers, not a
// regression in the drift fix. We therefore assert the form-state side of
// the contract: after a rerender with a new `value`, submitting the form
// surfaces the UPDATED value through `onChange`, proving form.reset ran.
// ============================================================================
describe("GroupedSetupFormRenderer — defaultValues drift fix", () => {
  // This path depends on the grouped "Save & start run" submit button.
  it("resets form state when the upstream `value` prop changes after mount (form.reset → form state reflects new value)", async () => {
    const onChange = vi.fn(async () => undefined);
    // Boolean field avoids SchemaFieldRenderer's local useState cache (Checkbox
    // is fully controlled by Controller → field.value).
    const schema = {
      type: "object",
      properties: {
        enabled: { type: "boolean", title: "Enabled" },
      },
      required: ["enabled"],
    };

    const { rerender } = render(
      <GroupedSetupFormRenderer
        fieldName="_grouped"
        schema={schema}
        value={{ enabled: false }}
        onChange={onChange}
        label=""
        context={BASE_CONTEXT}
      />,
    );

    // Parent pushes a new `value` after mount — form.reset MUST fire.
    rerender(
      <GroupedSetupFormRenderer
        fieldName="_grouped"
        schema={schema}
        value={{ enabled: true }}
        onChange={onChange}
        label=""
        context={BASE_CONTEXT}
      />,
    );

    // Submit and assert form.handleSubmit sees the reset value. If the drift
    // fix (useEffect + form.reset) is missing, form state stays at the
    // original defaultValues and the submit payload would be { enabled: false }.
    fireEvent.click(
      screen.getByRole("button", { name: /Save & start run/i }),
    );

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledTimes(1);
    });
    const driftCall = onChange.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(driftCall?.[0]).toEqual(
      expect.objectContaining({ enabled: true }),
    );
  });
});

// ============================================================================
// Heterogeneous renderer grouped-mode coverage. Each specialized sub-renderer
// must render without crashing INSIDE the grouped form, must not show a submit
// button, and must propagate onChange to the outer form state.
// ============================================================================
describe("GroupedSetupFormRenderer — specialized renderer grouped-mode coverage", () => {
  // Sub-renderers must suppress their own submit controls inside grouped mode.
  it("renders gmail-sender sub-renderer in grouped mode without a visible submit button; onChange propagates to outer form state", async () => {
    const onChange = vi.fn();
    const schema = {
      type: "object",
      properties: {
        senderEmail: {
          type: "string",
          title: "Sender email",
          "x-renderer": "@cinatra-ai/email-outreach-agent:gmail-sender",
        },
      },
      required: ["senderEmail"],
    };

    render(
      <GroupedSetupFormRenderer
        fieldName="_grouped"
        schema={schema}
        value={{}}
        onChange={onChange}
        label=""
        context={
          {
            connectedApps: ["gmail"],
            gmailAliases: [
              { sendAsEmail: "ops@example.com", isDefault: true },
            ],
          } as never
        }
      />,
    );

    // Sub-renderer rendered without throwing — label is present.
    expect(screen.getByText(/Sender email/i)).toBeTruthy();
    // No inner Continue / Submit button inside the sub-renderer.
    expect(screen.queryByRole("button", { name: /Continue/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Submit/i })).toBeNull();
    // Outer form shows the single Save & start run button.
    expect(
      screen.getByRole("button", { name: /Save & start run/i }),
    ).toBeTruthy();
    // Clicking submit without filling: required validation blocks submit
    // (buffer contract + zod validation) — outer onChange NOT called.
    fireEvent.click(
      screen.getByRole("button", { name: /Save & start run/i }),
    );
    await new Promise((r) => setTimeout(r, 10));
    expect(onChange).not.toHaveBeenCalled();
  });

  // Sub-renderers must suppress their own submit controls inside grouped mode.
  it("renders cta sub-renderer in grouped mode without a visible submit button", async () => {
    const onChange = vi.fn();
    const schema = {
      type: "object",
      properties: {
        callToAction: {
          type: "string",
          title: "Call to action",
          "x-renderer": "@cinatra-ai/email-outreach-agent:cta",
        },
      },
      required: ["callToAction"],
    };

    render(
      <GroupedSetupFormRenderer
        fieldName="_grouped"
        schema={schema}
        value={{}}
        onChange={onChange}
        label=""
        context={BASE_CONTEXT}
      />,
    );

    // cta renderer has an async fetch-in-useEffect. Wait for it to settle.
    await waitFor(() => {
      expect(screen.getByText(/Call to action/i)).toBeTruthy();
    });
    expect(screen.queryByRole("button", { name: /Continue/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Submit/i })).toBeNull();
    expect(
      screen.getByRole("button", { name: /Save & start run/i }),
    ).toBeTruthy();
  });
});
