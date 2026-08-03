// @vitest-environment jsdom
//
// Behavioural jsdom tests for the §V Skills section's client editor
// (cinatra#2349 S4, epic #2345). Renders the REAL component over the REAL
// shared typeahead (real cmdk + Radix under the access-picker shims), so what
// is asserted here is what the surface does, not what a double does.
//
// The five behaviours the issue's acceptance criteria turn on:
//
//   1. type → the dropdown NARROWS → selecting adds a row;
//   2. the query RESETS after each pick (the picker adaptation);
//   3. add is DISABLED at three, with the count hint saying so;
//   4. every row is removable, DOWN TO ZERO — no last-row floor;
//   5. a save that refuses ROLLS THE ROW BACK and explains why.
//
//   pnpm exec vitest run \
//     src/components/skills/__tests__/agent-skills-config-client.test.tsx

import "@/components/__tests__/access-picker-jsdom-shims";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import {
  AgentSkillsConfigClient,
  agentSkillRefusalText,
  agentSkillStatusPill,
  agentSkillsCountHint,
  type AgentSkillCandidate,
  type AgentSkillRow,
} from "@/components/skills/agent-skills-config-client";

const CANDIDATES: AgentSkillCandidate[] = [
  {
    skillId: "s-company-research",
    skillName: "Company Research",
    displayName: "Research Toolkit",
    vendorName: "Northstar",
    status: "active",
  },
  {
    skillId: "s-blog-writing",
    skillName: "Blog Writing",
    displayName: "Blog Skills",
    vendorName: "Cinatra",
    status: "active",
  },
  {
    skillId: "s-brand-voice",
    skillName: "Brand Voice",
    displayName: "Brand Kit",
    vendorName: null,
    status: "locked",
  },
];

const rowFor = (c: AgentSkillCandidate, status: AgentSkillRow["status"] = "ok"): AgentSkillRow => ({
  skillId: c.skillId,
  skillName: c.skillName,
  displayName: c.displayName,
  vendorName: c.vendorName,
  status,
});

/** A search that narrows server-side, exactly as the real action does. */
function narrowingSearch(pool: AgentSkillCandidate[] = CANDIDATES) {
  return vi.fn(async (query: string) => {
    const needle = query.trim().toLowerCase();
    return {
      ok: true as const,
      results: pool.filter(
        (c) =>
          needle.length === 0 ||
          c.skillName.toLowerCase().includes(needle) ||
          c.displayName.toLowerCase().includes(needle),
      ),
      hasMore: false,
    };
  });
}

const okWrite = () => vi.fn(async () => ({ ok: true as const }));

afterEach(() => cleanup());

describe("pure helpers", () => {
  it("states the count, and at the cap says what to do about it", () => {
    expect(agentSkillsCountHint(0, 3)).toContain("0 of 3 skills chosen");
    expect(agentSkillsCountHint(2, 3)).toContain("2 of 3 skills chosen");
    expect(agentSkillsCountHint(2, 3)).not.toContain("remove one");
    expect(agentSkillsCountHint(3, 3)).toContain("3 of 3 skills chosen — remove one to choose another.");
  });

  it("maps every hydrated status to a warning-toned badge except the healthy one", () => {
    expect(agentSkillStatusPill("ok")).toEqual({ status: "approved", label: "Active" });
    expect(agentSkillStatusPill("archived")).toEqual({ status: "hold", label: "Archived" });
    expect(agentSkillStatusPill("role-changed")).toEqual({ status: "hold", label: "Role changed" });
    expect(agentSkillStatusPill("missing")).toEqual({ status: "hold", label: "Not installed" });
    expect(agentSkillStatusPill("unavailable")).toEqual({ status: "hold", label: "Unavailable" });
  });

  it("explains every refusal both slices can return, and degrades truthfully", () => {
    for (const reason of [
      "forbidden",
      "unknown-agent",
      "ambiguous-agent",
      "not-an-agent",
      "assistant",
      "eligibility-unreadable",
      "unknown-skill",
      "not-assignable",
      "cap-exceeded",
    ]) {
      const text = agentSkillRefusalText(reason);
      expect(text.length).toBeGreaterThan(0);
      // Never render the raw machine token AS the explanation.
      expect(text).not.toBe(reason);
      expect(text).toMatch(/^[a-z]/);
    }
    expect(agentSkillRefusalText("something-new")).toBe("the change couldn't be saved");
  });
});

describe("choosing a skill", () => {
  it("narrows as you type and adds the picked skill as a row", async () => {
    const search = narrowingSearch();
    const assign = okWrite();
    render(
      <AgentSkillsConfigClient
        cap={3}
        initialRows={[]}
        search={search}
        assign={assign}
        remove={okWrite()}
      />,
    );

    const input = screen.getByRole("combobox");
    fireEvent.click(input);
    // The un-narrowed open shows the whole offer.
    await screen.findByText("Company Research");
    expect(screen.getByText("Blog Writing")).toBeTruthy();

    // Typing narrows — the debounce is 300 ms for a non-empty query.
    fireEvent.change(input, { target: { value: "blog" } });
    await waitFor(
      () => {
        expect(screen.getByText("Blog Writing")).toBeTruthy();
        expect(screen.queryByText("Company Research")).toBeNull();
      },
      { timeout: 2000 },
    );

    fireEvent.click(screen.getByText("Blog Writing"));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("s-blog-writing"));

    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="agent-skills-row"]').length).toBe(1),
    );
    expect(
      document.querySelector('[data-slot="agent-skills-row"]')?.getAttribute("data-skill-id"),
    ).toBe("s-blog-writing");
    expect(screen.getByText("1 of 3 skills chosen. A chosen skill reaches this agent on every run, alongside the ones it picks up on its own.")).toBeTruthy();
  });

  it("RESETS the query after each pick, so the next search starts from empty", async () => {
    const search = narrowingSearch();
    render(
      <AgentSkillsConfigClient
        cap={3}
        initialRows={[]}
        search={search}
        assign={okWrite()}
        remove={okWrite()}
      />,
    );

    const input = screen.getByRole("combobox") as HTMLInputElement;
    fireEvent.click(input);
    fireEvent.change(input, { target: { value: "blog" } });
    await waitFor(
      () => {
        expect(screen.getByText("Blog Writing")).toBeTruthy();
        expect(screen.queryByText("Company Research")).toBeNull();
      },
      { timeout: 2000 },
    );

    fireEvent.click(screen.getByText("Blog Writing"));
    await waitFor(() => expect(input.value).toBe(""));

    // Reopening searches from an EMPTY needle — the stale one would have
    // narrowed the next list to nothing.
    fireEvent.click(input);
    await waitFor(() => expect(screen.getByText("Company Research")).toBeTruthy());
    expect(search.mock.calls.at(-1)?.[0]).toBe("");
  });

  it("never offers a skill this agent already carries", async () => {
    const search = narrowingSearch();
    render(
      <AgentSkillsConfigClient
        cap={3}
        initialRows={[rowFor(CANDIDATES[1]!)]}
        search={search}
        assign={okWrite()}
        remove={okWrite()}
      />,
    );
    fireEvent.click(screen.getByRole("combobox"));
    await screen.findByText("Company Research");
    // "Blog Writing" is present exactly once — as the chosen ROW, never as an
    // offered option.
    expect(screen.getAllByText("Blog Writing").length).toBe(1);
    expect(
      document.querySelector('[data-slot="agent-skills-row"][data-skill-id="s-blog-writing"]'),
    ).toBeTruthy();
  });

  it("shows the row SAVING while the write is in flight, then settles it", async () => {
    let release: (() => void) | null = null;
    const assign = vi.fn(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          release = () => resolve({ ok: true });
        }),
    );
    render(
      <AgentSkillsConfigClient
        cap={3}
        initialRows={[]}
        search={narrowingSearch()}
        assign={assign}
        remove={okWrite()}
      />,
    );

    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(await screen.findByText("Blog Writing"));

    // The row is there IMMEDIATELY, in the saving state, with its remove
    // control inert.
    const row = await waitFor(() => {
      const el = document.querySelector('[data-slot="agent-skills-row"]');
      if (!el) throw new Error("no row yet");
      return el;
    });
    expect(row.getAttribute("data-status")).toBe("saving");
    expect(screen.getByText("Saving")).toBeTruthy();
    expect(
      (row.querySelector('[data-slot="agent-skills-remove"]') as HTMLButtonElement).disabled,
    ).toBe(true);

    await act(async () => {
      release?.();
    });
    await waitFor(() =>
      expect(
        document
          .querySelector('[data-slot="agent-skills-row"]')
          ?.getAttribute("data-status"),
      ).toBe("ok"),
    );
  });

  it("ROLLS BACK and explains when the save refuses", async () => {
    const assign = vi.fn(async () => ({ ok: false as const, reason: "not-assignable" }));
    render(
      <AgentSkillsConfigClient
        cap={3}
        initialRows={[]}
        search={narrowingSearch()}
        assign={assign}
        remove={okWrite()}
      />,
    );

    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(await screen.findByText("Blog Writing"));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Couldn't add Blog Writing"));
    expect(screen.getByRole("alert").textContent).toContain("that skill is no longer available");
    expect(screen.getByRole("alert").textContent).toContain("Nothing was changed.");
    // The list is exactly what it was.
    expect(document.querySelectorAll('[data-slot="agent-skills-row"]').length).toBe(0);
    expect(screen.getByText(/^0 of 3 skills chosen/)).toBeTruthy();
  });

  it("REGRESSION (codex round A): two concurrent refusals BOTH stay explained", async () => {
    // One error slot means the second refusal overwrites the first, and the
    // first row vanishes with no explanation at all.
    const assign = vi.fn(async (skillId: string) => ({
      ok: false as const,
      reason: skillId === "s-blog-writing" ? "not-assignable" : "cap-exceeded",
    }));
    render(
      <AgentSkillsConfigClient
        cap={3}
        initialRows={[]}
        search={narrowingSearch()}
        assign={assign}
        remove={okWrite()}
      />,
    );

    const input = screen.getByRole("combobox");
    fireEvent.click(input);
    fireEvent.click(await screen.findByText("Blog Writing"));
    fireEvent.click(input);
    fireEvent.click(await screen.findByText("Company Research"));

    await waitFor(() => expect(assign).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      const text = screen.getByRole("alert").textContent ?? "";
      expect(text).toContain("Couldn't add Blog Writing");
      expect(text).toContain("Couldn't add Company Research");
    });
    expect(document.querySelectorAll('[data-slot="agent-skills-row"]').length).toBe(0);
  });

  it("a skill's message clears when ITS OWN next change starts, not when a sibling's does", async () => {
    const assign = vi.fn(async () => ({ ok: false as const, reason: "not-assignable" }));
    render(
      <AgentSkillsConfigClient
        cap={3}
        initialRows={[]}
        search={narrowingSearch()}
        assign={assign}
        remove={okWrite()}
      />,
    );
    const input = screen.getByRole("combobox");
    fireEvent.click(input);
    fireEvent.click(await screen.findByText("Blog Writing"));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Couldn't add Blog Writing"),
    );

    // Re-picking the SAME skill clears its own stale message before retrying.
    fireEvent.click(input);
    fireEvent.click(await screen.findByText("Blog Writing"));
    await waitFor(() => expect(assign).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      const paragraphs = screen.getByRole("alert").querySelectorAll("p");
      expect(paragraphs.length).toBe(1);
    });
  });

  it("surfaces the picker's ERROR row when the SEARCH refuses (never an empty list)", async () => {
    const search = vi.fn(async () => ({ ok: false as const, reason: "eligibility-unreadable" }));
    render(
      <AgentSkillsConfigClient
        cap={3}
        initialRows={[]}
        search={search}
        assign={okWrite()}
        remove={okWrite()}
      />,
    );
    fireEvent.click(screen.getByRole("combobox"));
    await waitFor(() => expect(screen.getByText(/Couldn't search/)).toBeTruthy());
    expect(screen.queryByText("No matches.")).toBeNull();
  });
});

describe("the cap of three, and the floor that is not there", () => {
  it("DISABLES the chooser at three and says what to do about it", () => {
    render(
      <AgentSkillsConfigClient
        cap={3}
        initialRows={CANDIDATES.map((c) => rowFor(c))}
        search={narrowingSearch()}
        assign={okWrite()}
        remove={okWrite()}
      />,
    );
    expect((screen.getByRole("combobox") as HTMLInputElement).disabled).toBe(true);
    expect(
      screen.getByText("3 of 3 skills chosen — remove one to choose another."),
    ).toBeTruthy();
  });

  it("removes every row, one at a time, DOWN TO ZERO — no last-row floor", async () => {
    const remove = okWrite();
    render(
      <AgentSkillsConfigClient
        cap={3}
        initialRows={[rowFor(CANDIDATES[0]!), rowFor(CANDIDATES[1]!)]}
        search={narrowingSearch()}
        assign={okWrite()}
        remove={remove}
      />,
    );

    for (const expected of [1, 0]) {
      const button = document.querySelector(
        '[data-slot="agent-skills-remove"]',
      ) as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      fireEvent.click(button);
      await waitFor(() =>
        expect(document.querySelectorAll('[data-slot="agent-skills-row"]').length).toBe(expected),
      );
    }
    expect(remove).toHaveBeenCalledTimes(2);
    // Zero rows: the chooser is live again and the hint is warning-free.
    expect((screen.getByRole("combobox") as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByText(/^0 of 3 skills chosen/)).toBeTruthy();
  });

  it("keeps a DEGRADED row visible, badged, and fully removable", async () => {
    const remove = okWrite();
    render(
      <AgentSkillsConfigClient
        cap={3}
        initialRows={[rowFor(CANDIDATES[0]!, "archived"), rowFor(CANDIDATES[1]!, "role-changed")]}
        search={narrowingSearch()}
        assign={okWrite()}
        remove={remove}
      />,
    );

    const archived = document.querySelector(
      '[data-slot="agent-skills-row"][data-status="archived"]',
    );
    expect(archived).toBeTruthy();
    expect(screen.getByText("Archived")).toBeTruthy();
    expect(screen.getByText("Role changed")).toBeTruthy();
    // A degraded row counts toward the cap.
    expect(screen.getByText(/^2 of 3 skills chosen/)).toBeTruthy();

    const button = archived!.querySelector(
      '[data-slot="agent-skills-remove"]',
    ) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(remove).toHaveBeenCalledWith("s-company-research"));
    await waitFor(() =>
      expect(
        document.querySelector('[data-slot="agent-skills-row"][data-status="archived"]'),
      ).toBeNull(),
    );
  });

  it("KEEPS the row and explains when a removal refuses", async () => {
    const remove = vi.fn(async () => ({ ok: false as const, reason: "forbidden" }));
    render(
      <AgentSkillsConfigClient
        cap={3}
        initialRows={[rowFor(CANDIDATES[0]!)]}
        search={narrowingSearch()}
        assign={okWrite()}
        remove={remove}
      />,
    );
    fireEvent.click(
      document.querySelector('[data-slot="agent-skills-remove"]') as HTMLButtonElement,
    );
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Couldn't remove Company Research"),
    );
    expect(document.querySelectorAll('[data-slot="agent-skills-row"]').length).toBe(1);
  });
});

describe("row chrome", () => {
  it("gives every row but the LAST a bottom rule — from an isLast flag, not :last-child", () => {
    render(
      <AgentSkillsConfigClient
        cap={3}
        initialRows={CANDIDATES.map((c) => rowFor(c))}
        search={narrowingSearch()}
        assign={okWrite()}
        remove={okWrite()}
      />,
    );
    const rows = [...document.querySelectorAll('[data-slot="agent-skills-row"]')];
    expect(rows.length).toBe(3);
    expect(rows[0]!.className).toContain("border-b");
    expect(rows[1]!.className).toContain("border-b");
    expect(rows[2]!.className).not.toContain("border-b");
    // The rule is never delegated to the CSS pseudo-class.
    for (const row of rows) expect(row.className).not.toContain("last:");
  });

  it("renders the providing extension and its vendor, and drops the vendor clause when there is none", () => {
    render(
      <AgentSkillsConfigClient
        cap={3}
        initialRows={[rowFor(CANDIDATES[0]!), rowFor(CANDIDATES[2]!)]}
        search={narrowingSearch()}
        assign={okWrite()}
        remove={okWrite()}
      />,
    );
    expect(screen.getByText("Research Toolkit · by Northstar")).toBeTruthy();
    expect(screen.getByText("Brand Kit")).toBeTruthy();
  });

  it("labels the remove control with the skill it removes", () => {
    render(
      <AgentSkillsConfigClient
        cap={3}
        initialRows={[rowFor(CANDIDATES[0]!)]}
        search={narrowingSearch()}
        assign={okWrite()}
        remove={okWrite()}
      />,
    );
    expect(screen.getByLabelText("Remove Company Research")).toBeTruthy();
  });

  it("associates the EXTERNAL label with the chooser input", () => {
    render(
      <AgentSkillsConfigClient
        cap={3}
        initialRows={[]}
        search={narrowingSearch()}
        assign={okWrite()}
        remove={okWrite()}
      />,
    );
    const input = screen.getByRole("combobox");
    const label = document.querySelector("label[for]") as HTMLLabelElement;
    expect(label.htmlFor).toBe(input.id);
    expect(label.textContent).toBe("Which skills should this agent always use?");
  });
});
