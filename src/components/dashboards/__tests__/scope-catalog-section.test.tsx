// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";

const toastError = vi.fn();
const toastSuccess = vi.fn();
vi.mock("@/lib/cinatra-toast", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    success: (...args: unknown[]) => toastSuccess(...args),
  },
}));

import { ScopeCatalogSection } from "@/components/dashboards/scope-catalog-section";
import { CatalogAddOutcomeProvider } from "@/components/dashboards/catalog-add-outcome";
import type {
  CatalogAddResult,
  CatalogTemplateView,
  ScopeCatalogSource,
} from "@/lib/dashboards/installed-catalog-contract";

// ---------------------------------------------------------------------------
// Concept B's section (cinatra#2474 PR4's rows; PR5's Add) — RENDER + BEHAVIOUR
// assertions, not source text. What it must show, what it must NOT, and what it
// does with each server verdict.
// ---------------------------------------------------------------------------

const rows: CatalogTemplateView[] = [
  { templateId: "t1", name: "Pipeline health", packageName: "@cinatra-ai/a-artifact" },
  { templateId: "t2", name: "Revenue", packageName: "@cinatra-ai/b-artifact" },
];

const CREATED = {
  id: "d-new",
  name: "Pipeline health",
  isDefault: false,
  canWrite: true,
} as const;

function source(over: Partial<ScopeCatalogSource> = {}): ScopeCatalogSource {
  return {
    add: vi.fn(async () => ({ ok: true, dashboard: CREATED }) as CatalogAddResult),
    ...over,
  };
}

function mount({
  templates = rows,
  canAdd = true,
  onAdded = vi.fn(),
  src = source(),
}: {
  templates?: readonly CatalogTemplateView[];
  canAdd?: boolean;
  onAdded?: (d: typeof CREATED) => void;
  src?: ScopeCatalogSource;
} = {}) {
  return render(
    <CatalogAddOutcomeProvider canAdd={canAdd} onAdded={onAdded as never}>
      <ScopeCatalogSection templates={templates} source={src} />
    </CatalogAddOutcomeProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("<ScopeCatalogSection> — what it shows", () => {
  it("renders every row with its name and its providing package", () => {
    mount();
    const section = screen.getByRole("region", {
      name: "Add from the installed catalog",
    });
    expect(within(section).getByText("Pipeline health")).toBeTruthy();
    expect(within(section).getByText("@cinatra-ai/a-artifact")).toBeTruthy();
    expect(within(section).getByText("Revenue")).toBeTruthy();
    expect(within(section).getByText("@cinatra-ai/b-artifact")).toBeTruthy();
    expect(section.querySelectorAll('[data-slot="catalog-row"]')).toHaveLength(2);
  });

  it("offers exactly ONE control per row — Add — and still NO link", () => {
    // The link stays absent by PR4's judgment: a template's canonical surface is
    // governed by the TEMPLATE'S own owner tuple, a different gate from the one
    // these rows passed, so a row could link somewhere this actor gets a 404
    // from.
    const { container } = mount();
    expect(container.querySelectorAll("button")).toHaveLength(2);
    expect(container.querySelectorAll("a")).toHaveLength(0);
    expect(container.querySelectorAll("input")).toHaveLength(0);
    for (const b of container.querySelectorAll("button")) {
      expect(b.textContent).toBe("Add");
      expect((b as HTMLButtonElement).disabled).toBe(false);
    }
  });

  it("says what the add DOES, and makes no present-tense currentness claim", () => {
    mount();
    const section = screen.getByRole("region", {
      name: "Add from the installed catalog",
    });
    expect(section.textContent).toContain("your own copy on this page");
    // The read proves these were materialized by a live extension and are still
    // published — NOT that the extension still ships them right now (codex
    // convergence r1). The write re-checks that; the copy must not overclaim.
    expect(section.textContent).toContain("have added to this workspace");
    expect(section.textContent).not.toMatch(/what.s installed|provide to this/i);
    expect(section.textContent).not.toMatch(/coming soon|shortly|next release/i);
  });

  it("renders NOTHING for an empty list — the landing passes null instead", () => {
    const { container } = mount({ templates: [] });
    expect(container.innerHTML).toBe("");
  });
});

describe("<ScopeCatalogSection> — the Add is a create, and is gated like one", () => {
  it("SUPPRESSES the control (never disables it) without create authority", () => {
    const { container } = mount({ canAdd: false });
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(container.querySelectorAll("[disabled]")).toHaveLength(0);
    expect(container.querySelectorAll('[aria-disabled="true"]')).toHaveLength(0);
    // …and the rows are still shown, with the reason stated plainly.
    expect(container.querySelectorAll('[data-slot="catalog-row"]')).toHaveLength(2);
    expect(
      screen.getByRole("region", { name: "Add from the installed catalog" })
        .textContent,
    ).toContain("can’t add dashboards here");
  });

  it("offers nothing at all when no host provider is mounted", () => {
    // A section rendered into nothing can never act into nothing.
    const { container } = render(
      <ScopeCatalogSection templates={rows} source={source()} />,
    );
    expect(container.querySelectorAll("button")).toHaveLength(0);
  });
});

describe("<ScopeCatalogSection> — driving the add", () => {
  it("adds the pressed template, reports the created dashboard up, and drops the row", async () => {
    const onAdded = vi.fn();
    const src = source();
    mount({ onAdded, src });

    fireEvent.click(screen.getAllByRole("button", { name: "Add" })[0]);

    await waitFor(() => expect(onAdded).toHaveBeenCalledWith(CREATED));
    // The handle it sent is the row's own opaque template id — nothing else.
    expect(src.add).toHaveBeenCalledWith("t1");
    expect(src.add).toHaveBeenCalledTimes(1);
    expect(toastSuccess).toHaveBeenCalled();
    // A copied template's name is now taken in this very collection, so the
    // server would refuse a second add — the row leaves, truthfully.
    await waitFor(() =>
      expect(screen.queryByText("Pipeline health")).toBeNull(),
    );
    expect(screen.getByText("Revenue")).toBeTruthy();
  });

  it("shows the row as busy while the add is in flight and blocks a double-add", async () => {
    let release: (r: CatalogAddResult) => void = () => {};
    const src = source({
      add: vi.fn(
        () => new Promise<CatalogAddResult>((res) => (release = res)),
      ),
    });
    mount({ src });

    fireEvent.click(screen.getAllByRole("button", { name: "Add" })[0]);
    expect(await screen.findByRole("button", { name: "Adding…" })).toBeTruthy();
    // Every other row's control is held too — one add at a time.
    for (const b of screen.getAllByRole("button")) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
    }
    fireEvent.click(screen.getAllByRole("button")[1]);
    expect(src.add).toHaveBeenCalledTimes(1);

    release({ ok: true, dashboard: CREATED });
    await waitFor(() => expect(screen.queryByText("Adding…")).toBeNull());
  });

  it.each([
    ["name-taken", /already have a dashboard with that name/i],
    ["no-longer-declared", /no longer provides that dashboard/i],
    ["ineligible", /isn’t available to add here/i],
    ["denied", /don’t have permission/i],
    ["invalid-config", /configuration is no longer valid/i],
  ] as const)(
    "surfaces the %s refusal as in-product copy and keeps the row",
    async (reason, copy) => {
      const onAdded = vi.fn();
      const src = source({
        add: vi.fn(async () => ({ ok: false, reason }) as CatalogAddResult),
      });
      mount({ onAdded, src });

      fireEvent.click(screen.getAllByRole("button", { name: "Add" })[0]);

      await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith(expect.stringMatching(copy)),
      );
      expect(onAdded).not.toHaveBeenCalled();
      // A refusal is recoverable — the row stays and the control comes back.
      expect(screen.getByText("Pipeline health")).toBeTruthy();
      expect(screen.getAllByRole("button", { name: "Add" })).toHaveLength(2);
    },
  );

  it("clears the busy state when the action itself REJECTS", async () => {
    // A transport/server fault must not strand the row on "Adding…" forever.
    const src = source({ add: vi.fn(async () => { throw new Error("boom"); }) });
    mount({ src });

    fireEvent.click(screen.getAllByRole("button", { name: "Add" })[0]);

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(screen.getAllByRole("button", { name: "Add" })).toHaveLength(2);
  });
});
