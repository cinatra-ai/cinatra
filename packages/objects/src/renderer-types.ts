// ---------------------------------------------------------------------------
// @cinatra/object-types / renderer-types (secondary entry)
// ---------------------------------------------------------------------------
//
// React-aware narrowing of the opaque RendererComponent<T> from ./types.
// Consumers that want strong React typing import from
// "@cinatra/object-types/renderer-types". Pure-logic consumers keep using the
// base entry point, which has zero React dependency.
// ---------------------------------------------------------------------------

import type { ComponentType } from "react";
import type { ObjectTypeDefinition } from "./types";

// ---------------------------------------------------------------------------
// Slot typing
// ---------------------------------------------------------------------------

export type ObjectRendererMode = "edit" | "view";

export type ObjectRendererSlotProps<T = unknown> = {
  value: T;
  mode?: ObjectRendererMode;
  compact?: boolean;
  onEdit?: (next: T) => void;
};

export type ObjectRendererSlot<T = unknown> = ComponentType<ObjectRendererSlotProps<T>>;

export type ObjectRendererSlots<T = unknown> = {
  listRow: ObjectRendererSlot<T>;
  card: ObjectRendererSlot<T>;
  detail: ObjectRendererSlot<T>;
  inline?: ObjectRendererSlot<T>;
};

// ---------------------------------------------------------------------------
// Narrowed definition
// ---------------------------------------------------------------------------

/**
 * Narrowed variant of `ObjectTypeDefinition<T>` where the `renderers` slot
 * bag is typed as React component types. Consumers registering object types
 * from the Next.js app should annotate their definition with this type to
 * get full component-prop inference on `listRow` / `card` / `detail` /
 * `inline`.
 */
export type ObjectTypeDefinitionWithReactRenderers<T = unknown> = Omit<
  ObjectTypeDefinition<T>,
  "renderers"
> & {
  renderers: ObjectRendererSlots<T>;
};

// ---------------------------------------------------------------------------
// Runtime guards
// ---------------------------------------------------------------------------

/**
 * Runtime type guard. Returns true when all required slots (`listRow`,
 * `card`, `detail`) are functions and `inline` is either absent or a
 * function. The React `ComponentType` union cannot be reflected at runtime,
 * so we assert "is a function with arity ≤ 1" — sufficient for catching
 * wiring mistakes (undefined, object, string, multi-arg functions) at
 * registration time.
 *
 * **Limitation:** props-shape compatibility cannot be verified at runtime.
 * A component accepting wrong props will pass this guard and fail only at
 * render time. Use TypeScript's static types (e.g. annotate with
 * `ObjectTypeDefinitionWithReactRenderers<T>`) at the definition site for
 * full safety.
 */
export function hasReactRenderers<T>(
  def: ObjectTypeDefinition<T>,
): def is ObjectTypeDefinitionWithReactRenderers<T> {
  const renderers = def.renderers as unknown;
  if (!renderers || typeof renderers !== "object") {
    return false;
  }
  const slots = renderers as Record<string, unknown>;
  // React components always take a single props argument (arity ≤ 1).
  if (typeof slots.listRow !== "function" || (slots.listRow as Function).length > 1) return false;
  if (typeof slots.card !== "function" || (slots.card as Function).length > 1) return false;
  if (typeof slots.detail !== "function" || (slots.detail as Function).length > 1) return false;
  if (slots.inline !== undefined) {
    if (typeof slots.inline !== "function" || (slots.inline as Function).length > 1) return false;
  }
  return true;
}

/**
 * Dev-only assertion wrapper around {@link hasReactRenderers}. Throws with
 * a descriptive error naming the first offending slot. Use at registration
 * sites to fail fast during module initialization.
 */
export function assertReactRenderers<T>(
  def: ObjectTypeDefinition<T>,
): asserts def is ObjectTypeDefinitionWithReactRenderers<T> {
  const renderers = def.renderers as unknown;
  if (!renderers || typeof renderers !== "object") {
    throw new Error(
      `assertReactRenderers: object type "${def.type}" has no renderers object`,
    );
  }
  const slots = renderers as Record<string, unknown>;
  const requiredSlots: ReadonlyArray<keyof ObjectRendererSlots> = [
    "listRow",
    "card",
    "detail",
  ];
  for (const slot of requiredSlots) {
    if (typeof slots[slot] !== "function") {
      throw new Error(
        `assertReactRenderers: object type "${def.type}" is missing required renderer slot "${slot}" (got ${typeof slots[slot]})`,
      );
    }
    if ((slots[slot] as Function).length > 1) {
      throw new Error(
        `assertReactRenderers: object type "${def.type}" renderer slot "${slot}" takes ${(slots[slot] as Function).length} arguments — React components take exactly one (props)`,
      );
    }
  }
  if (slots.inline !== undefined) {
    if (typeof slots.inline !== "function") {
      throw new Error(
        `assertReactRenderers: object type "${def.type}" has optional slot "inline" set to non-function (got ${typeof slots.inline})`,
      );
    }
    if ((slots.inline as Function).length > 1) {
      throw new Error(
        `assertReactRenderers: object type "${def.type}" renderer slot "inline" takes ${(slots.inline as Function).length} arguments — React components take exactly one (props)`,
      );
    }
  }
}
