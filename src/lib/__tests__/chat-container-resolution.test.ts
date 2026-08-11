// The SERVER half of the /chat container assertion (cinatra#2650).
//
// `resolveChatContainer` is the gate that stands between a client-supplied
// container string and a durable `assistant_package` write. The property under
// test is not "does it resolve" but "can a caller ever bind a container it has
// no standing for" — so every refusal path is pinned, and the SUCCESS paths
// assert that the value returned is the REGISTRY's own spelling rather than the
// caller's.
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_ASSISTANT_PACKAGE } from "@cinatra-ai/chat/chat-path-codec";
import type { AssistantRegistryEntry } from "@/lib/assistant-registry-reader";
import { resolveChatContainer, type ChatContainerResolverDeps } from "@/lib/chat-route-resolver";

const LOCAL = "@acme/helper-assistant";
const REMOTE = "@cinatra-ai/wordpress-assistant";

function entry(
  over: Partial<AssistantRegistryEntry> & { packageName: string },
): AssistantRegistryEntry {
  return {
    templateId: "t",
    assistantUserId: "au",
    handle: "h",
    displayName: "Name",
    origin: "extension",
    aliases: [],
    isBuiltin: false,
    delivery: "host-runtime",
    launch: { kind: "local", targetProvider: null },
    ...over,
  };
}

const VISIBLE: AssistantRegistryEntry[] = [
  entry({ packageName: DEFAULT_ASSISTANT_PACKAGE, isBuiltin: true }),
  entry({ packageName: LOCAL }),
  entry({ packageName: REMOTE, launch: { kind: "remote", targetProvider: "wordpress" } }),
];

function deps(over: Partial<ChatContainerResolverDeps> = {}): ChatContainerResolverDeps {
  return {
    readVisibleRegistry: async () => VISIBLE,
    authorizeInstance: async () => true,
    ...over,
  };
}

describe("resolveChatContainer — an asserted container is re-resolved, never trusted", () => {
  it("ABSENT resolves to the implicit default WITHOUT consulting either authority (no claim ⇒ nothing to authorize)", async () => {
    const readVisibleRegistry = vi.fn(async () => VISIBLE);
    const authorizeInstance = vi.fn(async () => true);
    for (const absent of [undefined, null]) {
      const res = await resolveChatContainer(absent, deps({ readVisibleRegistry, authorizeInstance }));
      expect(res).toEqual({
        ok: true,
        container: { assistantPackage: DEFAULT_ASSISTANT_PACKAGE, instanceId: null },
      });
    }
    expect(readVisibleRegistry).not.toHaveBeenCalled();
    expect(authorizeInstance).not.toHaveBeenCalled();
  });

  it("an in-audience package resolves to the container", async () => {
    await expect(resolveChatContainer({ assistantPackage: LOCAL }, deps())).resolves.toEqual({
      ok: true,
      container: { assistantPackage: LOCAL, instanceId: null },
    });
  });

  // The anti-spoofing property: what is BOUND is the registry entry's own
  // spelling, so a caller cannot mint a second, differently-cased container for
  // the same assistant (which would split the thread namespace in two).
  it("the CANONICAL registry spelling is what resolves — never the caller's casing", async () => {
    const res = await resolveChatContainer(
      { assistantPackage: "@ACME/Helper-Assistant" },
      deps(),
    );
    expect(res).toEqual({ ok: true, container: { assistantPackage: LOCAL, instanceId: null } });
  });

  it("surrounding whitespace is not a distinct container", async () => {
    await expect(
      resolveChatContainer({ assistantPackage: `  ${LOCAL}  ` }, deps()),
    ).resolves.toEqual({ ok: true, container: { assistantPackage: LOCAL, instanceId: null } });
  });

  it("an OUT-OF-AUDIENCE / unknown / uninstalled package REFUSES — it is never downgraded to the default", async () => {
    for (const pkg of ["@evil/not-installed", "@acme/other-assistant", ""]) {
      await expect(resolveChatContainer({ assistantPackage: pkg }, deps())).resolves.toEqual({
        ok: false,
        code: "unknown-assistant",
      });
    }
  });

  it("the registry the assertion is matched against is the ACTOR's — an entry absent from it refuses even though it exists globally", async () => {
    const narrowed = deps({ readVisibleRegistry: async () => [VISIBLE[0]!] });
    await expect(resolveChatContainer({ assistantPackage: LOCAL }, narrowed)).resolves.toEqual({
      ok: false,
      code: "unknown-assistant",
    });
  });

  it("an AUTHORIZED instance on a remote assistant resolves, scoped", async () => {
    const authorizeInstance = vi.fn(async () => true);
    await expect(
      resolveChatContainer({ assistantPackage: REMOTE, instanceId: "site-1" }, deps({ authorizeInstance })),
    ).resolves.toEqual({ ok: true, container: { assistantPackage: REMOTE, instanceId: "site-1" } });
    expect(authorizeInstance).toHaveBeenCalledWith("wordpress", "site-1");
  });

  it("an UNAUTHORIZED instance refuses — actor A can never home a thread in actor B's instance", async () => {
    await expect(
      resolveChatContainer(
        { assistantPackage: REMOTE, instanceId: "site-b" },
        deps({ authorizeInstance: async () => false }),
      ),
    ).resolves.toEqual({ ok: false, code: "unauthorized-instance" });
  });

  it("an instance on a LOCAL assistant refuses — that assistant has no instance scope to pin", async () => {
    const authorizeInstance = vi.fn(async () => true);
    await expect(
      resolveChatContainer({ assistantPackage: LOCAL, instanceId: "site-1" }, deps({ authorizeInstance })),
    ).resolves.toEqual({ ok: false, code: "unauthorized-instance" });
    expect(authorizeInstance).not.toHaveBeenCalled(); // fails closed BEFORE the authority
  });

  it("a remote assistant with no first-party connector kind refuses its instance", async () => {
    const noProvider = deps({
      readVisibleRegistry: async () => [
        entry({ packageName: REMOTE, launch: { kind: "remote", targetProvider: "nope" } }),
      ],
    });
    await expect(
      resolveChatContainer({ assistantPackage: REMOTE, instanceId: "site-1" }, noProvider),
    ).resolves.toEqual({ ok: false, code: "unauthorized-instance" });
  });

  it("an empty/whitespace instance is NO instance, not a refusal", async () => {
    for (const instanceId of ["", "   ", null, undefined]) {
      await expect(
        resolveChatContainer({ assistantPackage: LOCAL, instanceId }, deps()),
      ).resolves.toEqual({ ok: true, container: { assistantPackage: LOCAL, instanceId: null } });
    }
  });
});
