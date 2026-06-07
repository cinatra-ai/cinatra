import { describe, it, expect, vi } from "vitest";
import {
  createConnectorExtensionHandler,
  ConnectorRequiresRebuildError,
  type ConnectorUiSurfaceResolver,
} from "../connector-handler";
import type { Actor, PackageRef } from "../index";

// The connector handler is MODEL-B-AWARE: a schema-config connector (NO
// bundled React) is runtime-installable (install/update are clean no-ops so the
// dispatcher pipeline materializes + hot-activates it); a bundled-react connector
// raises the typed ConnectorRequiresRebuildError (a surfaced state, NOT the old
// uncaught workspace-compiled crash that aborted the dispatch).

const ref = (name = "@v/x-connector"): PackageRef => ({ registryUrl: "", packageName: name, version: "1.0.0" });
const actor: Actor = { actorType: "system", userId: "u1", source: "worker" };

function handlerWith(resolver?: ConnectorUiSurfaceResolver) {
  return createConnectorExtensionHandler(resolver ? { resolveUiSurface: resolver } : {});
}

describe("connector handler model-B awareness", () => {
  it("schema-config: install + update RESOLVE (clean no-op — dispatcher pipeline owns materialize/activate)", async () => {
    const h = handlerWith(async () => "schema-config");
    await expect(h.install(ref(), actor)).resolves.toBeUndefined();
    await expect(h.update(ref(), actor)).resolves.toBeUndefined();
  });

  it("no declared uiSurface (null): install + update RESOLVE (treated as model-B / runtime-installable)", async () => {
    const h = handlerWith(async () => null);
    await expect(h.install(ref(), actor)).resolves.toBeUndefined();
    await expect(h.update(ref(), actor)).resolves.toBeUndefined();
  });

  it("bundled-react: install + update raise the TYPED ConnectorRequiresRebuildError (code REQUIRES_REBUILD), never a generic crash", async () => {
    const h = handlerWith(async () => "bundled-react");
    await expect(h.install(ref(), actor)).rejects.toBeInstanceOf(ConnectorRequiresRebuildError);
    await expect(h.update(ref(), actor)).rejects.toMatchObject({ code: "REQUIRES_REBUILD" });
  });

  it("no resolver wired: install/update fail OPEN to the runtime path (resolve), never block a model-B install", async () => {
    const h = handlerWith();
    await expect(h.install(ref(), actor)).resolves.toBeUndefined();
    await expect(h.update(ref(), actor)).resolves.toBeUndefined();
  });

  it("a resolver THROW (registry unreachable) fails OPEN to the runtime path (render-time guard still gates bundled-react)", async () => {
    const h = handlerWith(async () => {
      throw new Error("registry unreachable");
    });
    await expect(h.install(ref(), actor)).resolves.toBeUndefined();
  });

  it("uninstall is a clean no-op (dispatcher owns canonical-row + capability teardown), never throws", async () => {
    const h = handlerWith(async () => "bundled-react");
    await expect(h.uninstall(ref(), actor)).resolves.toBeUndefined();
  });

  it("the resolver is invoked with the package ref", async () => {
    const resolver = vi.fn<ConnectorUiSurfaceResolver>().mockResolvedValue("schema-config");
    const h = handlerWith(resolver);
    await h.install(ref("@acme/widget-connector"), actor);
    expect(resolver).toHaveBeenCalledWith(expect.objectContaining({ packageName: "@acme/widget-connector" }));
  });
});
