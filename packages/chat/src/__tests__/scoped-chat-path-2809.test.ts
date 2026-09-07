// The scope base in front of the chat mount (cinatra#2809, per-scope surfaces S3).
//
// The issue's sentences: "Path builders gain a scope-base PREFIX parameter
// (agent-url; all four `CHAT_ROOT` sites); the scoped chat view mounts the same
// renderer under each base and splits the base off before the codec parses",
// and the scoped launcher address "`<scope-base>/assistants/<vendor>/<slug>`
// (+ site segments)".

import { describe, it, expect } from "vitest";

import {
  CHAT_ROOT,
  SCOPED_CHAT_SEGMENT,
  buildChatPath,
  chatMountRoot,
  chatSegmentsFromPathname,
  isChatPathname,
  splitChatScopeBase,
  threadSlugFromPathname,
} from "../chat-path-codec";

const BASES = ["/workspace", "/personal", "/organizations/o1", "/teams/t1", "/projects/p1"];

describe("the mount root", () => {
  it("is `/chat` bare, and `<scope-base>/assistants` under a scope", () => {
    expect(CHAT_ROOT).toBe("/chat");
    expect(SCOPED_CHAT_SEGMENT).toBe("assistants");
    expect(chatMountRoot()).toBe("/chat");
    for (const base of BASES) {
      expect(chatMountRoot({ scopeBase: base })).toBe(`${base}/assistants`);
    }
  });

  it("refuses a malformed scope base rather than minting a protocol-relative URL", () => {
    for (const bad of ["workspace", "/workspace/", "//workspace", "/work space", ""]) {
      expect(() => chatMountRoot({ scopeBase: bad })).toThrow(/scope base/i);
    }
  });
});

describe("build — all four legal shapes, at every scope", () => {
  it("keeps the bare paths exactly as they were", () => {
    expect(buildChatPath({ vendor: "acme", slug: "helper" })).toBe("/chat/acme/helper");
    expect(buildChatPath({ vendor: "acme", slug: "helper", titleSlug: "t" })).toBe(
      "/chat/acme/helper/t",
    );
    expect(buildChatPath({ vendor: "acme", slug: "helper", instance: "i" })).toBe(
      "/chat/acme/helper/i",
    );
    expect(
      buildChatPath({ vendor: "acme", slug: "helper", instance: "i", titleSlug: "t" }),
    ).toBe("/chat/acme/helper/i/t");
  });

  for (const base of BASES) {
    it(`prefixes ${base} onto every shape`, () => {
      expect(buildChatPath({ vendor: "acme", slug: "helper" }, { scopeBase: base })).toBe(
        `${base}/assistants/acme/helper`,
      );
      expect(
        buildChatPath({ vendor: "acme", slug: "helper", instance: "i", titleSlug: "t" }, { scopeBase: base }),
      ).toBe(`${base}/assistants/acme/helper/i/t`);
    });
  }
});

describe("splitting the base off BEFORE the codec parses", () => {
  it("returns an empty base for a bare chat path", () => {
    expect(splitChatScopeBase("/chat/acme/helper/t")).toEqual({
      scopeBase: "",
      chatPathname: "/chat/acme/helper/t",
    });
  });

  for (const base of BASES) {
    it(`splits ${base} off a scoped path`, () => {
      expect(splitChatScopeBase(`${base}/assistants/acme/helper/t`)).toEqual({
        scopeBase: base,
        chatPathname: "/chat/acme/helper/t",
      });
    });
  }

  it("leaves a non-chat path alone", () => {
    expect(splitChatScopeBase("/teams/t1/agents/acme/writer/r1")).toEqual({
      scopeBase: "",
      chatPathname: "/teams/t1/agents/acme/writer/r1",
    });
    expect(splitChatScopeBase("/teams/t1/assistants")).toEqual({
      scopeBase: "",
      chatPathname: "/teams/t1/assistants",
    });
  });
});

describe("the three pathname readers see through the base", () => {
  it("reads the thread slug on a scoped path", () => {
    expect(threadSlugFromPathname("/teams/t1/assistants/acme/helper/my-thread", { remoteCapable: false })).toBe(
      "my-thread",
    );
    expect(threadSlugFromPathname("/chat/acme/helper/my-thread", { remoteCapable: false })).toBe(
      "my-thread",
    );
    expect(threadSlugFromPathname("/teams/t1/agents/acme/helper/x", { remoteCapable: false })).toBeNull();
  });

  it("reads the trailing segments on a scoped path", () => {
    expect(chatSegmentsFromPathname("/organizations/o1/assistants/acme/helper/t")).toEqual([
      "acme",
      "helper",
      "t",
    ]);
    expect(chatSegmentsFromPathname("/organizations/o1/agents/acme/helper/t")).toEqual([]);
  });

  it("recognizes a scoped chat pathname, and not the scope's own tab page", () => {
    expect(isChatPathname("/chat")).toBe(true);
    expect(isChatPathname("/chat/acme/helper")).toBe(true);
    expect(isChatPathname("/workspace/assistants/acme/helper")).toBe(true);
    // The Assistants TAB itself is a listing page, not a chat mount.
    expect(isChatPathname("/workspace/assistants")).toBe(false);
    expect(isChatPathname("/workspace/agents/acme/helper")).toBe(false);
  });
});

// THE SAME HOST ESCAPE ON THIS SIDE OF THE BORDER: the codec's own base validator carried
// the same backslash hole as the host's, so the scoped MOUNT could be rooted at
// another host. Same rule, pinned on this side of the border too.
describe("the chat mount refuses a backslash base (convergence)", () => {
  const HOSTILE = "/\\attacker.example";

  it("would otherwise resolve to another host", () => {
    expect(new URL(`${HOSTILE}/assistants/acme/helper`, "https://cinatra.example").host).toBe(
      "attacker.example",
    );
  });

  it("throws instead of minting it", () => {
    expect(() => chatMountRoot({ scopeBase: HOSTILE })).toThrow(/invalid scope base/);
  });

  it("does not read one back out of a pathname either", () => {
    expect(splitChatScopeBase(`/teams/\\evil.example/assistants/acme/helper`).scopeBase).toBe("");
  });

  it("still mounts under every real base", () => {
    expect(chatMountRoot({ scopeBase: "/teams/t1" })).toBe("/teams/t1/assistants");
    expect(chatMountRoot()).toBe("/chat");
  });
});
