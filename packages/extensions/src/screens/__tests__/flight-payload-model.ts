// ---------------------------------------------------------------------------
// flight-payload-model — a deterministic model of the React Server Components
// payload a rendered screen ships to the browser (cinatra#2539, page-size half).
//
// WHY a model and not the real encoder: the real flight encoder
// (react-server-dom-*) only runs under the `react-server` export condition
// inside a Next build. This module reproduces the ONE property the page-size
// question turns on — the flight row for an element is essentially the JSON of
// that element:
//
//   host element   <div className="x">y</div>
//     -> ["$","div",null,{"className":"x","children":"y"}]
//   client element <Panel a={1}/>
//     -> ["$","$L7",null,{"a":1}]        (module reference + SERIALIZED PROPS)
//   server element <Card .../>
//     -> not in the payload at all; its OUTPUT is, recursively.
//
// So: everything a server component renders is serialized, AND every prop
// handed to a client component is serialized — including a prop whose value is
// a server-rendered element tree that the client may never mount.
//
// The absolute byte count is a model (it omits chunk framing, row ids and
// string escaping the real encoder adds, all of which scale with the same
// drivers). The COMPARISON is exact: before/after run through the identical
// encoder, so a delta is a real delta.
// ---------------------------------------------------------------------------

import { isValidElement, type ReactElement, type ReactNode } from "react";

const REACT_FRAGMENT = Symbol.for("react.fragment");

/**
 * Components that carry `"use client"` in production. Flight NEVER renders
 * these: it emits a module reference plus the serialized props. The model takes
 * the set explicitly so a test can stand a client component in as a same-named,
 * same-props stub instead of importing its whole browser dependency graph — the
 * payload bytes are identical either way, because only the props are encoded.
 */
export type ClientBoundarySet = ReadonlySet<unknown>;

export type FlightEncodeOptions = {
  clients: ClientBoundarySet;
  /** Collects the distinct client modules referenced (declaration cost). */
  onClientRef?: (type: unknown) => void;
};

function isPromiseLike(v: unknown): v is Promise<unknown> {
  return typeof v === "object" && v !== null && typeof (v as { then?: unknown }).then === "function";
}

function encodeProps(
  props: Record<string, unknown>,
  opts: FlightEncodeOptions,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined) continue;
    out[key] = encodeValue(value, opts);
  }
  return out;
}

function encodeValue(value: unknown, opts: FlightEncodeOptions): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "string" || typeof value === "number") return value;
  // A server action crossing the boundary is a short reference, not a body.
  if (typeof value === "function") return "$F1";
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => encodeValue(v, opts));
  if (isValidElement(value)) return encodeElement(value, opts);
  if (typeof value === "object") {
    return encodeProps(value as Record<string, unknown>, opts);
  }
  return String(value);
}

function encodeElement(element: ReactElement, opts: FlightEncodeOptions): unknown {
  const { type, key } = element as ReactElement & { key: string | null };
  const props = (element.props ?? {}) as Record<string, unknown>;

  if (opts.clients.has(type)) {
    opts.onClientRef?.(type);
    // Module reference + the props, exactly as flight ships them.
    return ["$", "$L1", key ?? null, encodeProps(props, opts)];
  }

  if (typeof type === "string") {
    return ["$", type, key ?? null, encodeProps(props, opts)];
  }

  if ((type as unknown) === REACT_FRAGMENT) {
    return ["$", "", key ?? null, encodeProps(props, opts)];
  }

  if (typeof type === "function") {
    // A SERVER component: it never appears in the payload — its output does.
    const rendered = (type as (p: unknown) => ReactNode)(props);
    if (isPromiseLike(rendered)) {
      throw new Error(
        "flight-payload-model: async server components are not modelled — resolve the data before composing the tree",
      );
    }
    return encodeValue(rendered, opts);
  }

  // forwardRef / memo / provider objects: keep the wrapper opaque and encode
  // the children through, which is what dominates the bytes.
  return ["$", "$?", key ?? null, encodeProps(props, opts)];
}

/** The modelled flight payload for a node, as a JSON-able structure. */
export function encodeFlight(node: ReactNode, opts: FlightEncodeOptions): unknown {
  return encodeValue(node, opts);
}

/** Modelled flight bytes for a node. */
export function flightBytes(node: ReactNode, clients: ClientBoundarySet): number {
  return Buffer.byteLength(JSON.stringify(encodeFlight(node, { clients })), "utf8");
}

/** Modelled flight bytes for a plain (non-element) value — a prop payload. */
export function valueBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(encodeValue(value, { clients: new Set() })), "utf8");
}
