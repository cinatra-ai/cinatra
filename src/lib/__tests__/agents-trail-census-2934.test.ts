// THE AGENTS-AREA TRAIL CENSUS (cinatra#2934).
//
// The ratified components drawing, §Breadcrumb: "The trail is the navigation
// hierarchy … Every trail under the agents area starts with 'Agents'; under an
// agent instance the trail names the agent's display name, as it is written
// there ('Agents › Blog Draft Writer Agent (1)'), and the page that starts a
// run reads 'Agents › Agent run' … A review has no trail of its own …
// 'Agents › Agent run › Review' is not a possible breadcrumb … an id never
// stands where a name belongs", and "A page that is not found has no hierarchy
// … Its breadcrumb reads 'Page not found' and nothing else: one crumb, current,
// with no parent above it".
//
// The pins beside this file hold each of those sentences on the route kinds
// they were written for. This file holds them on EVERY route kind the composer
// draws under the agents area, and it reads the kinds from the route tree
// itself: a page added under the area or under an agent instance, and not
// listed here, fails the census before its trail is ever drawn.
//
// Pure: the composer takes every live input as an argument, so nothing is
// mocked; the one temporary route tree the census reads to prove itself is
// removed again.

import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { CrumbContribution } from "../breadcrumb-contributions";
import {
  buildBreadcrumbTrail,
  isIdLikeSegment,
  type BreadcrumbCrumb,
} from "../breadcrumb-trail";

const AGENTS_APP_DIR = fileURLToPath(new URL("../../app/agents/", import.meta.url));
const INSTANCE_DIR = "[vendor]/[packageName]/[instanceId]";

// The drawing's own words, written here as the contract rather than imported
// from the composer, so a changed product constant cannot keep this census
// green.
const AGENT_RUN = "Agent run";
const PAGE_NOT_FOUND = "Page not found";

/** Every page file below `dir`, as its path relative to `dir`: route groups,
 *  dynamic segments and nested pages included, test folders left out. */
function pageFiles(dir: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(dir, rel))) {
    if (e === "__tests__") continue;
    const child = rel ? `${rel}/${e}` : e;
    if (statSync(join(dir, child)).isDirectory()) out.push(...pageFiles(dir, child));
    else if (e === "page.tsx") out.push(child);
  }
  return out.sort();
}

// THE CENSUS. Each kind names the route it stands for; the page files they
// stand for are held equal to the route tree below.
const AREA_PAGES = ["executions", "reviews"] as const;
const INSTANCE_SUBROUTES = [
  "data",
  "optimization",
  "permissions",
  "results",
  "review",
  "skills",
  "trigger",
] as const;

const RUN_ID = "aced3514-1f8e-4a44-9c1e-2b6f0f5a77d1";
const REVIEW_TASK_ID = "1f0b1f2e-7c4d-4e2a-9b1e-3d5f6a7b8c9d";
const RUN_PATH = `/agents/cinatra-ai/blog-draft-writer-agent/${RUN_ID}`;
const RUN_NAME = "Blog Draft Writer Agent (1)";

/** The name the run's own route publishes after its access checks. */
const RESOLVED: readonly CrumbContribution[] = [{ prefix: RUN_PATH, label: RUN_NAME }];

/** The page file each census kind stands for, relative to the area. */
const CENSUS_PAGE_FILES = [
  "page.tsx",
  ...AREA_PAGES.map((page) => `${page}/page.tsx`),
  `${INSTANCE_DIR}/page.tsx`,
  ...INSTANCE_SUBROUTES.map(
    (sub) => `${INSTANCE_DIR}/${sub === "review" ? "review/[reviewTaskId]" : sub}/page.tsx`,
  ),
].sort();

function subRoutePath(sub: string): string {
  // The review answers one level deeper, at its task's own id.
  return sub === "review" ? `${RUN_PATH}/review/${REVIEW_TASK_ID}` : `${RUN_PATH}/${sub}`;
}

type Kind = {
  kind: string;
  pathname: string;
  contributions?: readonly CrumbContribution[];
  pageTitle?: { title: string; pathname: string };
  /** The name that resolves at the run's position, when one was published. */
  resolvedName?: string;
};

const KINDS: Kind[] = [
  { kind: "area root (run-starting page), first render", pathname: "/agents" },
  {
    kind: "area root (run-starting page), title published",
    pathname: "/agents",
    pageTitle: { title: AGENT_RUN, pathname: "/agents" },
  },
  ...AREA_PAGES.map((page) => ({ kind: `area page /agents/${page}`, pathname: `/agents/${page}` })),
  {
    kind: "agent instance, name resolved",
    pathname: RUN_PATH,
    contributions: RESOLVED,
    resolvedName: RUN_NAME,
  },
  { kind: "agent instance, no name published", pathname: RUN_PATH },
  ...INSTANCE_SUBROUTES.flatMap((sub) => [
    {
      kind: `instance sub-route ${sub}, name resolved`,
      pathname: subRoutePath(sub),
      contributions: RESOLVED,
      resolvedName: RUN_NAME,
    },
    { kind: `instance sub-route ${sub}, no name published`, pathname: subRoutePath(sub) },
  ]),
];

const EIGHT_HEX_WITH_ELLIPSIS = /[0-9a-f]{8}(?:…|\.\.\.)/i;

/** A label's letters and digits only, lower-cased: a humanized id
 *  ("Aced3514 1F8e 4A44 …") reads as the id itself once normalized. */
const normalized = (text: string): string => text.toLowerCase().replace(/[^0-9a-z]/g, "");

/** Every way a trail under the agents area breaks the drawing's per-kind
 *  sentence; empty when it keeps it. */
function violations(k: Kind, trail: BreadcrumbCrumb[]): string[] {
  const out: string[] = [];
  const labels = trail.map((c) => c.label);
  if (labels[0] !== "Agents") out.push(`does not start with "Agents": ${labels.join(" › ")}`);
  const rawIds = k.pathname.split("/").filter((s) => s && isIdLikeSegment(s));
  for (const label of labels) {
    if (EIGHT_HEX_WITH_ELLIPSIS.test(label)) out.push(`names a shortened id: "${label}"`);
    if (isIdLikeSegment(label.replace(/\s+/g, ""))) out.push(`names a humanized id: "${label}"`);
    for (const id of rawIds) {
      if (normalized(label).includes(normalized(id))) out.push(`names a raw id: "${label}"`);
    }
    if (/^\s*review\s*$/i.test(label)) out.push(`carries a "Review" crumb: ${labels.join(" › ")}`);
  }
  if (k.resolvedName !== undefined && labels[1] !== k.resolvedName) {
    out.push(`does not name the resolved name "${k.resolvedName}": ${labels.join(" › ")}`);
  }
  return out;
}

describe("the census covers every route kind under the agents area", () => {
  it("stands for every page file of the area, nested and grouped pages included", () => {
    expect(pageFiles(AGENTS_APP_DIR)).toEqual(CENSUS_PAGE_FILES);
  });

  it("its route reading finds a nested page and a page inside a route group", () => {
    const root = mkdtempSync(join(tmpdir(), "agents-trail-census-"));
    try {
      for (const rel of ["page.tsx", "results/history/page.tsx", "(group)/new-page/page.tsx", "__tests__/page.tsx"]) {
        mkdirSync(join(root, rel, ".."), { recursive: true });
        writeFileSync(join(root, rel), "");
      }
      expect(pageFiles(root)).toEqual(["(group)/new-page/page.tsx", "page.tsx", "results/history/page.tsx"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("its id reading refuses a shortened, a raw and a humanized id", () => {
    const k: Kind = { kind: "self-check", pathname: `${RUN_PATH}/review/${REVIEW_TASK_ID}` };
    const trailOf = (label: string): BreadcrumbCrumb[] => [
      { label: "Agents", href: "/agents" },
      { label, href: RUN_PATH },
    ];
    expect(violations(k, trailOf("aced3514…"))).not.toEqual([]);
    expect(violations(k, trailOf(RUN_ID))).not.toEqual([]);
    expect(violations(k, trailOf("Aced3514 1F8e 4A44 9C1e 2B6f0f5a77d1"))).not.toEqual([]);
    expect(violations(k, trailOf("1f0b1f2e 7c4d 4e2a 9b1e 3d5f6a7b8c9d"))).not.toEqual([]);
    expect(violations(k, trailOf(RUN_NAME))).toEqual([]);
  });
});

describe("every trail under the agents area is the navigation hierarchy", () => {
  it.each(KINDS.map((k) => [k.kind, k] as const))("%s", (_name, k) => {
    const trail = buildBreadcrumbTrail(k.pathname, {
      contributions: k.contributions ?? [],
      pageTitle: k.pageTitle ?? null,
    });
    expect(violations(k, trail)).toEqual([]);
  });

  it("the run-starting page reads Agents › Agent run from the first render", () => {
    expect(buildBreadcrumbTrail("/agents").map((c) => c.label)).toEqual(["Agents", AGENT_RUN]);
  });

  it("the review is read under its run's own trail, with no crumb of its own", () => {
    expect(
      buildBreadcrumbTrail(subRoutePath("review"), { contributions: RESOLVED }).map((c) => c.label),
    ).toEqual(["Agents", RUN_NAME]);
  });
});

describe("a page that is not found has no hierarchy, on every route kind", () => {
  const typed = [...KINDS.map((k) => k.pathname), `/agents/cinatra-ai/blog-draft-writer-agent/no-such-run`];
  it.each([...new Set(typed)].map((p) => [p] as const))("%s", (pathname) => {
    const trail = buildBreadcrumbTrail(pathname, { contributions: RESOLVED, notFound: true });
    expect(trail).toHaveLength(1);
    expect(trail[0].label).toBe(PAGE_NOT_FOUND);
    expect(trail[0].nonNavigable).toBe(true);
  });
});
