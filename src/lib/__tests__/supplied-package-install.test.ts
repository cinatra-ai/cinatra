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
  fetchSuppliedRepositoryArchive,
  installSuppliedCandidate,
  prepareSuppliedRepositoryArchiveSnapshot,
  prepareSuppliedRepositorySnapshot,
  previewSuppliedRepositoryArchive,
} from "@/lib/supplied-package-install";
import { validateExtensionSource } from "@cinatra-ai/extensions/canonical-types";
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

describe("the LINK road records a FINALIZED ref, so its row is written (cinatra#3204)", () => {
  // THE ORDER THE PRODUCT TAKES, not a shortcut through it: a bare link is
  // previewed, and the install action hands back the ref the preview showed
  // beside the pin the operator approved.
  async function previewThenInstall(archive: Uint8Array, typedRef: string | null) {
    const preview = await previewSuppliedRepositoryArchive({
      owner: "acme",
      repo: "thing",
      ref: typedRef,
      archiveUrl: `https://codeload.github.com/acme/thing/zip/${typedRef ?? "HEAD"}`,
      fetchImpl: respondWith(archive),
    });
    const prepared = await prepareSuppliedRepositoryArchiveSnapshot({
      owner: "acme",
      repo: "thing",
      // The form passes the PREVIEW's ref straight through.
      ref: preview.ref,
      archiveUrl: `https://codeload.github.com/acme/thing/zip/${typedRef ?? "HEAD"}`,
      pin: { resolvedSha: preview.resolvedSha, contentDigest: preview.contentDigest },
      resolveValidator: async () => null,
      stageSnapshot: async (digest: string) => `${digest}.tgz`,
      fetchImpl: respondWith(archive),
    });
    return { preview, prepared };
  }

  it("installs a kind:skill package at a resolved pin and writes the canonical row, its source naming the repository, the ref and the sha", async () => {
    const { preview, prepared } = await previewThenInstall(gitHubSourceArchive(), null);

    expect(prepared.kind).toBe("skill");

    // THE VERY CHECK THE INSTALL RUNS before it writes the row. Its failure is
    // the sentence the operator was shown on the upload screen, so a red here
    // says exactly what a refused install says.
    const errors = validateExtensionSource(prepared.provenance);
    const verdict =
      errors.length === 0
        ? "the canonical install row is written"
        : `install refused \u2014 source provenance invalid/missing: ${errors.join(", ")}`;
    expect(verdict).toBe("the canonical install row is written");

    // ...and the name the screen showed is the name the row carries.
    expect(preview.ref).toBe("main");

    expect(prepared.provenance).toMatchObject({
      type: "github",
      repo: "acme/thing",
      ref: "main",
      resolvedSha: SHA,
      path: `${prepared.contentDigest}.tgz`,
    });

    // ...and the row that reaches the dispatcher carries that same source.
    await installSuppliedCandidate({
      candidate: {
        kind: prepared.kind,
        packageName: prepared.packageName,
        version: prepared.version,
        provenance: prepared.provenance,
        validatorRan: prepared.validatorRan,
      },
      actor: { actorType: "human", source: "ui", userId: "u1", orgId: "org-1" },
      rowOwnership: { ownerLevel: "workspace", ownerId: null, organizationId: null },
    });
    const [typeId, ref] = registry.extensionRegistry.install.mock.calls.at(-1) as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(typeId).toBe("skill");
    expect(ref.provenance).toMatchObject({
      type: "github",
      repo: "acme/thing",
      ref: "main",
      resolvedSha: SHA,
    });
    expect(validateExtensionSource(ref.provenance)).toEqual([]);
  });

  it("records the repository's DEFAULT BRANCH NAME for a bare link, and never the sentinel the validator rejects", async () => {
    // The tab and the row read the same name: the preview stops producing the
    // sentinel, so the pass-through carries a real name.
    const { preview, prepared } = await previewThenInstall(gitHubSourceArchive(), null);
    expect(preview.ref).toBe("main");
    expect(prepared.ref).toBe("main");
    expect(prepared.provenance).toMatchObject({ ref: "main" });

    // A sentinel arriving from a caller is "no ref was typed", never a typed
    // ref - an unpinned bare-link install resolves the name from the archive.
    const fromSentinel = await prepareSuppliedRepositoryArchiveSnapshot({
      owner: "acme",
      repo: "thing",
      ref: "HEAD",
      archiveUrl: "https://codeload.github.com/acme/thing/zip/HEAD",
      resolveValidator: async () => null,
      stageSnapshot: async (digest: string) => `${digest}.tgz`,
      fetchImpl: respondWith(gitHubSourceArchive()),
    });
    expect(fromSentinel.ref).toBe("main");
    expect(fromSentinel.provenance).toMatchObject({ ref: "main" });
    expect(validateExtensionSource(fromSentinel.provenance)).toEqual([]);

    // And a name that cannot be had is a refusal naming what it could not
    // resolve, with no row dispatched - never a placeholder written down.
    registry.extensionRegistry.install.mockClear();
    await expect(
      prepareSuppliedRepositoryArchiveSnapshot({
        owner: "acme",
        repo: "thing",
        ref: null,
        archiveUrl: `https://codeload.github.com/acme/thing/zip/${SHA}`,
        resolveValidator: async () => null,
        stageSnapshot: async (digest: string) => `${digest}.tgz`,
        // A download BY COMMIT names its root folder after the commit, so the
        // archive says nothing about a branch.
        fetchImpl: respondWith(gitHubSourceArchive({ root: `thing-${SHA}` })),
      }),
    ).rejects.toThrow(/could not resolve the branch, tag or release name to record/);
    expect(registry.extensionRegistry.install).not.toHaveBeenCalled();
  });

  it("stages NOTHING when the name cannot be resolved - the refusal comes before the store is written", async () => {
    // The snapshot is a durable write of its own: a refusal that arrives after
    // it leaves an orphan behind in the store. So the name is settled first.
    const stageSnapshot = vi.fn(async (digest: string) => `${digest}.tgz`);
    await expect(
      prepareSuppliedRepositoryArchiveSnapshot({
        owner: "acme",
        repo: "thing",
        ref: null,
        archiveUrl: `https://codeload.github.com/acme/thing/zip/${SHA}`,
        resolveValidator: async () => null,
        stageSnapshot,
        fetchImpl: respondWith(gitHubSourceArchive({ root: `thing-${SHA}` })),
      }),
    ).rejects.toThrow(/could not resolve the branch, tag or release name to record/);
    expect(stageSnapshot).not.toHaveBeenCalled();
  });

  it("reads the root folder against the repository that SERVED the bytes, so a renamed repository records a real branch", async () => {
    // A link to a repository that has since been renamed is redirected to its
    // current name, and the archive's root folder carries THAT name. Read
    // against the stale name, "thing-new-main" would record the branch
    // "new-main", which no repository ever had.
    const renamed = (async (url: string) => {
      if (url === "https://codeload.github.com/acme/thing/zip/HEAD") {
        return new Response(null, {
          status: 301,
          headers: { location: "https://codeload.github.com/acme/thing-new/zip/HEAD" },
        });
      }
      return new Response(
        gitHubSourceArchive({ root: "thing-new-main" }) as unknown as BodyInit,
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const prepared = await prepareSuppliedRepositoryArchiveSnapshot({
      owner: "acme",
      repo: "thing",
      ref: null,
      archiveUrl: "https://codeload.github.com/acme/thing/zip/HEAD",
      resolveValidator: async () => null,
      stageSnapshot: async (digest: string) => `${digest}.tgz`,
      fetchImpl: renamed,
    });
    expect(prepared.ref).toBe("main");
    expect(prepared.provenance).toMatchObject({ ref: "main" });
    expect(validateExtensionSource(prepared.provenance)).toEqual([]);
  });

  it("refuses a PINNED install that was handed only a sentinel - a commit archive names no branch", async () => {
    // The pinned download is asked for BY COMMIT, so its root folder is named
    // after the commit and says nothing about a branch. A caller that passed
    // the stand-in rather than the preview's finalized name therefore gets a
    // refusal that says what could not be resolved - never a placeholder row.
    const stageSnapshot = vi.fn(async (digest: string) => `${digest}.tgz`);
    await expect(
      prepareSuppliedRepositoryArchiveSnapshot({
        owner: "acme",
        repo: "thing",
        ref: "HEAD",
        archiveUrl: "https://codeload.github.com/acme/thing/zip/HEAD",
        pin: { resolvedSha: SHA, contentDigest: "c".repeat(64) },
        resolveValidator: async () => null,
        stageSnapshot,
        fetchImpl: respondWith(gitHubSourceArchive({ root: `thing-${SHA}` })),
      }),
    ).rejects.toThrow(/could not resolve the branch, tag or release name to record/);
    expect(stageSnapshot).not.toHaveBeenCalled();
  });

  it("keeps the ref the operator typed exactly as they typed it", async () => {
    const prepared = await prepareSuppliedRepositoryArchiveSnapshot({
      owner: "acme",
      repo: "thing",
      ref: "v1.2.3",
      archiveUrl: "https://codeload.github.com/acme/thing/zip/refs/tags/v1.2.3",
      resolveValidator: async () => null,
      stageSnapshot: async (digest: string) => `${digest}.tgz`,
      fetchImpl: respondWith(gitHubSourceArchive({ root: "thing-1.2.3" })),
    });
    expect(prepared.ref).toBe("v1.2.3");
    expect(prepared.provenance).toMatchObject({ ref: "v1.2.3" });
  });
});

// ---------------------------------------------------------------------------
// A BARE LINK PROVES THE NAME IT RECORDS (cinatra#3204 fix leg 6 — criteria 7,
// 8, 20)
//
// A link that names no ref means the repository's default branch, and the
// archive host serves that at the stand-in path. The bytes and the pin are
// exactly what that path serves; what the row still lacks is a NAME, because
// the generated root folder of the stand-in archive is named after the stand-in
// itself.
//
// The name is PROVED, never guessed. Asking whether a branch called "main"
// exists would answer a different question — a repository can carry a main
// branch that is not its default — so the test is an IDENTITY test: at most two
// header-only requests for refs/heads/main then refs/heads/master, each through
// the module's own validated-parts builder against its single archive host, no
// redirect followed, and a candidate counts only when the validator it returns
// is IDENTICAL, character for character, to the one the downloaded archive
// returned - weak marker and all, since the host writes a weak tag to a client
// that accepts compression and that is every client on this road.
// ---------------------------------------------------------------------------

const SENTINEL_ARCHIVE_URL = "https://codeload.github.com/acme/thing/zip/HEAD";
const MAIN_CANDIDATE_URL = "https://codeload.github.com/acme/thing/zip/refs/heads/main";
const MASTER_CANDIDATE_URL = "https://codeload.github.com/acme/thing/zip/refs/heads/master";
const PINNED_ARCHIVE_URL = `https://codeload.github.com/acme/thing/zip/${SHA}`;
/**
 * The validator the archive host returns for the bytes that arrived.
 *
 * IT IS WEAK, because that is what the product actually receives: the runtime
 * fetch accepts compression, and the host validates the compressed
 * representation weakly. A fixture that answered strongly here would pass while
 * the road never fired in the product.
 */
const ARCHIVE_VALIDATOR = `W/"${"0052e4b2".repeat(8)}"`;
const OTHER_VALIDATOR = `W/"${"7f13aa90".repeat(8)}"`;
/** The same content hash written STRONGLY - a different string, so a different tag. */
const STRONG_ARCHIVE_VALIDATOR = `"${"0052e4b2".repeat(8)}"`;

/**
 * The archive host, as far as this road can see it: the archive paths serve
 * bytes with a validator, the candidate paths answer whatever the fixture says
 * (or throw, when the fixture says so), and everything else is a 404. Every
 * request is recorded with its method AND its redirect mode, so a test can
 * count the header-only ones and pin that none of them follows a redirect.
 */
function archiveHost(fixture: {
  archives: Record<string, { bytes: Uint8Array; etag?: string }>;
  candidates?: Record<
    string,
    { status: number; etag?: string; location?: string; throws?: string }
  >;
}) {
  const calls: { url: string; method: string; redirect: string }[] = [];
  const impl = (async (url: string, init?: { method?: string; redirect?: string }) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      redirect: init?.redirect ?? "follow",
    });
    const archive = fixture.archives[url];
    if (archive) {
      return new Response(archive.bytes as unknown as BodyInit, {
        status: 200,
        ...(archive.etag ? { headers: { etag: archive.etag } } : {}),
      });
    }
    const candidate = fixture.candidates?.[url];
    if (!candidate) return new Response(null, { status: 404 });
    if (candidate.throws) throw new Error(candidate.throws);
    const headers: Record<string, string> = {};
    if (candidate.etag) headers.etag = candidate.etag;
    if (candidate.location) headers.location = candidate.location;
    return new Response(null, { status: candidate.status, headers });
  }) as unknown as typeof fetch;
  const headRequests = () => calls.filter((call) => call.method === "HEAD");
  return { impl, calls, headRequests };
}

/** The archive the stand-in path serves: its root folder is named after the
 *  stand-in, which is why the bytes alone name no branch. */
function sentinelSourceArchive() {
  return gitHubSourceArchive({ root: "thing-HEAD" });
}

describe("a BARE link proves the branch name it records (cinatra#3204)", () => {
  beforeEach(() => {
    registry.extensionRegistry.install.mockClear();
  });

  it("records the branch whose archive carries the SAME validator as the bytes that arrived", async () => {
    const bytes = sentinelSourceArchive();
    const host = archiveHost({
      archives: {
        [SENTINEL_ARCHIVE_URL]: { bytes, etag: ARCHIVE_VALIDATOR },
        [PINNED_ARCHIVE_URL]: { bytes, etag: ARCHIVE_VALIDATOR },
      },
      candidates: { [MAIN_CANDIDATE_URL]: { status: 200, etag: ARCHIVE_VALIDATOR } },
    });

    // THE ORDER THE PRODUCT TAKES: the bare link is previewed, and the form
    // hands the preview's own ref back beside the pin the operator approved.
    const preview = await previewSuppliedRepositoryArchive({
      owner: "acme",
      repo: "thing",
      ref: null,
      archiveUrl: SENTINEL_ARCHIVE_URL,
      fetchImpl: host.impl,
    });
    expect(preview.ref).toBe("main");
    expect(preview.resolvedSha).toBe(SHA);

    const prepared = await prepareSuppliedRepositoryArchiveSnapshot({
      owner: "acme",
      repo: "thing",
      ref: preview.ref,
      archiveUrl: SENTINEL_ARCHIVE_URL,
      pin: { resolvedSha: preview.resolvedSha, contentDigest: preview.contentDigest },
      resolveValidator: async () => null,
      stageSnapshot: async (digest: string) => `${digest}.tgz`,
      fetchImpl: host.impl,
    });

    // The name the tab showed is the name the row records...
    expect(prepared.ref).toBe("main");
    expect(prepared.provenance).toMatchObject({
      type: "github",
      repo: "acme/thing",
      ref: "main",
      resolvedSha: SHA,
    });
    // ...and the install's own validator accepts that source, so the row is
    // written rather than refused three steps later.
    expect(validateExtensionSource(prepared.provenance)).toEqual([]);
  });

  it("refuses the name when a candidate answers with a DIFFERENT validator - a branch that merely exists is never recorded", async () => {
    // "main" exists here, but its archive is not the tree the bare link
    // resolved to: it is not this repository's default branch. Recording it
    // would name a branch the bytes did not come from.
    const stageSnapshot = vi.fn(async (digest: string) => `${digest}.tgz`);
    const host = archiveHost({
      archives: { [SENTINEL_ARCHIVE_URL]: { bytes: sentinelSourceArchive(), etag: ARCHIVE_VALIDATOR } },
      candidates: { [MAIN_CANDIDATE_URL]: { status: 200, etag: OTHER_VALIDATOR } },
    });

    await expect(
      prepareSuppliedRepositoryArchiveSnapshot({
        owner: "acme",
        repo: "thing",
        ref: null,
        archiveUrl: SENTINEL_ARCHIVE_URL,
        resolveValidator: async () => null,
        stageSnapshot,
        fetchImpl: host.impl,
      }),
    ).rejects.toThrow(/could not resolve the branch, tag or release name to record/);

    // Both candidates were asked, header-only, and neither answered for these
    // bytes - so nothing was staged and nothing was dispatched.
    expect(host.headRequests().map((call) => call.url)).toEqual([
      MAIN_CANDIDATE_URL,
      MASTER_CANDIDATE_URL,
    ]);
    expect(stageSnapshot).not.toHaveBeenCalled();
    expect(registry.extensionRegistry.install).not.toHaveBeenCalled();
  });

  it("keeps its refusal word for word when NEITHER candidate answers", async () => {
    const host = archiveHost({
      archives: { [SENTINEL_ARCHIVE_URL]: { bytes: sentinelSourceArchive(), etag: ARCHIVE_VALIDATOR } },
    });

    await expect(
      previewSuppliedRepositoryArchive({
        owner: "acme",
        repo: "thing",
        ref: null,
        archiveUrl: SENTINEL_ARCHIVE_URL,
        fetchImpl: host.impl,
      }),
    ).rejects.toThrow(
      "[supplied-install] acme/thing: this install could not resolve the branch, tag or release name " +
        "to record - the link named none and the archive that was downloaded does not name the branch " +
        "it was generated from. Type the branch, tag or release to install from and try again. " +
        "Nothing was written.",
    );
    expect(host.headRequests()).toHaveLength(2);
  });

  it("costs at most TWO header-only requests, none for a typed ref or a pin, and changes not one byte of what a bare link downloads", async () => {
    const bytes = sentinelSourceArchive();
    const bare = archiveHost({
      archives: { [SENTINEL_ARCHIVE_URL]: { bytes, etag: ARCHIVE_VALIDATOR } },
      candidates: { [MAIN_CANDIDATE_URL]: { status: 200, etag: ARCHIVE_VALIDATOR } },
    });

    const fetched = await fetchSuppliedRepositoryArchive({
      owner: "acme",
      repo: "thing",
      ref: null,
      archiveUrl: SENTINEL_ARCHIVE_URL,
      fetchImpl: bare.impl,
    });
    // THE BYTES AND THE PIN DO NOT MOVE: the bare link still downloads the
    // stand-in path, which is how the archive host serves the default branch.
    expect(Array.from(fetched.archive)).toEqual(Array.from(bytes));
    expect(fetched.resolvedSha).toBe(SHA);
    expect(fetched.archiveUrl).toBe(SENTINEL_ARCHIVE_URL);
    // One download, one header-only test, and it stopped at the first answer.
    // EVERY request on this road, the download and the test alike, follows no
    // redirect of its own: the hop-by-hop check above is the only thing that
    // may move a request to another URL.
    expect(bare.calls[0]).toEqual({
      url: SENTINEL_ARCHIVE_URL,
      method: "GET",
      redirect: "manual",
    });
    expect(bare.headRequests()).toEqual([
      { url: MAIN_CANDIDATE_URL, method: "HEAD", redirect: "manual" },
    ]);
    expect(bare.calls).toHaveLength(2);

    // A TYPED REF TESTS NOTHING: the operator named the ref, so there is no
    // name to prove.
    const typed = archiveHost({
      archives: {
        "https://codeload.github.com/acme/thing/zip/refs/tags/v1.2.3": {
          bytes: gitHubSourceArchive({ root: "thing-1.2.3" }),
          etag: ARCHIVE_VALIDATOR,
        },
      },
      candidates: { [MAIN_CANDIDATE_URL]: { status: 200, etag: ARCHIVE_VALIDATOR } },
    });
    const typedPrepared = await prepareSuppliedRepositoryArchiveSnapshot({
      owner: "acme",
      repo: "thing",
      ref: "v1.2.3",
      archiveUrl: "https://codeload.github.com/acme/thing/zip/refs/tags/v1.2.3",
      resolveValidator: async () => null,
      stageSnapshot: async (digest: string) => `${digest}.tgz`,
      fetchImpl: typed.impl,
    });
    expect(typedPrepared.ref).toBe("v1.2.3");
    expect(typed.headRequests()).toEqual([]);

    // A PIN TESTS NOTHING EITHER: the install asks by commit, and the name it
    // records is the one the preview already settled.
    const approving = archiveHost({
      archives: { [SENTINEL_ARCHIVE_URL]: { bytes, etag: ARCHIVE_VALIDATOR } },
      candidates: { [MAIN_CANDIDATE_URL]: { status: 200, etag: ARCHIVE_VALIDATOR } },
    });
    const approved = await previewSuppliedRepositoryArchive({
      owner: "acme",
      repo: "thing",
      ref: null,
      archiveUrl: SENTINEL_ARCHIVE_URL,
      fetchImpl: approving.impl,
    });
    const pinned = archiveHost({
      archives: { [PINNED_ARCHIVE_URL]: { bytes, etag: ARCHIVE_VALIDATOR } },
      candidates: { [MAIN_CANDIDATE_URL]: { status: 200, etag: ARCHIVE_VALIDATOR } },
    });
    const pinnedPrepared = await prepareSuppliedRepositoryArchiveSnapshot({
      owner: "acme",
      repo: "thing",
      ref: approved.ref,
      archiveUrl: SENTINEL_ARCHIVE_URL,
      pin: { resolvedSha: approved.resolvedSha, contentDigest: approved.contentDigest },
      resolveValidator: async () => null,
      stageSnapshot: async (digest: string) => `${digest}.tgz`,
      fetchImpl: pinned.impl,
    });
    expect(pinnedPrepared.ref).toBe("main");
    expect(pinned.headRequests()).toEqual([]);
    expect(pinned.calls).toEqual([
      { url: PINNED_ARCHIVE_URL, method: "GET", redirect: "manual" },
    ]);
  });

  // THE SHAPE THE PRODUCT ACTUALLY SEES. The runtime fetch accepts compression,
  // so the archive host validates the compressed representation WEAKLY and
  // writes the same weak tag to both paths. Reading a weak tag as no validator
  // at all - which an earlier draft of this road did - made the whole proof
  // silently inert in the product while a strongly-answering fixture passed.
  it("proves the name from the WEAK validator the host writes to a compressing client, falling through to master", async () => {
    const bytes = sentinelSourceArchive();
    const host = archiveHost({
      archives: {
        [SENTINEL_ARCHIVE_URL]: { bytes, etag: ARCHIVE_VALIDATOR },
      },
      candidates: {
        // The first candidate cannot even be asked; the second answers with the
        // very tag the download carried.
        [MAIN_CANDIDATE_URL]: { status: 200, throws: "socket hang up" },
        [MASTER_CANDIDATE_URL]: { status: 200, etag: ARCHIVE_VALIDATOR },
      },
    });

    const preview = await previewSuppliedRepositoryArchive({
      owner: "acme",
      repo: "thing",
      ref: null,
      archiveUrl: SENTINEL_ARCHIVE_URL,
      fetchImpl: host.impl,
    });
    expect(preview.ref).toBe("master");
    expect(host.headRequests().map((call) => call.url)).toEqual([
      MAIN_CANDIDATE_URL,
      MASTER_CANDIDATE_URL,
    ]);
  });

  it("never reads a STRONG tag and a WEAK tag as one tree", async () => {
    // The same content hash, written in both forms. They are not the same
    // validator, so this proves nothing and the refusal stands.
    const host = archiveHost({
      archives: {
        [SENTINEL_ARCHIVE_URL]: { bytes: sentinelSourceArchive(), etag: ARCHIVE_VALIDATOR },
      },
      candidates: { [MAIN_CANDIDATE_URL]: { status: 200, etag: STRONG_ARCHIVE_VALIDATOR } },
    });

    await expect(
      previewSuppliedRepositoryArchive({
        owner: "acme",
        repo: "thing",
        ref: null,
        archiveUrl: SENTINEL_ARCHIVE_URL,
        fetchImpl: host.impl,
      }),
    ).rejects.toThrow(/could not resolve the branch, tag or release name to record/);
  });

  it("sends no test at all when the download carried NO validator", async () => {
    const host = archiveHost({
      archives: { [SENTINEL_ARCHIVE_URL]: { bytes: sentinelSourceArchive() } },
      candidates: { [MAIN_CANDIDATE_URL]: { status: 200, etag: ARCHIVE_VALIDATOR } },
    });

    await expect(
      previewSuppliedRepositoryArchive({
        owner: "acme",
        repo: "thing",
        ref: null,
        archiveUrl: SENTINEL_ARCHIVE_URL,
        fetchImpl: host.impl,
      }),
    ).rejects.toThrow(/could not resolve the branch, tag or release name to record/);
    // Nothing a candidate could be identical to, so nothing is asked.
    expect(host.headRequests()).toEqual([]);
  });
});
