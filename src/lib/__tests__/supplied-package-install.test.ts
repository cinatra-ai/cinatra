/**
 * THE ROAD THE UPLOAD SCREEN TAKES (cinatra#3204 leg 3 — criteria 7, 8, 18, 19,
 * 20, 22 and the anchor half of 28).
 *
 * The claims:
 *   - a repository install re-reads AT THE PIN and refuses a commit or a digest
 *     that does not reproduce, before anything is packed or staged;
 *   - the kind's own validator runs before the packer on this road too;
 *   - the install goes through the SAME dispatcher a store install goes through,
 *     carrying the DECLARED provenance and the CHOSEN row anchor — so the row is
 *     never a registry claim and never anchored somewhere the operator did not
 *     choose;
 *   - two different anchors for the same package are two different row
 *     identities (the tenancy separation the anchor is for).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// The ORDER of the two things the dispatch entry does, recorded as it happens.
// `extensionRegistry` is per-process state: a Server Action worker holds only
// the handlers something in its own import graph registered, so a road that
// dispatches without pulling the registration in first answers every kind with
// `No extension handler registered for typeId: "<kind>"`.
const order = vi.hoisted(() => ({ events: [] as string[] }));
vi.mock("@cinatra-ai/extensions/handler-bootstrap", () => {
  order.events.push("handlers-registered");
  return {};
});

const registry = vi.hoisted(() => ({
  extensionRegistry: {
    install: vi.fn(async () => {
      order.events.push("dispatch");
    }),
  },
}));
vi.mock("@cinatra-ai/extensions", () => registry);

const intake = vi.hoisted(() => ({
  fetchGitHubSuppliedPackageAtPin: vi.fn(),
}));
vi.mock("@cinatra-ai/skills/repository-package-intake", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchGitHubSuppliedPackageAtPin: (...a: unknown[]) =>
    intake.fetchGitHubSuppliedPackageAtPin(...(a as [])),
}));

// The FILE road's own intake, spied rather than replaced: the repository road's
// claim is that it ends up in exactly this call, so the test has to see the
// real one run AND see what it was handed.
const fileRoad = vi.hoisted(() => ({ prepareSuppliedArchiveSnapshot: vi.fn() }));
vi.mock("@/lib/archive-supplied-install", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const real = actual.prepareSuppliedArchiveSnapshot as (input: unknown) => Promise<unknown>;
  fileRoad.prepareSuppliedArchiveSnapshot.mockImplementation((input: unknown) => real(input));
  return { ...actual, prepareSuppliedArchiveSnapshot: fileRoad.prepareSuppliedArchiveSnapshot };
});

import {
  installSuppliedCandidate,
  prepareSuppliedRepositoryArchiveSnapshot,
  prepareSuppliedRepositorySnapshot,
} from "@/lib/supplied-package-install";
import { buildStoredZip } from "@cinatra-ai/agents/upload-archive";
import { SUPPLIED_PACKAGE_ORIGIN } from "@/lib/extension-install-pipeline";

const SHA = "b".repeat(40);
const DIGEST = "a".repeat(64);
const OTHER = "c".repeat(64);

function stagedPackage(over: Record<string, unknown> = {}) {
  return {
    kind: "skill",
    packageName: "@acme/thing-skill",
    version: "1.0.0",
    packageJson: JSON.stringify({
      name: "@acme/thing-skill",
      version: "1.0.0",
      cinatra: { kind: "skill" },
    }),
    payload: new Map(),
    contentDigest: DIGEST,
    strippedPrefix: null,
    deliveredEntries: new Map([["package.json", new Uint8Array([123, 125])]]),
    repo: "acme/thing",
    ref: "main",
    resolvedSha: SHA,
    treeSha: "t".repeat(40),
    entryCount: 1,
    totalBytes: 2,
    provenance: {
      type: "github",
      repo: "acme/thing",
      ref: "main",
      resolvedSha: SHA,
      contentDigest: DIGEST,
    },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  intake.fetchGitHubSuppliedPackageAtPin.mockResolvedValue(stagedPackage());
});

describe("the repository road re-reads AT THE PIN (criterion 7)", () => {
  it("stages the snapshot and records github provenance carrying the pinned sha", async () => {
    const stageSnapshot = vi.fn(async (digest: string) => `${digest}.tgz`);
    const prepared = await prepareSuppliedRepositorySnapshot({
      client: {} as never,
      owner: "acme",
      repo: "thing",
      ref: "main",
      pin: { resolvedSha: SHA, contentDigest: DIGEST },
      resolveValidator: async () => null,
      stageSnapshot,
    });
    expect(prepared.kind).toBe("skill");
    expect(prepared.resolvedSha).toBe(SHA);
    expect(prepared.provenance).toMatchObject({
      type: "github",
      repo: "acme/thing",
      resolvedSha: SHA,
      contentDigest: DIGEST,
      path: `${DIGEST}.tgz`,
    });
    // The ref is NOT resolved again — only the pinned read happens.
    expect(intake.fetchGitHubSuppliedPackageAtPin).toHaveBeenCalledTimes(1);
  });

  it("refuses a malformed pin before a single request is made", async () => {
    await expect(
      prepareSuppliedRepositorySnapshot({
        client: {} as never,
        owner: "acme",
        repo: "thing",
        ref: "main",
        pin: { resolvedSha: "not-a-sha", contentDigest: DIGEST },
      }),
    ).rejects.toThrow(/immutable 40-character commit sha/);
    expect(intake.fetchGitHubSuppliedPackageAtPin).not.toHaveBeenCalled();
  });

  it("refuses when the repository no longer delivers the previewed bytes, staging nothing", async () => {
    intake.fetchGitHubSuppliedPackageAtPin.mockResolvedValue(
      stagedPackage({ contentDigest: OTHER, provenance: { type: "github", repo: "acme/thing", ref: "main", resolvedSha: SHA, contentDigest: OTHER } }),
    );
    const stageSnapshot = vi.fn(async () => "never.tgz");
    await expect(
      prepareSuppliedRepositorySnapshot({
        client: {} as never,
        owner: "acme",
        repo: "thing",
        ref: "main",
        pin: { resolvedSha: SHA, contentDigest: DIGEST },
        resolveValidator: async () => null,
        stageSnapshot,
      }),
    ).rejects.toThrow(/no longer delivers the previewed bytes/);
    expect(stageSnapshot).not.toHaveBeenCalled();
  });

  it("runs the kind's own validator before the packer, and refuses when it rejects", async () => {
    const stageSnapshot = vi.fn(async () => "never.tgz");
    await expect(
      prepareSuppliedRepositorySnapshot({
        client: {} as never,
        owner: "acme",
        repo: "thing",
        ref: "main",
        pin: { resolvedSha: SHA, contentDigest: DIGEST },
        resolveValidator: async () => async () => ({ valid: false, errors: ["nope"] }),
        stageSnapshot,
      }),
    ).rejects.toThrow(/did not pass the skill validator/);
    expect(stageSnapshot).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// THE ANONYMOUS ARCHIVE (cinatra#3204 fix leg)
//
// The maintainer's ruling, in their words: "Anyone can download a ZIP of
// origin/main of a repo or a ZIP of a release — no need to be logged in at
// GitHub. The user provides that link and Cinatra gets the ZIP."
//
// The claim under test is the one that keeps this honest: the downloaded ZIP is
// handed to the FILE road's own intake, byte for byte. There is no second
// install road, no second reader and no second gate set — only different bytes
// arriving by a different door.
// ---------------------------------------------------------------------------

/** A GitHub-shaped source archive: one generated wrapper folder, and the commit
 *  id GitHub stamps into the ZIP's archive comment. */
function gitHubSourceArchive(over: { comment?: string; root?: string } = {}): Uint8Array {
  const root = over.root ?? "thing-main";
  const zip = buildStoredZip([
    {
      name: `${root}/package.json`,
      content: JSON.stringify({
        name: "@acme/thing-skill",
        version: "1.0.0",
        cinatra: { kind: "skill" },
      }),
    },
    { name: `${root}/SKILL.md`, content: "# thing\n" },
  ]);
  const comment = new TextEncoder().encode(over.comment ?? SHA);
  // Rewrite the end-of-central-directory record's comment field.
  const out = new Uint8Array(zip.byteLength + comment.byteLength);
  out.set(zip, 0);
  out.set(comment, zip.byteLength);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint16(zip.byteLength - 22 + 20, comment.byteLength, true);
  return out;
}

function respondWith(bytes: Uint8Array): typeof fetch {
  return (async () =>
    new Response(bytes as unknown as BodyInit, { status: 200 })) as unknown as typeof fetch;
}

function respondStatus(status: number, statusText = ""): typeof fetch {
  return (async () => new Response(null, { status, statusText })) as unknown as typeof fetch;
}

describe("the GitHub tab's archive enters the FILE road's install path", () => {
  it("hands the downloaded ZIP to the file road's own intake and records github provenance", async () => {
    const archive = gitHubSourceArchive();
    const stageSnapshot = vi.fn(async (digest: string) => `${digest}.tgz`);
    const prepared = await prepareSuppliedRepositoryArchiveSnapshot({
      owner: "acme",
      repo: "thing",
      ref: "main",
      archiveUrl: "https://codeload.github.com/acme/thing/zip/main",
      resolveValidator: async () => null,
      stageSnapshot,
      fetchImpl: respondWith(archive),
    });

    expect(fileRoad.prepareSuppliedArchiveSnapshot).toHaveBeenCalledTimes(1);
    const handed = fileRoad.prepareSuppliedArchiveSnapshot.mock.calls[0]![0] as {
      archive: Uint8Array;
    };
    expect(Array.from(handed.archive)).toEqual(Array.from(archive));

    expect(prepared.kind).toBe("skill");
    expect(prepared.packageName).toBe("@acme/thing-skill");
    expect(prepared.repo).toBe("acme/thing");
    expect(prepared.ref).toBe("main");
    expect(prepared.resolvedSha).toBe(SHA);
    expect(prepared.provenance).toMatchObject({
      type: "github",
      repo: "acme/thing",
      ref: "main",
      resolvedSha: SHA,
      path: `${prepared.contentDigest}.tgz`,
    });
  });

  it("refuses a link the anonymous download cannot serve, naming the reason", async () => {
    await expect(
      prepareSuppliedRepositoryArchiveSnapshot({
        owner: "acme",
        repo: "private-thing",
        ref: null,
        archiveUrl: "https://codeload.github.com/acme/private-thing/zip/HEAD",
        resolveValidator: async () => null,
        stageSnapshot: async () => "never.tgz",
        fetchImpl: respondStatus(404, "Not Found"),
      }),
    ).rejects.toThrow(/HTTP 404[\s\S]*anonymously/);

    await expect(
      prepareSuppliedRepositoryArchiveSnapshot({
        owner: "acme",
        repo: "thing",
        ref: null,
        archiveUrl: "https://codeload.github.com/acme/thing/zip/HEAD",
        resolveValidator: async () => null,
        stageSnapshot: async () => "never.tgz",
        fetchImpl: respondStatus(429, "Too Many Requests"),
      }),
    ).rejects.toThrow(/rate limit/i);
  });

  it("refuses an archive that carries no commit id, so nothing installs off a moving ref", async () => {
    await expect(
      prepareSuppliedRepositoryArchiveSnapshot({
        owner: "acme",
        repo: "thing",
        ref: null,
        archiveUrl: "https://codeload.github.com/acme/thing/zip/HEAD",
        resolveValidator: async () => null,
        stageSnapshot: async () => "never.tgz",
        fetchImpl: respondWith(gitHubSourceArchive({ comment: "not-a-commit-id" })),
      }),
    ).rejects.toThrow(/immutable 40-character commit sha/);
  });

  it("refuses when the download no longer delivers the previewed bytes", async () => {
    await expect(
      prepareSuppliedRepositoryArchiveSnapshot({
        owner: "acme",
        repo: "thing",
        ref: "main",
        archiveUrl: "https://codeload.github.com/acme/thing/zip/main",
        pin: { resolvedSha: SHA, contentDigest: OTHER },
        resolveValidator: async () => null,
        stageSnapshot: async () => "never.tgz",
        fetchImpl: respondWith(gitHubSourceArchive()),
      }),
    ).rejects.toThrow(/refusing before any write/);
  });
});

describe("the anonymous download is PINNED, BOUNDED and single-hosted", () => {
  it("downloads the APPROVED COMMIT, not the ref, so a branch that advanced still installs what was approved", async () => {
    const approved = gitHubSourceArchive({ root: "thing-approved" });
    // The same branch, one commit later: different bytes, a different commit id.
    const moved = gitHubSourceArchive({ root: "thing-moved", comment: "d".repeat(40) });

    // Learn the digest the operator was shown, from the approved archive alone.
    const previewed = await prepareSuppliedRepositoryArchiveSnapshot({
      owner: "acme",
      repo: "thing",
      ref: "main",
      archiveUrl: `https://codeload.github.com/acme/thing/zip/${SHA}`,
      resolveValidator: async () => null,
      stageSnapshot: async (digest: string) => `${digest}.tgz`,
      fetchImpl: respondWith(approved),
    });

    const asked: string[] = [];
    const serve = (async (url: string) => {
      asked.push(url);
      // The BRANCH now serves the newer commit; only the commit path serves the
      // tree the operator approved.
      return new Response((url.endsWith(SHA) ? approved : moved) as unknown as BodyInit, {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const prepared = await prepareSuppliedRepositoryArchiveSnapshot({
      owner: "acme",
      repo: "thing",
      ref: "main",
      archiveUrl: "https://codeload.github.com/acme/thing/zip/main",
      pin: { resolvedSha: SHA, contentDigest: previewed.contentDigest },
      resolveValidator: async () => null,
      stageSnapshot: async (digest: string) => `${digest}.tgz`,
      fetchImpl: serve,
    });

    expect(asked).toEqual([`https://codeload.github.com/acme/thing/zip/${SHA}`]);
    expect(prepared.resolvedSha).toBe(SHA);
    expect(prepared.contentDigest).toBe(previewed.contentDigest);
    // The row still records WHERE it was found, while naming WHAT was installed.
    expect(prepared.ref).toBe("main");
    expect(prepared.provenance).toMatchObject({ ref: "main", resolvedSha: SHA });
  });

  it("refuses an over-cap download from its DECLARED LENGTH, cancelling the body instead of draining it", async () => {
    let cancelled = false;
    const declared = (async () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }) as unknown as BodyInit,
        { status: 200, headers: { "content-length": String(512 * 1024 * 1024) } },
      )) as unknown as typeof fetch;

    await expect(
      prepareSuppliedRepositoryArchiveSnapshot({
        owner: "acme",
        repo: "huge",
        ref: null,
        archiveUrl: "https://codeload.github.com/acme/huge/zip/HEAD",
        resolveValidator: async () => null,
        stageSnapshot: async () => "never.tgz",
        fetchImpl: declared,
      }),
    ).rejects.toThrow(/over the 134217728-byte limit/);
    // The body was let go, never read to the end.
    expect(cancelled).toBe(true);
  });

  it("cancels an over-cap download WHILE it arrives, rather than allocating it first", async () => {
    // One 16 MiB chunk, served over and over: the running total passes the cap
    // long before anything that large is held in memory.
    const chunk = new Uint8Array(16 * 1024 * 1024);
    let served = 0;
    let cancelled = false;
    const endless = (async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            served += 1;
            controller.enqueue(chunk);
          },
          cancel() {
            cancelled = true;
          },
        }) as unknown as BodyInit,
        { status: 200 },
      )) as unknown as typeof fetch;

    await expect(
      prepareSuppliedRepositoryArchiveSnapshot({
        owner: "acme",
        repo: "endless",
        ref: null,
        archiveUrl: "https://codeload.github.com/acme/endless/zip/HEAD",
        resolveValidator: async () => null,
        stageSnapshot: async () => "never.tgz",
        fetchImpl: endless,
      }),
    ).rejects.toThrow(/over the 134217728-byte limit/);
    expect(cancelled).toBe(true);
    // 128 MiB is nine 16 MiB chunks; the tenth is where the running total passes
    // it. Nothing anywhere near a whole oversized archive was ever held.
    expect(served).toBeLessThanOrEqual(10);
  });

  it("refuses a redirect off the archive host instead of following it", async () => {
    const asked: string[] = [];
    const redirecting = (async (url: string) => {
      asked.push(url);
      return new Response(null, {
        status: 302,
        headers: { location: "https://evil.example.com/payload.zip" },
      });
    }) as unknown as typeof fetch;

    await expect(
      prepareSuppliedRepositoryArchiveSnapshot({
        owner: "acme",
        repo: "thing",
        ref: null,
        archiveUrl: "https://codeload.github.com/acme/thing/zip/HEAD",
        resolveValidator: async () => null,
        stageSnapshot: async () => "never.tgz",
        fetchImpl: redirecting,
      }),
    ).rejects.toThrow(/downloads only from codeload\.github\.com/);
    // The off-host destination was never requested.
    expect(asked).toEqual(["https://codeload.github.com/acme/thing/zip/HEAD"]);
  });

  // THE REQUEST URL IS ASSEMBLED FROM VALIDATED PARTS (cinatra#3204, the
  // code-scanning finding js/request-forgery at the candidate head). The link is
  // the operator's input by design, so the road may not fetch the string that
  // input produced: the endpoint is rebuilt from the fixed archive host and the
  // owner, repository and ref read out of it, each checked against a strict
  // pattern and percent-encoded. Anything that is not that endpoint is refused
  // BEFORE a request is made - the host check alone let a wrong path or a
  // wrong-shaped ref through to `fetch`.
  it("assembles the request URL from validated parts, refusing anything else before a request is made", async () => {
    const asked: string[] = [];
    const watching = (async (url: string) => {
      asked.push(url);
      return new Response(gitHubSourceArchive() as unknown as BodyInit, { status: 200 });
    }) as unknown as typeof fetch;

    const refused = [
      // A foreign host, a host that only LOOKS like the archive host, and the
      // archive host over plain http.
      "https://evil.example.com/acme/thing/zip/HEAD",
      "https://codeload.github.com.evil.example.com/acme/thing/zip/HEAD",
      "http://codeload.github.com/acme/thing/zip/HEAD",
      // The right host, a path that is not the public source archive.
      "https://codeload.github.com/acme/thing/tarball/HEAD",
      "https://codeload.github.com/acme/thing/zip/HEAD/../../../other",
      "https://codeload.github.com/acme/../evil/zip/HEAD",
      // A path segment outside the shape, or naming another repository.
      "https://codeload.github.com/ac%2Fme/thing/zip/HEAD",
      "https://codeload.github.com/someone-else/thing/zip/HEAD",
      // A ref outside the shape: a traversal, a query, a fragment, a leading "-".
      "https://codeload.github.com/acme/thing/zip/%2e%2e%2f%2e%2e%2fetc",
      "https://codeload.github.com/acme/thing/zip/HEAD?to=evil.example.com",
      "https://codeload.github.com/acme/thing/zip/HEAD#evil",
      "https://codeload.github.com/acme/thing/zip/-rf",
      "https://codeload.github.com/acme/thing/zip/",
      "not a url at all",
      "",
    ];

    for (const archiveUrl of refused) {
      await expect(
        prepareSuppliedRepositoryArchiveSnapshot({
          owner: "acme",
          repo: "thing",
          ref: null,
          archiveUrl,
          resolveValidator: async () => null,
          stageSnapshot: async () => "never.tgz",
          fetchImpl: watching,
        }),
      ).rejects.toThrow(/refusing to download an extension package/);
    }

    // NOT ONE of them was requested.
    expect(asked).toEqual([]);
  });

  it("asks for exactly the public source archive the link named, qualified refs and all", async () => {
    const asked: string[] = [];
    const watching = (async (url: string) => {
      asked.push(url);
      return new Response(gitHubSourceArchive() as unknown as BodyInit, { status: 200 });
    }) as unknown as typeof fetch;

    await prepareSuppliedRepositoryArchiveSnapshot({
      owner: "acme",
      repo: "thing",
      ref: "sample-release-tag",
      archiveUrl: "https://codeload.github.com/acme/thing/zip/refs/tags/sample-release-tag",
      resolveValidator: async () => null,
      stageSnapshot: async (digest: string) => `${digest}.tgz`,
      fetchImpl: watching,
    });

    expect(asked).toEqual([
      "https://codeload.github.com/acme/thing/zip/refs/tags/sample-release-tag",
    ]);
  });

  // A SCOPED RELEASE TAG is an ordinary, downloadable release - the shape a
  // monorepo publishes its packages under - and the link parser accepts it.
  // The rebuild must therefore ask for exactly the archive the parser named: a
  // ref shape STRICTER than the parser's is drift, and it refuses archives
  // GitHub serves.
  it("asks for a scoped release tag exactly as the link named it", async () => {
    const asked: string[] = [];
    const watching = (async (url: string) => {
      asked.push(url);
      return new Response(gitHubSourceArchive() as unknown as BodyInit, { status: 200 });
    }) as unknown as typeof fetch;

    await prepareSuppliedRepositoryArchiveSnapshot({
      owner: "acme",
      repo: "thing",
      ref: "@acme/widget@1.2.3",
      archiveUrl: "https://codeload.github.com/acme/thing/zip/refs/tags/%40acme/widget%401.2.3",
      resolveValidator: async () => null,
      stageSnapshot: async (digest: string) => `${digest}.tgz`,
      fetchImpl: watching,
    });

    expect(asked).toEqual([
      "https://codeload.github.com/acme/thing/zip/refs/tags/%40acme/widget%401.2.3",
    ]);
  });

  // A NON-ASCII BRANCH NAME is likewise the parser's to accept, and it survives
  // the rebuild percent-encoded exactly as the builder wrote it.
  it("asks for a non-ASCII branch name exactly as the link named it", async () => {
    const asked: string[] = [];
    const watching = (async (url: string) => {
      asked.push(url);
      return new Response(gitHubSourceArchive() as unknown as BodyInit, { status: 200 });
    }) as unknown as typeof fetch;

    await prepareSuppliedRepositoryArchiveSnapshot({
      owner: "acme",
      repo: "thing",
      ref: "feature/\u65e5\u672c\u8a9e",
      archiveUrl: `https://codeload.github.com/acme/thing/zip/feature/${encodeURIComponent("\u65e5\u672c\u8a9e")}`,
      resolveValidator: async () => null,
      stageSnapshot: async (digest: string) => `${digest}.tgz`,
      fetchImpl: watching,
    });

    expect(asked).toEqual([
      `https://codeload.github.com/acme/thing/zip/feature/${encodeURIComponent("\u65e5\u672c\u8a9e")}`,
    ]);
  });

  // THE OWNER SHAPE IS PINNED ON ITS OWN. In the table above every refusal could
  // also be explained by the endpoint naming another repository than the install
  // does; here the install names the very owner the endpoint carries, so the
  // only thing left to refuse it is the name shape itself.
  it("refuses an owner outside the GitHub name shape the install itself names", async () => {
    const asked: string[] = [];
    const watching = (async (url: string) => {
      asked.push(url);
      return new Response(gitHubSourceArchive() as unknown as BodyInit, { status: 200 });
    }) as unknown as typeof fetch;

    await expect(
      prepareSuppliedRepositoryArchiveSnapshot({
        owner: "-acme",
        repo: "thing",
        ref: null,
        archiveUrl: "https://codeload.github.com/-acme/thing/zip/HEAD",
        resolveValidator: async () => null,
        stageSnapshot: async () => "never.tgz",
        fetchImpl: watching,
      }),
    ).rejects.toThrow(/refusing to download an extension package/);

    expect(asked).toEqual([]);
  });

  it("re-checks every entry name AFTER the generated wrapper folder is stripped", async () => {
    // "thing-main//escape.txt" is harmless with the wrapper on and an absolute
    // path with it off, so the strip is what has to refuse it.
    const zip = buildStoredZip([
      {
        name: "thing-main/package.json",
        content: JSON.stringify({
          name: "@acme/thing-skill",
          version: "1.0.0",
          cinatra: { kind: "skill" },
        }),
      },
      { name: "thing-main//escape.txt", content: "x" },
    ]);
    const comment = new TextEncoder().encode(SHA);
    const out = new Uint8Array(zip.byteLength + comment.byteLength);
    out.set(zip, 0);
    out.set(comment, zip.byteLength);
    new DataView(out.buffer, out.byteOffset, out.byteLength).setUint16(
      zip.byteLength - 22 + 20,
      comment.byteLength,
      true,
    );

    await expect(
      prepareSuppliedRepositoryArchiveSnapshot({
        owner: "acme",
        repo: "thing",
        ref: null,
        archiveUrl: "https://codeload.github.com/acme/thing/zip/HEAD",
        resolveValidator: async () => null,
        stageSnapshot: async () => "never.tgz",
        fetchImpl: respondWith(out),
      }),
    ).rejects.toThrow(/absolute path/);
  });
});

describe("both roads end at the SAME dispatcher (criteria 18, 19, 20)", () => {
  it("hands the dispatcher the declared provenance and the chosen anchor", async () => {
    await installSuppliedCandidate({
      candidate: {
        kind: "artifact",
        packageName: "@acme/thing-artifact",
        version: "2.0.0",
        provenance: { type: "local", path: `${DIGEST}.tgz`, contentDigest: DIGEST },
        validatorRan: true,
      },
      actor: { actorType: "human", source: "ui", userId: "u1", orgId: "org-1" },
      rowOwnership: { ownerLevel: "workspace", ownerId: null, organizationId: null },
    });

    expect(registry.extensionRegistry.install).toHaveBeenCalledTimes(1);
    const [typeId, ref, , options] = registry.extensionRegistry.install.mock
      .calls[0] as unknown as [
      string,
      Record<string, unknown>,
      unknown,
      { rowOwnership: Record<string, unknown> },
    ];
    // The KIND decides the handler — the ordering contract is the dispatcher's.
    expect(typeId).toBe("artifact");
    expect(ref.provenance).toMatchObject({ type: "local", contentDigest: DIGEST });
    // Never a registry URL: a supplied package was on no registry.
    expect(ref.registryUrl).toBe(SUPPLIED_PACKAGE_ORIGIN);
    expect(String(ref.registryUrl)).not.toMatch(/^https?:/);
    expect(options.rowOwnership).toEqual({
      ownerLevel: "workspace",
      ownerId: null,
      organizationId: null,
    });
  });

  it("two anchors for the same package are two different row identities (criterion 28)", async () => {
    const candidate = {
      kind: "artifact" as const,
      packageName: "@acme/thing-artifact",
      version: "2.0.0",
      provenance: { type: "local" as const, path: `${DIGEST}.tgz`, contentDigest: DIGEST },
      validatorRan: true,
    };
    const actor = { actorType: "human" as const, source: "ui" as const, userId: "u1", orgId: "org-1" };
    await installSuppliedCandidate({
      candidate,
      actor,
      rowOwnership: { ownerLevel: "organization", ownerId: "org-1", organizationId: "org-1" },
    });
    await installSuppliedCandidate({
      candidate,
      actor,
      rowOwnership: { ownerLevel: "organization", ownerId: "org-2", organizationId: "org-2" },
    });
    const calls = registry.extensionRegistry.install.mock.calls as unknown as unknown[][];
    const first = calls[0]![3] as { rowOwnership: unknown };
    const second = calls[1]![3] as { rowOwnership: unknown };
    expect(first.rowOwnership).not.toEqual(second.rowOwnership);
  });
});

describe("the dispatch entry registers the handler set in its OWN worker (cinatra#3204)", () => {
  it("loads the handler bootstrap BEFORE it dispatches, so no kind meets an empty registry", async () => {
    await installSuppliedCandidate({
      candidate: {
        kind: "skill",
        packageName: "@acme/thing-skill",
        version: "1.0.0",
        provenance: { type: "local", path: "x.tgz", contentDigest: DIGEST },
        validatorRan: true,
      },
      actor: { actorType: "human", source: "ui", userId: "u1", orgId: "org-1" },
      rowOwnership: { ownerLevel: "workspace", ownerId: null, organizationId: null },
    });
    // The very first thing that happened on this road, whichever test got here
    // first, is the registration — never a dispatch into an unpopulated registry.
    expect(order.events[0]).toBe("handlers-registered");
    expect(order.events).toContain("dispatch");
  });
});
