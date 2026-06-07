// ---------------------------------------------------------------------------
// A2UI v0.9 message types for @cinatra-ai/agent-ui-protocol
// Plain TypeScript types — no zod import, no server-only constraint.
// Hand-mirrored from A2UI v0.9 spec to avoid @a2ui/web_core runtime dep
// (which pulls in zod ^3.x — incompatible with workspace zod ^4.x).
// ---------------------------------------------------------------------------

export const A2UI_MESSAGE_TYPES = [
  "createSurface",
  "updateComponents",
  "updateDataModel",
  "deleteSurface",
] as const;

export type A2UiMessageType = (typeof A2UI_MESSAGE_TYPES)[number];

// ---------------------------------------------------------------------------
// Component definition — flat adjacency list format (v0.9 spec).
// children: string[] (sibling list) | { componentId: string; path: string } (list template)
// child: string (single child shorthand)
// All additional props are component-specific (text, variant, direction, etc.)
// ---------------------------------------------------------------------------

export type ComponentDefinition = {
  id: string;
  component: string;
  children?: string[] | { componentId: string; path: string };
  child?: string;
  [prop: string]: unknown;
};

// ---------------------------------------------------------------------------
// Message variants
// ---------------------------------------------------------------------------

export type CreateSurfaceMessage = {
  version: "v0.9";
  createSurface: {
    surfaceId: string;
    /** REQUIRED per A2UI v0.9 spec — identifies which component catalog to use. */
    catalogId: string;
    sendDataModel?: boolean;
  };
};

export type UpdateComponentsMessage = {
  version: "v0.9";
  updateComponents: {
    surfaceId: string;
    components: ComponentDefinition[];
  };
};

export type UpdateDataModelMessage = {
  version: "v0.9";
  updateDataModel: {
    surfaceId: string;
    path: string;
    value: unknown;
  };
};

export type DeleteSurfaceMessage = {
  version: "v0.9";
  deleteSurface: {
    surfaceId: string;
  };
};

export type A2UiMessage =
  | CreateSurfaceMessage
  | UpdateComponentsMessage
  | UpdateDataModelMessage
  | DeleteSurfaceMessage;
