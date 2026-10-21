// ---------------------------------------------------------------------------
// THE ADDRESS A RATE LIMIT IS KEYED ON, read from the hop the platform writes.
// ---------------------------------------------------------------------------
//
// `X-Forwarded-For` is a list, and its writers are not equal. The client writes
// whatever it likes into the header it sends; each proxy it passes then APPENDS
// the address of the peer that connected to it. The platform's proxy in front of
// an instance does exactly that (`proxy_set_header X-Forwarded-For
// $proxy_add_x_forwarded_for`, which is "<what the caller sent>, <the socket
// address the proxy saw>"), and with no proxy in front the framework fills the
// header with the connecting socket's address when the client sent none
// (`x-forwarded-for ??= socket.remoteAddress`, see @/lib/request-peer). In both
// shapes the LAST hop is the one this side wrote; every earlier hop is text the
// caller chose.
//
// So the key is the last hop, never the first. Keyed on the first hop, a caller
// could name any address it liked: about 30 junk requests a minute naming a
// victim's address filled that victim's bucket and refused its sign-ins and
// renewals, and a caller rotating the first hop got a fresh bucket each time.
// Keyed on the last hop, the forged hops are simply not read: the same client is
// one bucket whatever it writes in front, and its requests can only fill its own.
// What this does not cover: an instance reached WITHOUT the platform's proxy
// in front, by a caller that sends the header itself, reads that caller's own
// last hop. Instances are served through the proxy.
//
// This grants no trust. The value keys a speed bump and an audit field; it never
// authorizes anything (the token verifiers decide). A header with no hop left
// after trimming keys the shared "unknown" bucket, as before.
// ---------------------------------------------------------------------------

/** The shape a `Headers`, a `NextRequest.headers` and a test double all satisfy. */
type HeaderBag = { get(name: string): string | null };

export function rateLimitClientAddress(request: { headers: HeaderBag }): string {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) {
    const hops = fwd.split(",");
    return hops[hops.length - 1]?.trim() || "unknown";
  }
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}
