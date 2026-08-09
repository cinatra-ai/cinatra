/**
 * cinatra#2502 — the step rail's THREE STATES and its link affordances, pinned
 * against the design spec `specs/app-setup.html` revision 0.3.0
 * (design commit 052bfb5f5ec7545124e50d2adf656d9adc80eca1).
 *
 * The sections these assert:
 *   §III  done / current / upcoming, and only those three; the check belongs to
 *         done alone; the connector into a done step is solid green; and the
 *         precedence rule — DONE WINS over current, with `aria-current`
 *         reporting the page on screen whatever colour the pill is wearing.
 *   §IV   which pills are links, and the dress a navigable pill wears in
 *         whichever state it is in — hover lift plus a 2px focus ring in the
 *         pill's own state colour. The rail's one navigable UPCOMING pill (the
 *         return link) had neither before this issue.
 *   §VI   the pre-sign-up rail is a forecast: nothing done, nothing clickable.
 *
 * Same convention as ./setup-step-nav-account-pill.test.tsx — no RTL/jsdom
 * runner is configured for this surface, so the leaf client component is
 * rendered to static markup with the Next.js navigation/link seams stubbed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { SetupWizardStep } from "@/lib/setup-step-state";

vi.mock("next/navigation", () => ({
  usePathname: vi.fn(),
}));
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: React.ReactNode;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) =>
    React.createElement("a", { href, ...rest }, children),
}));

/** The wizard's five steps, in rail order (cinatra#2502 — Secrets included). */
function rail(overrides: Partial<Record<string, SetupWizardStep["status"]>> = {}): SetupWizardStep[] {
  const base: SetupWizardStep[] = [
    { id: "sign-up", title: "Account", href: "/setup/account", status: "upcoming" },
    { id: "key", title: "Key", href: "/setup/key", status: "upcoming" },
    { id: "name", title: "Name", href: "/setup/name", status: "upcoming" },
    { id: "secrets", title: "Secrets", href: "/setup/secrets", status: "upcoming" },
    { id: "ai", title: "Model", href: "/setup/model", status: "upcoming" },
  ];
  return base.map((s) => (overrides[s.id] ? { ...s, status: overrides[s.id]! } : s));
}

/** Every pill element's markup, in rail order. */
function pills(html: string): string[] {
  return [
    ...html.matchAll(/<(?:a|span)[^>]*class="[^"]*rounded-full[^"]*"[^>]*>[\s\S]*?<\/(?:a|span)>/g),
  ].map((m) => m[0]);
}

async function render(steps: SetupWizardStep[], pathname: string): Promise<string> {
  const { usePathname } = await import("next/navigation");
  (usePathname as unknown as ReturnType<typeof vi.fn>).mockReturnValue(pathname);
  const { SetupStepNav } = await import("../setup-step-nav");
  return renderToStaticMarkup(<SetupStepNav steps={steps} />);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the rail stays a CLIENT component — it must not drag the server graph in", () => {
  it("imports the state model from @/lib/setup-step-state, never from the server-only @/lib/setup-wizard", () => {
    const source = readFileSync(
      path.resolve(__dirname, "../setup-step-nav.tsx"),
      "utf8",
    );
    // The rail is `"use client"`, and `@/lib/setup-wizard` reaches
    // `import "server-only"` through the provider-commit machine / Nango status
    // reader / instance-identity store. A VALUE import from it compiles that
    // whole graph into the client bundle and every setup page 500s with
    // "'server-only' cannot be imported from a Client Component module" — which
    // is exactly what happened while cinatra#2502 was being built, and what the
    // browser proof caught.
    expect(source).toContain('"use client"');
    expect(source).toContain('from "@/lib/setup-step-state"');
    // A TYPE-only import would be erased and is harmless; a value import is not.
    // Forbid the module outright here — nothing this component needs lives
    // only in the wizard module, so there is no legitimate reason to name it.
    expect(source).not.toContain('from "@/lib/setup-wizard"');
  });

  it("the state model module itself imports NOTHING — that is what makes it safe on both sides", () => {
    const source = readFileSync(
      path.resolve(__dirname, "../../../lib/setup-step-state.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/^\s*import\s/m);
  });
});

describe("§III — the three states, and only three", () => {
  it("done is green + checked, current is the solid-bordered primary with NO check, upcoming is the untinted muted pill", async () => {
    const html = await render(
      rail({ "sign-up": "done", key: "done" }),
      "/setup/name",
    );
    const [account, key, name, secrets, model] = pills(html);

    // done — success tint, success hairline, and the check glyph.
    for (const done of [account, key]) {
      expect(done).toContain("bg-success/10");
      expect(done).toContain("border-success/30");
      expect(done).toContain("text-success");
      expect(done).toContain("<svg");
    }
    // current — the one FULL-STRENGTH border on the rail, and no check.
    expect(name).toContain("bg-primary/10");
    expect(name).toMatch(/border-primary(?![\w/-])/);
    expect(name).toContain("text-primary");
    expect(name).not.toContain("<svg");
    // upcoming — untinted white, hairline, muted, no check.
    for (const upcoming of [secrets, model]) {
      expect(upcoming).toContain("bg-surface-strong");
      expect(upcoming).toContain("border-line");
      expect(upcoming).toContain("text-muted-foreground");
      expect(upcoming).not.toContain("<svg");
    }
  });

  it("the check glyph belongs to done ALONE — the count of checks equals the count of done steps", async () => {
    const html = await render(rail({ "sign-up": "done", key: "done", name: "done" }), "/setup/secrets");
    const checked = pills(html).filter((p) => p.includes("<svg"));
    expect(checked).toHaveLength(3);
    for (const p of checked) expect(p).toContain("text-success");
  });

  it("the connector leading INTO a done step is solid green; every other connector is the hairline", async () => {
    // Account, Key done → the connector into Key is green; the three after are not.
    const html = await render(rail({ "sign-up": "done", key: "done" }), "/setup/name");
    const connectors = [...html.matchAll(/class="([^"]*h-0\.5[^"]*)"/g)].map((m) => m[1]);
    expect(connectors).toHaveLength(4);
    expect(connectors[0]).toContain("bg-success"); // into Key (done)
    expect(connectors[1]).toContain("bg-line"); //    into Name (current)
    expect(connectors[2]).toContain("bg-line"); //    into Secrets (upcoming)
    expect(connectors[3]).toContain("bg-line"); //    into Model (upcoming)
  });

  it("PRECEDENCE — done wins over current: a passed step the operator navigated BACK to stays green and checked, and only aria-current says where they are", async () => {
    // Standing on /setup/key, which has already been passed.
    const html = await render(rail({ "sign-up": "done", key: "done" }), "/setup/key");
    const [, key] = pills(html);

    // The colour answers "have I done this?" …
    expect(key).toContain("bg-success/10");
    expect(key).toContain("text-success");
    expect(key).toContain("<svg");
    expect(key).not.toContain("bg-primary/10");
    // … and the accessible state answers "where am I?", independently.
    expect(key).toContain('aria-current="step"');
    // Exactly one pill on the rail claims to be the page on screen.
    expect(pills(html).filter((p) => p.includes('aria-current="step"'))).toHaveLength(1);
  });

  it("a passed step never un-checks by being looked at again — no state produces a fourth treatment", async () => {
    const html = await render(rail({ "sign-up": "done", key: "done", name: "done", secrets: "done" }), "/setup/secrets");
    // Four done pills, all identical in treatment (uniform: the owner's
    // 2026-08-07 decision — however the step was satisfied, passed is checked).
    const done = pills(html).filter((p) => p.includes("text-success"));
    expect(done).toHaveLength(4);
    for (const p of done) {
      expect(p).toContain("bg-success/10");
      expect(p).toContain("border-success/30");
      expect(p).toContain("<svg");
    }
  });
});

describe("§IV — a navigable pill is dressed as a link in whichever state it wears", () => {
  it("THE UPCOMING RETURN LINK carries the hover lift AND the 2px focus ring (cinatra#2502, owner 2026-08-08)", async () => {
    // The operator went BACK to the completed Key step. The first incomplete
    // step (Name) is then the rail's one navigable upcoming pill.
    const html = await render(rail({ "sign-up": "done", key: "done" }), "/setup/key");
    const name = pills(html)[2];

    expect(name).toContain('href="/setup/name?stay=1"');
    // Wearing the upcoming treatment…
    expect(name).toContain("bg-surface-strong");
    expect(name).toContain("text-muted-foreground");
    // …AND dressed as a link in that state. Before this issue it had neither:
    // no hover response for a mouse user, no focus ring for a keyboard one.
    expect(name).toContain("hover:bg-surface-muted");
    expect(name).toContain("focus-visible:ring-2");
    expect(name).toContain("focus-visible:ring-muted-foreground/40");
    expect(name).toContain("focus-visible:outline-none");
  });

  it("a navigable DONE pill keeps its own hover lift and ring, drawn in the success colour", async () => {
    const html = await render(rail({ "sign-up": "done", key: "done" }), "/setup/name");
    const key = pills(html)[1];
    expect(key).toContain('href="/setup/key?stay=1"');
    expect(key).toContain("hover:bg-success/15");
    expect(key).toContain("focus-visible:ring-2");
    expect(key).toContain("focus-visible:ring-success/40");
  });

  it("an INERT pill is a plain element — no link, no hover response, no focus stop", async () => {
    const html = await render(rail({ "sign-up": "done", key: "done" }), "/setup/name");
    const [account, , name, secrets, model] = pills(html);
    // The page on screen is never a link, whatever state it wears (§IV).
    expect(name).toMatch(/^<span/);
    expect(name).not.toContain("hover:");
    expect(name).not.toContain("focus-visible:");
    // Every upcoming step AFTER the first is always inert — the rail never
    // offers to skip forward past unfinished work.
    expect(secrets).toMatch(/^<span/);
    expect(secrets).not.toContain("hover:");
    expect(model).toMatch(/^<span/);
    expect(model).not.toContain("hover:");
    // The account step is the one done step that is never a link: its form
    // cannot render twice, so a link there would be a silent bounce.
    expect(account).toMatch(/^<span/);
    expect(account).not.toContain("hover:");
  });

  it("the return link appears ONLY once something is done — a rail with no progress offers nothing to navigate against", async () => {
    const html = await render(rail(), "/setup/account");
    expect(html).not.toMatch(/<a /);
  });

  it("standing ON the first upcoming step, its own pill is the page on screen and therefore inert", async () => {
    const html = await render(rail({ "sign-up": "done", key: "done" }), "/setup/name");
    const name = pills(html)[2];
    expect(name).toMatch(/^<span/);
    expect(name).toContain('aria-current="step"');
  });
});

describe("§VI — the pre-sign-up rail is a forecast, not a status", () => {
  it("carries every step including Secrets, all upcoming, one current, nothing checked, nothing clickable", async () => {
    const html = await render(rail(), "/setup/account");
    const rendered = pills(html);
    expect(rendered).toHaveLength(5);
    expect(html).toContain("Secrets");
    // One current (the page on screen), the rest upcoming.
    expect(rendered.filter((p) => p.includes("bg-primary/10"))).toHaveLength(1);
    expect(rendered.filter((p) => p.includes("bg-surface-strong"))).toHaveLength(4);
    // Nothing done: no check glyph and no green connector anywhere.
    expect(html).not.toContain("bg-success");
    expect(html).not.toContain("<svg");
    // Nothing clickable.
    expect(html).not.toMatch(/<a /);
  });

  it("is a five-step rail, so §V's dense 20px connector applies to it too", async () => {
    const html = await render(rail(), "/setup/account");
    const connectors = [...html.matchAll(/class="([^"]*h-0\.5[^"]*)"/g)].map((m) => m[1]);
    expect(connectors).toHaveLength(4);
    for (const cls of connectors) {
      expect(cls).toContain("w-5");
      expect(cls).not.toContain("w-10");
    }
  });
});

describe("§VII — the rail carries exactly one Secrets pill, in every state", () => {
  const SCREENS: Array<{ label: string; steps: SetupWizardStep[]; pathname: string }> = [
    { label: "before sign-up", steps: rail(), pathname: "/setup/account" },
    {
      label: "mid-flow, Secrets not yet reached",
      steps: rail({ "sign-up": "done", key: "done" }),
      pathname: "/setup/name",
    },
    {
      label: "standing on Secrets",
      steps: rail({ "sign-up": "done", key: "done", name: "done" }),
      pathname: "/setup/secrets",
    },
    {
      label: "Secrets passed",
      steps: rail({ "sign-up": "done", key: "done", name: "done", secrets: "done" }),
      pathname: "/setup/model",
    },
    {
      label: "back on an earlier step after Secrets was passed",
      steps: rail({ "sign-up": "done", key: "done", name: "done", secrets: "done" }),
      pathname: "/setup/name",
    },
  ];

  for (const screen of SCREENS) {
    it(`draws exactly one Secrets pill — ${screen.label}`, async () => {
      const html = await render(screen.steps, screen.pathname);
      const secrets = pills(html).filter((p) => p.includes("Secrets"));
      expect(secrets).toHaveLength(1);
    });
  }

  it("its STATE moves upcoming → current → done while its presence never changes", async () => {
    const secretsPill = async (steps: SetupWizardStep[], pathname: string) =>
      pills(await render(steps, pathname)).find((p) => p.includes("Secrets"))!;

    expect(await secretsPill(rail({ "sign-up": "done" }), "/setup/key")).toContain(
      "bg-surface-strong",
    );
    expect(
      await secretsPill(rail({ "sign-up": "done", key: "done", name: "done" }), "/setup/secrets"),
    ).toContain("bg-primary/10");
    const passed = await secretsPill(
      rail({ "sign-up": "done", key: "done", name: "done", secrets: "done" }),
      "/setup/model",
    );
    expect(passed).toContain("bg-success/10");
    expect(passed).toContain("<svg");
  });
});
