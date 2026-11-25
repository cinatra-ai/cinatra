// ---------------------------------------------------------------------------
// THE ADDRESSES THE OPEN-IN-THE-CMS ROAD MAY OPEN (cinatra#3092), read on the
// island's server from the pinned targets this document draws.
//
// The island's host listener (`island-open-link.tsx`) hands a link's address
// to the card only when the address EQUALS one of these. They come from the
// target's own display props, which the host built from the pinned revision:
// the host-authorized `actions.openInSource`, and every text in the pinned
// content projection (for a text projection, in its text read as JSON) that
// passes the source-link rule. The read names no artifact type and no field of
// any type's form: core treats a type's content as opaque, and this only
// collects addresses from it. So a display can hand the card an address its
// pinned data holds and no other, and markup drawn from data cannot add one.
//
// ONE URL RULE. An address is what the canonical source-link rule accepts
// (`sourceLinkHref`, the mirror of the artifact service's rule that admits the
// "Open in source application" address: http or https, in parsed form), and it
// carries no user name or password. A self-hosted or LAN CMS on http is
// therefore openable, as its source link is; `javascript:`, `data:` and every
// other text the rule refuses stay refused.
//
// Pure, and shared by the server render and the client listener, so both read
// an address in the same parsed form.
// ---------------------------------------------------------------------------

import { sourceLinkHref } from "@cinatra-ai/agent-ui-protocol/renderable-views";

/** At most this many addresses per target, read at most this deep. */
const MAX_ADDRESSES = 64;
const MAX_DEPTH = 32;
const MAX_NODES = 20_000;

/**
 * The parsed form of an address the road may open, or null: what the
 * source-link rule accepts, without a user name or password.
 */
export function islandOpenableAddress(value: unknown): string | null {
  const href = sourceLinkHref(value);
  if (href === null) return null;
  const url = new URL(href);
  if (url.username !== "" || url.password !== "") return null;
  return href;
}

/** The slice of the display props this reads. */
type OpenableSource = {
  actions?: { openInSource?: unknown } | null;
  content?: unknown;
} | null | undefined;

/** The addresses of one pinned target, in parsed form, without repeats. */
export function islandOpenableAddresses(props: OpenableSource): string[] {
  if (!props || typeof props !== "object") return [];
  const found = new Set<string>();
  let nodes = 0;
  const add = (value: unknown) => {
    const address = islandOpenableAddress(value);
    if (address !== null && found.size < MAX_ADDRESSES) found.add(address);
  };
  const walk = (value: unknown, depth: number) => {
    if (found.size >= MAX_ADDRESSES || depth > MAX_DEPTH || nodes >= MAX_NODES) return;
    nodes += 1;
    if (typeof value === "string") {
      add(value);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
    for (const child of children) walk(child, depth + 1);
  };

  add(props.actions?.openInSource);
  const content = props.content;
  walk(content, 0);
  if (
    typeof content === "object" &&
    content !== null &&
    (content as { kind?: unknown }).kind === "text" &&
    typeof (content as { text?: unknown }).text === "string"
  ) {
    let parsed: unknown;
    try {
      parsed = JSON.parse((content as { text: string }).text);
    } catch {
      parsed = undefined;
    }
    walk(parsed, 0);
  }
  return [...found];
}
