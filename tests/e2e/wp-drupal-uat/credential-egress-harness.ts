import type { Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// THE INSTRUMENTED postMessage HARNESS (cinatra#2674, epic #2564 S8e, AC-2).
//
// The AC: "An instrumented browser harness captures every `Window.postMessage`
// and transferred `MessagePort` payload in both directions and proves synthetic
// credential sentinels never appear in those messages, the iframe URL/referrer,
// parent DOM, parent-origin storage, or parent-visible logs."
//
// HOW IT CAPTURES EVERYTHING, and why each hook is needed:
//
//   • `window.postMessage` is wrapped, so every parent→frame and frame→parent
//     window-targeted message is recorded WITH its target origin.
//   • `MessagePort.prototype.postMessage` is wrapped, so the port-bound
//     transport (§12b) is recorded too. Without this hook the port channel — the
//     one the protocol prefers — would be invisible, and a harness that cannot
//     see the preferred channel proves nothing about it.
//   • `MessageChannel` construction is wrapped so a port is instrumented from
//     the instant it exists, including the endpoint that is TRANSFERRED away
//     before either side has posted anything.
//   • A capturing `message` listener records what actually ARRIVES, from which
//     origin — the receiving half of "both directions".
//
// The script is installed with `addInitScript`, so it runs in EVERY frame before
// any application script does, in the parent page and in the Cinatra iframe
// alike. Nothing can post before it is watching.
//
// ITS OWN POSITIVE CONTROL. A recorder that silently stopped working would make
// every assertion below pass. So the harness plants a SENTINEL and posts it
// through both channels before asserting anything: if the sentinel is not in the
// log, the harness itself has failed and the run stops. Only then does the
// absence of a credential mean anything.
// ---------------------------------------------------------------------------

/** A value that must never appear on the wire, planted so the recorder can be
 *  proven to work before its silence is trusted. */
export const HARNESS_SENTINEL = "cwu_SYNTHETIC-SENTINEL-DO-NOT-SHIP";

/** Everything Cinatra mints that must never cross into a parent-origin context. */
export const CREDENTIAL_PREFIXES = ["cwu_", "cit_", "cnx_"] as const;

export type CapturedMessage = {
  kind: "window.postMessage" | "port.postMessage" | "message-received";
  /** The frame that recorded it, by URL — the parent page or the Cinatra frame. */
  frameUrl: string;
  /** JSON of the payload, or the reason it could not be serialized. */
  payload: string;
  /** Target origin for a window post; the sender's origin for a receipt. */
  origin: string;
  /** How many `MessagePort`s were transferred with it. */
  transferredPorts: number;
};

export type EgressEvidence = {
  messages: CapturedMessage[];
  consoleLines: string[];
  parentStorage: string;
  parentCookies: string;
  parentDom: string;
  frameUrls: string[];
  frameReferrers: string[];
};

const INIT_SCRIPT = `
(() => {
  const log = [];
  Object.defineProperty(window, "__cinatraEgressLog", { value: log, writable: false });

  const serialize = (value) => {
    try { return JSON.stringify(value); } catch (e) { return "[[unserializable:" + String(e) + "]]"; }
  };
  const record = (kind, payload, origin, ports) => {
    log.push({
      kind,
      frameUrl: String(location.href),
      payload: serialize(payload),
      origin: String(origin ?? ""),
      transferredPorts: Array.isArray(ports) ? ports.length : 0,
    });
  };

  // 1. Window-targeted posts, in both directions (the parent's and the frame's).
  const nativeWindowPost = window.postMessage.bind(window);
  window.postMessage = function (message, targetOrigin, transfer) {
    record("window.postMessage", message, targetOrigin, transfer);
    return nativeWindowPost(message, targetOrigin, transfer);
  };
  // A frame posts to its PARENT through a different WindowProxy, so the
  // prototype is patched too — patching only \`window.postMessage\` would miss
  // \`parent.postMessage(...)\` entirely.
  if (typeof Window !== "undefined" && Window.prototype) {
    const protoPost = Window.prototype.postMessage;
    Window.prototype.postMessage = function (message, targetOrigin, transfer) {
      record("window.postMessage", message, targetOrigin, transfer);
      return protoPost.call(this, message, targetOrigin, transfer);
    };
  }

  // 2. The port-bound transport — the channel the protocol prefers.
  if (typeof MessagePort !== "undefined" && MessagePort.prototype) {
    const portPost = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (message, transfer) {
      record("port.postMessage", message, "[port]", transfer);
      return portPost.call(this, message, transfer);
    };
  }
  // 3. Instrument ports from the moment they exist, including the transferred one.
  if (typeof MessageChannel !== "undefined") {
    const NativeChannel = MessageChannel;
    window.MessageChannel = function () {
      const channel = new NativeChannel();
      for (const port of [channel.port1, channel.port2]) {
        port.addEventListener("message", (event) => {
          record("message-received", event.data, "[port]", []);
        });
      }
      return channel;
    };
    window.MessageChannel.prototype = NativeChannel.prototype;
  }

  // 4. What actually ARRIVES on the window, and from where.
  window.addEventListener(
    "message",
    (event) => record("message-received", event.data, event.origin, event.ports),
    true,
  );
})();
`;

/** Install the recorder in every frame of `page`, before any app script runs. */
export async function installEgressHarness(page: Page): Promise<void> {
  await page.addInitScript(INIT_SCRIPT);
}

/**
 * Prove the recorder works, in the page it is about to be trusted in.
 *
 * Posts the sentinel through BOTH instrumented channels and returns whether the
 * log caught both. A false here means the harness is blind and every downstream
 * "no credential found" is meaningless — the caller must fail the run.
 */
export async function proveHarnessRecords(page: Page): Promise<boolean> {
  return page.evaluate(async (sentinel) => {
    const log = (window as unknown as { __cinatraEgressLog?: unknown[] }).__cinatraEgressLog;
    if (!Array.isArray(log)) return false;
    window.postMessage({ probe: sentinel }, "*");
    const channel = new MessageChannel();
    channel.port1.postMessage({ probe: sentinel });
    await new Promise((r) => setTimeout(r, 50));
    const serialized = JSON.stringify(log);
    return (
      serialized.includes(sentinel) &&
      serialized.includes("window.postMessage") &&
      serialized.includes("port.postMessage")
    );
  }, HARNESS_SENTINEL);
}

/** Collect everything the AC asks about, from the parent page and its frames. */
export async function collectEgressEvidence(
  page: Page,
  consoleLines: string[],
): Promise<EgressEvidence> {
  const messages = (await page.evaluate(() => {
    const own = (window as unknown as { __cinatraEgressLog?: unknown[] }).__cinatraEgressLog ?? [];
    return own as unknown[];
  })) as CapturedMessage[];

  // Every frame keeps its own log; merge them so "both directions" really means
  // both sides' recordings, not only the parent's view.
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    try {
      const frameLog = (await frame.evaluate(() => {
        const own =
          (window as unknown as { __cinatraEgressLog?: unknown[] }).__cinatraEgressLog ?? [];
        return own as unknown[];
      })) as CapturedMessage[];
      messages.push(...frameLog);
    } catch {
      // A frame that has navigated away mid-collection contributes nothing; the
      // parent's own log still recorded anything it sent or received.
    }
  }

  const parentStorage = await page.evaluate(() => {
    const dump = (s: Storage) => {
      const out: Record<string, string> = {};
      for (let i = 0; i < s.length; i += 1) {
        const k = s.key(i);
        if (k) out[k] = s.getItem(k) ?? "";
      }
      return out;
    };
    return JSON.stringify({ local: dump(localStorage), session: dump(sessionStorage) });
  });
  const parentCookies = await page.evaluate(() => document.cookie);
  const parentDom = await page.content();
  const frameUrls = page.frames().map((f) => f.url());
  const frameReferrers: string[] = [];
  for (const frame of page.frames()) {
    try {
      frameReferrers.push(await frame.evaluate(() => document.referrer));
    } catch {
      frameReferrers.push("");
    }
  }

  return {
    messages,
    consoleLines,
    parentStorage,
    parentCookies,
    parentDom,
    frameUrls,
    frameReferrers,
  };
}

/**
 * Every place the AC names, as one searchable blob — minus the harness's own
 * sentinel, which is deliberately credential-SHAPED and would otherwise make the
 * positive control fail the very assertion it exists to enable.
 */
export function searchableSurface(evidence: EgressEvidence): string {
  return [
    JSON.stringify(evidence.messages),
    evidence.consoleLines.join("\n"),
    evidence.parentStorage,
    evidence.parentCookies,
    evidence.parentDom,
    evidence.frameUrls.join("\n"),
    evidence.frameReferrers.join("\n"),
  ]
    .join("\n")
    .split(HARNESS_SENTINEL)
    .join("[[harness-sentinel]]");
}
