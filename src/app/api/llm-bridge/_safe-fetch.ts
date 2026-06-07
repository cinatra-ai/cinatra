import { lookup as dnsLookup } from "node:dns";
import { Agent } from "undici";

import {
  BridgeUrlError,
  validateAddress,
  validateExternalUrl,
} from "./_url-validation";

const MAX_REDIRECTS = 3;

// LookupFunction signature as used by undici's connect.lookup option.
// Undici's typings vary across versions; this is the practical shape.
type SafeLookupOptions = { all?: boolean; family?: number; verbatim?: boolean };
type SafeLookupCallback = (
  err: NodeJS.ErrnoException | null,
  address?: string | { address: string; family: number }[],
  family?: number,
) => void;

// Resolve all A/AAAA records; reject if any is in a blocked CIDR.
// The SAME lookup runs inside the dispatcher's `connect` path, so the
// validated address IS the one used for the TCP connection — no
// validate-then-fetch TOCTOU window.
export function safeLookup(
  hostname: string,
  optionsOrCallback: SafeLookupOptions | SafeLookupCallback,
  maybeCallback?: SafeLookupCallback,
): void {
  const callback =
    typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback!;
  const options =
    typeof optionsOrCallback === "function" ? {} : optionsOrCallback;
  dnsLookup(
    hostname,
    { all: true, verbatim: true },
    (err, addresses) => {
      if (err) {
        callback(err);
        return;
      }
      const all = Array.isArray(addresses) ? addresses : [addresses];
      for (const a of all) {
        if (!validateAddress(a.address, a.family as 4 | 6)) {
          const blocked = new BridgeUrlError(
            "BRIDGE-URL-HOST-BLOCKED",
            `resolved address ${a.address} for ${hostname} is in a blocked range`,
          ) as unknown as NodeJS.ErrnoException;
          callback(blocked);
          return;
        }
      }
      if (options.all) {
        callback(null, all);
      } else {
        const first = all[0];
        callback(null, first.address, first.family);
      }
    },
  );
}

// Module-scoped agent — Node manages its lifecycle for the process.
// Tests inject a dispatcher via the `dispatcher` option below.
let cachedAgent: Agent | null = null;
function getDefaultAgent(): Agent {
  if (cachedAgent === null) {
    cachedAgent = new Agent({
      connect: {
        // Cast: undici's LookupFunction shape is internal and varies.
        lookup: safeLookup as unknown as Agent.Options["connect"] extends infer C
          ? C extends { lookup?: infer L }
            ? L
            : never
          : never,
      },
    });
  }
  return cachedAgent;
}

export type SafeFetchOptions = {
  method?: string;
  headers?: Record<string, string>;
  maxRedirects?: number;
  // Test seam — override the underlying fetch implementation.
  fetchImpl?: typeof globalThis.fetch;
};

export async function safeFetch(
  url: URL,
  options: SafeFetchOptions = {},
): Promise<Response> {
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const dispatcher = getDefaultAgent();
  let currentUrl = url;
  let remaining = maxRedirects;
  while (true) {
    // Node's globalThis.fetch IS undici; the `dispatcher` option is honored
    // when present and ignored otherwise (test mocks via vi.spyOn ignore it).
    const response = await fetchImpl(currentUrl.toString(), {
      method: options.method ?? "GET",
      headers: options.headers,
      redirect: "manual",
      // @ts-expect-error -- undici-specific extension to RequestInit
      dispatcher,
    });
    if (response.status >= 300 && response.status < 400) {
      if (remaining <= 0) {
        try {
          await response.body?.cancel();
        } catch {
          /* ignore */
        }
        throw new BridgeUrlError(
          "BRIDGE-URL-REDIRECT-LIMIT",
          `exceeded ${maxRedirects} redirect hops`,
        );
      }
      const location = response.headers.get("location");
      if (!location) {
        return response;
      }
      const resolved = new URL(location, currentUrl);
      currentUrl = validateExternalUrl(resolved.toString());
      remaining -= 1;
      try {
        await response.body?.cancel();
      } catch {
        /* ignore */
      }
      continue;
    }
    return response;
  }
}
