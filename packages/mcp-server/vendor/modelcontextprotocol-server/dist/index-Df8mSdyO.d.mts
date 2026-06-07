import * as z from "zod/v4";
import { Ajv } from "ajv";
import { JSONSchema } from "json-schema-typed";

//#region ../core/src/types/schemas.d.ts

/**
 * Task creation parameters, used to ask that the server create a task to represent a request.
 */
declare const TaskCreationParamsSchema: z.ZodObject<{
  /**
   * Requested duration in milliseconds to retain task from creation.
   */
  ttl: z.ZodOptional<z.ZodNumber>;
  /**
   * Time in milliseconds to wait between task status requests.
   */
  pollInterval: z.ZodOptional<z.ZodNumber>;
}, z.core.$loose>;
/**
 * Metadata for associating messages with a task.
 * Include this in the `_meta` field under the key `io.modelcontextprotocol/related-task`.
 */
declare const RelatedTaskMetadataSchema: z.ZodObject<{
  taskId: z.ZodString;
}, z.core.$strip>;
declare const RequestMetaSchema: z.ZodObject<{
  /**
   * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
   */
  progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
  /**
   * If specified, this request is related to the provided task.
   */
  "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
    taskId: z.ZodString;
  }, z.core.$strip>>;
}, z.core.$loose>;
declare const RequestSchema: z.ZodObject<{
  method: z.ZodString;
  params: z.ZodOptional<z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
  }, z.core.$loose>>;
}, z.core.$strip>;
declare const NotificationSchema: z.ZodObject<{
  method: z.ZodString;
  params: z.ZodOptional<z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
  }, z.core.$loose>>;
}, z.core.$strip>;
declare const ResultSchema: z.ZodObject<{
  /**
   * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
   * for notes on `_meta` usage.
   */
  _meta: z.ZodOptional<z.ZodObject<{
    /**
     * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
     */
    progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
    /**
     * If specified, this request is related to the provided task.
     */
    "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
      taskId: z.ZodString;
    }, z.core.$strip>>;
  }, z.core.$loose>>;
}, z.core.$loose>;
/**
 * A uniquely identifying ID for a request in JSON-RPC.
 */
declare const RequestIdSchema: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
/**
 * A request that expects a response.
 */
declare const JSONRPCRequestSchema: z.ZodObject<{
  method: z.ZodString;
  params: z.ZodOptional<z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
  }, z.core.$loose>>;
  jsonrpc: z.ZodLiteral<"2.0">;
  id: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
}, z.core.$strict>;
/**
 * A notification which does not expect a response.
 */
declare const JSONRPCNotificationSchema: z.ZodObject<{
  method: z.ZodString;
  params: z.ZodOptional<z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
  }, z.core.$loose>>;
  jsonrpc: z.ZodLiteral<"2.0">;
}, z.core.$strict>;
/**
 * A successful (non-error) response to a request.
 */
declare const JSONRPCResultResponseSchema: z.ZodObject<{
  jsonrpc: z.ZodLiteral<"2.0">;
  id: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
  result: z.ZodObject<{
    /**
     * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
     * for notes on `_meta` usage.
     */
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
  }, z.core.$loose>;
}, z.core.$strict>;
/**
 * A response to a request that indicates an error occurred.
 */
declare const JSONRPCErrorResponseSchema: z.ZodObject<{
  jsonrpc: z.ZodLiteral<"2.0">;
  id: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
  error: z.ZodObject<{
    code: z.ZodNumber;
    message: z.ZodString;
    data: z.ZodOptional<z.ZodUnknown>;
  }, z.core.$strip>;
}, z.core.$strict>;
declare const JSONRPCMessageSchema: z.ZodUnion<readonly [z.ZodObject<{
  method: z.ZodString;
  params: z.ZodOptional<z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
  }, z.core.$loose>>;
  jsonrpc: z.ZodLiteral<"2.0">;
  id: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
}, z.core.$strict>, z.ZodObject<{
  method: z.ZodString;
  params: z.ZodOptional<z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
  }, z.core.$loose>>;
  jsonrpc: z.ZodLiteral<"2.0">;
}, z.core.$strict>, z.ZodObject<{
  jsonrpc: z.ZodLiteral<"2.0">;
  id: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
  result: z.ZodObject<{
    /**
     * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
     * for notes on `_meta` usage.
     */
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
  }, z.core.$loose>;
}, z.core.$strict>, z.ZodObject<{
  jsonrpc: z.ZodLiteral<"2.0">;
  id: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
  error: z.ZodObject<{
    code: z.ZodNumber;
    message: z.ZodString;
    data: z.ZodOptional<z.ZodUnknown>;
  }, z.core.$strip>;
}, z.core.$strict>]>;
declare const JSONRPCResponseSchema: z.ZodUnion<readonly [z.ZodObject<{
  jsonrpc: z.ZodLiteral<"2.0">;
  id: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
  result: z.ZodObject<{
    /**
     * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
     * for notes on `_meta` usage.
     */
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
  }, z.core.$loose>;
}, z.core.$strict>, z.ZodObject<{
  jsonrpc: z.ZodLiteral<"2.0">;
  id: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
  error: z.ZodObject<{
    code: z.ZodNumber;
    message: z.ZodString;
    data: z.ZodOptional<z.ZodUnknown>;
  }, z.core.$strip>;
}, z.core.$strict>]>;
/**
 * A response that indicates success but carries no data.
 */
declare const EmptyResultSchema: z.ZodObject<{
  /**
   * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
   * for notes on `_meta` usage.
   */
  _meta: z.ZodOptional<z.ZodObject<{
    /**
     * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
     */
    progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
    /**
     * If specified, this request is related to the provided task.
     */
    "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
      taskId: z.ZodString;
    }, z.core.$strip>>;
  }, z.core.$loose>>;
}, z.core.$strict>;
/**
 * Describes the name and version of an MCP implementation.
 */
declare const ImplementationSchema: z.ZodObject<{
  version: z.ZodString;
  websiteUrl: z.ZodOptional<z.ZodString>;
  description: z.ZodOptional<z.ZodString>;
  icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
    src: z.ZodString;
    mimeType: z.ZodOptional<z.ZodString>;
    sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
    theme: z.ZodOptional<z.ZodEnum<{
      light: "light";
      dark: "dark";
    }>>;
  }, z.core.$strip>>>;
  name: z.ZodString;
  title: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/**
 * Capabilities a client may support. Known capabilities are defined here, in this schema, but this is not a closed set: any client can define its own, additional capabilities.
 */
declare const ClientCapabilitiesSchema: z.ZodObject<{
  experimental: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodType<JSONObject, unknown, z.core.$ZodTypeInternals<JSONObject, unknown>>>>;
  sampling: z.ZodOptional<z.ZodObject<{
    context: z.ZodOptional<z.ZodType<JSONObject, unknown, z.core.$ZodTypeInternals<JSONObject, unknown>>>;
    tools: z.ZodOptional<z.ZodType<JSONObject, unknown, z.core.$ZodTypeInternals<JSONObject, unknown>>>;
  }, z.core.$strip>>;
  elicitation: z.ZodOptional<z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodIntersection<z.ZodObject<{
    form: z.ZodOptional<z.ZodIntersection<z.ZodObject<{
      applyDefaults: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>, z.ZodType<JSONObject, unknown, z.core.$ZodTypeInternals<JSONObject, unknown>>>>;
    url: z.ZodOptional<z.ZodType<JSONObject, unknown, z.core.$ZodTypeInternals<JSONObject, unknown>>>;
  }, z.core.$strip>, z.ZodOptional<z.ZodType<JSONObject, unknown, z.core.$ZodTypeInternals<JSONObject, unknown>>>>>>;
  roots: z.ZodOptional<z.ZodObject<{
    listChanged: z.ZodOptional<z.ZodBoolean>;
  }, z.core.$strip>>;
  tasks: z.ZodOptional<z.ZodObject<{
    /**
     * Present if the client supports listing tasks.
     */
    list: z.ZodOptional<z.ZodType<JSONObject, unknown, z.core.$ZodTypeInternals<JSONObject, unknown>>>;
    /**
     * Present if the client supports cancelling tasks.
     */
    cancel: z.ZodOptional<z.ZodType<JSONObject, unknown, z.core.$ZodTypeInternals<JSONObject, unknown>>>;
    /**
     * Capabilities for task creation on specific request types.
     */
    requests: z.ZodOptional<z.ZodObject<{
      /**
       * Task support for sampling requests.
       */
      sampling: z.ZodOptional<z.ZodObject<{
        createMessage: z.ZodOptional<z.ZodType<JSONObject, unknown, z.core.$ZodTypeInternals<JSONObject, unknown>>>;
      }, z.core.$loose>>;
      /**
       * Task support for elicitation requests.
       */
      elicitation: z.ZodOptional<z.ZodObject<{
        create: z.ZodOptional<z.ZodType<JSONObject, unknown, z.core.$ZodTypeInternals<JSONObject, unknown>>>;
      }, z.core.$loose>>;
    }, z.core.$loose>>;
  }, z.core.$loose>>;
  extensions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodType<JSONObject, unknown, z.core.$ZodTypeInternals<JSONObject, unknown>>>>;
}, z.core.$strip>;
/**
 * Capabilities that a server may support. Known capabilities are defined here, in this schema, but this is not a closed set: any server can define its own, additional capabilities.
 */
declare const ServerCapabilitiesSchema: z.ZodObject<{
  experimental: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodType<JSONObject, unknown, z.core.$ZodTypeInternals<JSONObject, unknown>>>>;
  logging: z.ZodOptional<z.ZodType<JSONObject, unknown, z.core.$ZodTypeInternals<JSONObject, unknown>>>;
  completions: z.ZodOptional<z.ZodType<JSONObject, unknown, z.core.$ZodTypeInternals<JSONObject, unknown>>>;
  prompts: z.ZodOptional<z.ZodObject<{
    listChanged: z.ZodOptional<z.ZodBoolean>;
  }, z.core.$strip>>;
  resources: z.ZodOptional<z.ZodObject<{
    subscribe: z.ZodOptional<z.ZodBoolean>;
    listChanged: z.ZodOptional<z.ZodBoolean>;
  }, z.core.$strip>>;
  tools: z.ZodOptional<z.ZodObject<{
    listChanged: z.ZodOptional<z.ZodBoolean>;
  }, z.core.$strip>>;
  tasks: z.ZodOptional<z.ZodObject<{
    /**
     * Present if the server supports listing tasks.
     */
    list: z.ZodOptional<z.ZodType<JSONObject, unknown, z.core.$ZodTypeInternals<JSONObject, unknown>>>;
    /**
     * Present if the server supports cancelling tasks.
     */
    cancel: z.ZodOptional<z.ZodType<JSONObject, unknown, z.core.$ZodTypeInternals<JSONObject, unknown>>>;
    /**
     * Capabilities for task creation on specific request types.
     */
    requests: z.ZodOptional<z.ZodObject<{
      /**
       * Task support for tool requests.
       */
      tools: z.ZodOptional<z.ZodObject<{
        call: z.ZodOptional<z.ZodType<JSONObject, unknown, z.core.$ZodTypeInternals<JSONObject, unknown>>>;
      }, z.core.$loose>>;
    }, z.core.$loose>>;
  }, z.core.$loose>>;
  extensions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodType<JSONObject, unknown, z.core.$ZodTypeInternals<JSONObject, unknown>>>>;
}, z.core.$strip>;
/**
 * After receiving an initialize request from the client, the server sends this response.
 */
declare const InitializeResultSchema: z.ZodObject<{
  _meta: z.ZodOptional<z.ZodObject<{
    /**
     * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
     */
    progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
    /**
     * If specified, this request is related to the provided task.
     */
    "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
      taskId: z.ZodString;
    }, z.core.$strip>>;
  }, z.core.$loose>>;
  protocolVersion: z.ZodString;
  capabilities: z.ZodObject<{
    experimental: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodType<JSONObject, unknown, z.core.$ZodTypeInternals<JSONObject, unknown>>>>;
    logging: z.ZodOptional<z.ZodType<JSONObject, unknown, z.core.$ZodTypeInternals<JSONObject, unknown>>>;
    completions: z.ZodOptional<z.ZodType<JSONObject, unknown, z.core.$ZodTypeInternals<JSONObject, unknown>>>;
    prompts: z.ZodOptional<z.ZodObject<{
      listChanged: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    resources: z.ZodOptional<z.ZodObject<{
      subscribe: z.ZodOptional<z.ZodBoolean>;
      listChanged: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    tools: z.ZodOptional<z.ZodObject<{
      listChanged: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    tasks: z.ZodOptional<z.ZodObject<{
      /**
       * Present if the server supports listing tasks.
       */
      list: z.ZodOptional<z.ZodType<JSONObject, unknown, z.core.$ZodTypeInternals<JSONObject, unknown>>>;
      /**
       * Present if the server supports cancelling tasks.
       */
      cancel: z.ZodOptional<z.ZodType<JSONObject, unknown, z.core.$ZodTypeInternals<JSONObject, unknown>>>;
      /**
       * Capabilities for task creation on specific request types.
       */
      requests: z.ZodOptional<z.ZodObject<{
        /**
         * Task support for tool requests.
         */
        tools: z.ZodOptional<z.ZodObject<{
          call: z.ZodOptional<z.ZodType<JSONObject, unknown, z.core.$ZodTypeInternals<JSONObject, unknown>>>;
        }, z.core.$loose>>;
      }, z.core.$loose>>;
    }, z.core.$loose>>;
    extensions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodType<JSONObject, unknown, z.core.$ZodTypeInternals<JSONObject, unknown>>>>;
  }, z.core.$strip>;
  serverInfo: z.ZodObject<{
    version: z.ZodString;
    websiteUrl: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
      src: z.ZodString;
      mimeType: z.ZodOptional<z.ZodString>;
      sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
      theme: z.ZodOptional<z.ZodEnum<{
        light: "light";
        dark: "dark";
      }>>;
    }, z.core.$strip>>>;
    name: z.ZodString;
    title: z.ZodOptional<z.ZodString>;
  }, z.core.$strip>;
  instructions: z.ZodOptional<z.ZodString>;
}, z.core.$loose>;
declare const ProgressSchema: z.ZodObject<{
  progress: z.ZodNumber;
  total: z.ZodOptional<z.ZodNumber>;
  message: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/**
 * A pollable state object associated with a request.
 */
declare const TaskSchema: z.ZodObject<{
  taskId: z.ZodString;
  status: z.ZodEnum<{
    working: "working";
    input_required: "input_required";
    completed: "completed";
    failed: "failed";
    cancelled: "cancelled";
  }>;
  ttl: z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>;
  createdAt: z.ZodString;
  lastUpdatedAt: z.ZodString;
  pollInterval: z.ZodOptional<z.ZodNumber>;
  statusMessage: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/**
 * Result returned when a task is created, containing the task data wrapped in a `task` field.
 */
declare const CreateTaskResultSchema: z.ZodObject<{
  _meta: z.ZodOptional<z.ZodObject<{
    /**
     * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
     */
    progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
    /**
     * If specified, this request is related to the provided task.
     */
    "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
      taskId: z.ZodString;
    }, z.core.$strip>>;
  }, z.core.$loose>>;
  task: z.ZodObject<{
    taskId: z.ZodString;
    status: z.ZodEnum<{
      working: "working";
      input_required: "input_required";
      completed: "completed";
      failed: "failed";
      cancelled: "cancelled";
    }>;
    ttl: z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>;
    createdAt: z.ZodString;
    lastUpdatedAt: z.ZodString;
    pollInterval: z.ZodOptional<z.ZodNumber>;
    statusMessage: z.ZodOptional<z.ZodString>;
  }, z.core.$strip>;
}, z.core.$loose>;
/**
 * A request to get the state of a specific task.
 */
declare const GetTaskRequestSchema: z.ZodObject<{
  method: z.ZodLiteral<"tasks/get">;
  params: z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
    taskId: z.ZodString;
  }, z.core.$strip>;
}, z.core.$strip>;
/**
 * The response to a {@linkcode GetTaskRequest | tasks/get} request.
 */
declare const GetTaskResultSchema: z.ZodObject<{
  _meta: z.ZodOptional<z.ZodObject<{
    /**
     * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
     */
    progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
    /**
     * If specified, this request is related to the provided task.
     */
    "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
      taskId: z.ZodString;
    }, z.core.$strip>>;
  }, z.core.$loose>>;
  taskId: z.ZodString;
  status: z.ZodEnum<{
    working: "working";
    input_required: "input_required";
    completed: "completed";
    failed: "failed";
    cancelled: "cancelled";
  }>;
  ttl: z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>;
  createdAt: z.ZodString;
  lastUpdatedAt: z.ZodString;
  pollInterval: z.ZodOptional<z.ZodNumber>;
  statusMessage: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/**
 * A request to get the result of a specific task.
 */
declare const GetTaskPayloadRequestSchema: z.ZodObject<{
  method: z.ZodLiteral<"tasks/result">;
  params: z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
    taskId: z.ZodString;
  }, z.core.$strip>;
}, z.core.$strip>;
/**
 * The response to a `tasks/result` request.
 * The structure matches the result type of the original request.
 * For example, a {@linkcode CallToolRequest | tools/call} task would return the `CallToolResult` structure.
 *
 */
declare const GetTaskPayloadResultSchema: z.ZodObject<{
  /**
   * See [MCP specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/47339c03c143bb4ec01a26e721a1b8fe66634ebe/docs/specification/draft/basic/index.mdx#general-fields)
   * for notes on `_meta` usage.
   */
  _meta: z.ZodOptional<z.ZodObject<{
    /**
     * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
     */
    progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
    /**
     * If specified, this request is related to the provided task.
     */
    "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
      taskId: z.ZodString;
    }, z.core.$strip>>;
  }, z.core.$loose>>;
}, z.core.$loose>;
/**
 * The response to a {@linkcode ListTasksRequest | tasks/list} request.
 */
declare const ListTasksResultSchema: z.ZodObject<{
  _meta: z.ZodOptional<z.ZodObject<{
    /**
     * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
     */
    progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
    /**
     * If specified, this request is related to the provided task.
     */
    "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
      taskId: z.ZodString;
    }, z.core.$strip>>;
  }, z.core.$loose>>;
  nextCursor: z.ZodOptional<z.ZodString>;
  tasks: z.ZodArray<z.ZodObject<{
    taskId: z.ZodString;
    status: z.ZodEnum<{
      working: "working";
      input_required: "input_required";
      completed: "completed";
      failed: "failed";
      cancelled: "cancelled";
    }>;
    ttl: z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>;
    createdAt: z.ZodString;
    lastUpdatedAt: z.ZodString;
    pollInterval: z.ZodOptional<z.ZodNumber>;
    statusMessage: z.ZodOptional<z.ZodString>;
  }, z.core.$strip>>;
}, z.core.$loose>;
/**
 * The response to a {@linkcode CancelTaskRequest | tasks/cancel} request.
 */
declare const CancelTaskResultSchema: z.ZodObject<{
  _meta: z.ZodOptional<z.ZodObject<{
    /**
     * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
     */
    progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
    /**
     * If specified, this request is related to the provided task.
     */
    "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
      taskId: z.ZodString;
    }, z.core.$strip>>;
  }, z.core.$loose>>;
  taskId: z.ZodString;
  status: z.ZodEnum<{
    working: "working";
    input_required: "input_required";
    completed: "completed";
    failed: "failed";
    cancelled: "cancelled";
  }>;
  ttl: z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>;
  createdAt: z.ZodString;
  lastUpdatedAt: z.ZodString;
  pollInterval: z.ZodOptional<z.ZodNumber>;
  statusMessage: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/**
 * A known resource that the server is capable of reading.
 */
declare const ResourceSchema: z.ZodObject<{
  uri: z.ZodString;
  description: z.ZodOptional<z.ZodString>;
  mimeType: z.ZodOptional<z.ZodString>;
  size: z.ZodOptional<z.ZodNumber>;
  annotations: z.ZodOptional<z.ZodObject<{
    audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
      user: "user";
      assistant: "assistant";
    }>>>;
    priority: z.ZodOptional<z.ZodNumber>;
    lastModified: z.ZodOptional<z.ZodISODateTime>;
  }, z.core.$strip>>;
  _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
  icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
    src: z.ZodString;
    mimeType: z.ZodOptional<z.ZodString>;
    sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
    theme: z.ZodOptional<z.ZodEnum<{
      light: "light";
      dark: "dark";
    }>>;
  }, z.core.$strip>>>;
  name: z.ZodString;
  title: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/**
 * The server's response to a {@linkcode ListResourcesRequest | resources/list} request from the client.
 */
declare const ListResourcesResultSchema: z.ZodObject<{
  _meta: z.ZodOptional<z.ZodObject<{
    /**
     * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
     */
    progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
    /**
     * If specified, this request is related to the provided task.
     */
    "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
      taskId: z.ZodString;
    }, z.core.$strip>>;
  }, z.core.$loose>>;
  nextCursor: z.ZodOptional<z.ZodString>;
  resources: z.ZodArray<z.ZodObject<{
    uri: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    mimeType: z.ZodOptional<z.ZodString>;
    size: z.ZodOptional<z.ZodNumber>;
    annotations: z.ZodOptional<z.ZodObject<{
      audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        user: "user";
        assistant: "assistant";
      }>>>;
      priority: z.ZodOptional<z.ZodNumber>;
      lastModified: z.ZodOptional<z.ZodISODateTime>;
    }, z.core.$strip>>;
    _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
    icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
      src: z.ZodString;
      mimeType: z.ZodOptional<z.ZodString>;
      sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
      theme: z.ZodOptional<z.ZodEnum<{
        light: "light";
        dark: "dark";
      }>>;
    }, z.core.$strip>>>;
    name: z.ZodString;
    title: z.ZodOptional<z.ZodString>;
  }, z.core.$strip>>;
}, z.core.$loose>;
/**
 * The server's response to a {@linkcode ListResourceTemplatesRequest | resources/templates/list} request from the client.
 */
declare const ListResourceTemplatesResultSchema: z.ZodObject<{
  _meta: z.ZodOptional<z.ZodObject<{
    /**
     * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
     */
    progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
    /**
     * If specified, this request is related to the provided task.
     */
    "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
      taskId: z.ZodString;
    }, z.core.$strip>>;
  }, z.core.$loose>>;
  nextCursor: z.ZodOptional<z.ZodString>;
  resourceTemplates: z.ZodArray<z.ZodObject<{
    uriTemplate: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    mimeType: z.ZodOptional<z.ZodString>;
    annotations: z.ZodOptional<z.ZodObject<{
      audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        user: "user";
        assistant: "assistant";
      }>>>;
      priority: z.ZodOptional<z.ZodNumber>;
      lastModified: z.ZodOptional<z.ZodISODateTime>;
    }, z.core.$strip>>;
    _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
    icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
      src: z.ZodString;
      mimeType: z.ZodOptional<z.ZodString>;
      sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
      theme: z.ZodOptional<z.ZodEnum<{
        light: "light";
        dark: "dark";
      }>>;
    }, z.core.$strip>>>;
    name: z.ZodString;
    title: z.ZodOptional<z.ZodString>;
  }, z.core.$strip>>;
}, z.core.$loose>;
/**
 * The server's response to a {@linkcode ReadResourceRequest | resources/read} request from the client.
 */
declare const ReadResourceResultSchema: z.ZodObject<{
  _meta: z.ZodOptional<z.ZodObject<{
    /**
     * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
     */
    progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
    /**
     * If specified, this request is related to the provided task.
     */
    "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
      taskId: z.ZodString;
    }, z.core.$strip>>;
  }, z.core.$loose>>;
  contents: z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
    uri: z.ZodString;
    mimeType: z.ZodOptional<z.ZodString>;
    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    text: z.ZodString;
  }, z.core.$strip>, z.ZodObject<{
    uri: z.ZodString;
    mimeType: z.ZodOptional<z.ZodString>;
    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    blob: z.ZodString;
  }, z.core.$strip>]>>;
}, z.core.$loose>;
/**
 * A notification from the server to the client, informing it that a resource has changed and may need to be read again. This should only be sent if the client previously sent a {@linkcode SubscribeRequest | resources/subscribe} request.
 */
declare const ResourceUpdatedNotificationSchema: z.ZodObject<{
  method: z.ZodLiteral<"notifications/resources/updated">;
  params: z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
    uri: z.ZodString;
  }, z.core.$strip>;
}, z.core.$strip>;
/**
 * The server's response to a {@linkcode ListPromptsRequest | prompts/list} request from the client.
 */
declare const ListPromptsResultSchema: z.ZodObject<{
  _meta: z.ZodOptional<z.ZodObject<{
    /**
     * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
     */
    progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
    /**
     * If specified, this request is related to the provided task.
     */
    "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
      taskId: z.ZodString;
    }, z.core.$strip>>;
  }, z.core.$loose>>;
  nextCursor: z.ZodOptional<z.ZodString>;
  prompts: z.ZodArray<z.ZodObject<{
    description: z.ZodOptional<z.ZodString>;
    arguments: z.ZodOptional<z.ZodArray<z.ZodObject<{
      name: z.ZodString;
      description: z.ZodOptional<z.ZodString>;
      required: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>>;
    _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
    icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
      src: z.ZodString;
      mimeType: z.ZodOptional<z.ZodString>;
      sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
      theme: z.ZodOptional<z.ZodEnum<{
        light: "light";
        dark: "dark";
      }>>;
    }, z.core.$strip>>>;
    name: z.ZodString;
    title: z.ZodOptional<z.ZodString>;
  }, z.core.$strip>>;
}, z.core.$loose>;
/**
 * The server's response to a {@linkcode GetPromptRequest | prompts/get} request from the client.
 */
declare const GetPromptResultSchema: z.ZodObject<{
  _meta: z.ZodOptional<z.ZodObject<{
    /**
     * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
     */
    progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
    /**
     * If specified, this request is related to the provided task.
     */
    "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
      taskId: z.ZodString;
    }, z.core.$strip>>;
  }, z.core.$loose>>;
  description: z.ZodOptional<z.ZodString>;
  messages: z.ZodArray<z.ZodObject<{
    role: z.ZodEnum<{
      user: "user";
      assistant: "assistant";
    }>;
    content: z.ZodUnion<readonly [z.ZodObject<{
      type: z.ZodLiteral<"text">;
      text: z.ZodString;
      annotations: z.ZodOptional<z.ZodObject<{
        audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
          user: "user";
          assistant: "assistant";
        }>>>;
        priority: z.ZodOptional<z.ZodNumber>;
        lastModified: z.ZodOptional<z.ZodISODateTime>;
      }, z.core.$strip>>;
      _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
      type: z.ZodLiteral<"image">;
      data: z.ZodString;
      mimeType: z.ZodString;
      annotations: z.ZodOptional<z.ZodObject<{
        audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
          user: "user";
          assistant: "assistant";
        }>>>;
        priority: z.ZodOptional<z.ZodNumber>;
        lastModified: z.ZodOptional<z.ZodISODateTime>;
      }, z.core.$strip>>;
      _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
      type: z.ZodLiteral<"audio">;
      data: z.ZodString;
      mimeType: z.ZodString;
      annotations: z.ZodOptional<z.ZodObject<{
        audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
          user: "user";
          assistant: "assistant";
        }>>>;
        priority: z.ZodOptional<z.ZodNumber>;
        lastModified: z.ZodOptional<z.ZodISODateTime>;
      }, z.core.$strip>>;
      _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
      uri: z.ZodString;
      description: z.ZodOptional<z.ZodString>;
      mimeType: z.ZodOptional<z.ZodString>;
      size: z.ZodOptional<z.ZodNumber>;
      annotations: z.ZodOptional<z.ZodObject<{
        audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
          user: "user";
          assistant: "assistant";
        }>>>;
        priority: z.ZodOptional<z.ZodNumber>;
        lastModified: z.ZodOptional<z.ZodISODateTime>;
      }, z.core.$strip>>;
      _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
      icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
        src: z.ZodString;
        mimeType: z.ZodOptional<z.ZodString>;
        sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
        theme: z.ZodOptional<z.ZodEnum<{
          light: "light";
          dark: "dark";
        }>>;
      }, z.core.$strip>>>;
      name: z.ZodString;
      title: z.ZodOptional<z.ZodString>;
      type: z.ZodLiteral<"resource_link">;
    }, z.core.$strip>, z.ZodObject<{
      type: z.ZodLiteral<"resource">;
      resource: z.ZodUnion<readonly [z.ZodObject<{
        uri: z.ZodString;
        mimeType: z.ZodOptional<z.ZodString>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        text: z.ZodString;
      }, z.core.$strip>, z.ZodObject<{
        uri: z.ZodString;
        mimeType: z.ZodOptional<z.ZodString>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        blob: z.ZodString;
      }, z.core.$strip>]>;
      annotations: z.ZodOptional<z.ZodObject<{
        audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
          user: "user";
          assistant: "assistant";
        }>>>;
        priority: z.ZodOptional<z.ZodNumber>;
        lastModified: z.ZodOptional<z.ZodISODateTime>;
      }, z.core.$strip>>;
      _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>]>;
  }, z.core.$strip>>;
}, z.core.$loose>;
/**
 * Additional properties describing a `Tool` to clients.
 *
 * NOTE: all properties in {@linkcode ToolAnnotations} are **hints**.
 * They are not guaranteed to provide a faithful description of
 * tool behavior (including descriptive properties like `title`).
 *
 * Clients should never make tool use decisions based on `ToolAnnotations`
 * received from untrusted servers.
 */
declare const ToolAnnotationsSchema: z.ZodObject<{
  title: z.ZodOptional<z.ZodString>;
  readOnlyHint: z.ZodOptional<z.ZodBoolean>;
  destructiveHint: z.ZodOptional<z.ZodBoolean>;
  idempotentHint: z.ZodOptional<z.ZodBoolean>;
  openWorldHint: z.ZodOptional<z.ZodBoolean>;
}, z.core.$strip>;
/**
 * Execution-related properties for a tool.
 */
declare const ToolExecutionSchema: z.ZodObject<{
  taskSupport: z.ZodOptional<z.ZodEnum<{
    optional: "optional";
    required: "required";
    forbidden: "forbidden";
  }>>;
}, z.core.$strip>;
/**
 * Definition for a tool the client can call.
 */
declare const ToolSchema: z.ZodObject<{
  description: z.ZodOptional<z.ZodString>;
  inputSchema: z.ZodObject<{
    type: z.ZodLiteral<"object">;
    properties: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodType<JSONValue, unknown, z.core.$ZodTypeInternals<JSONValue, unknown>>>>;
    required: z.ZodOptional<z.ZodArray<z.ZodString>>;
  }, z.core.$catchall<z.ZodUnknown>>;
  outputSchema: z.ZodOptional<z.ZodObject<{
    type: z.ZodLiteral<"object">;
    properties: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodType<JSONValue, unknown, z.core.$ZodTypeInternals<JSONValue, unknown>>>>;
    required: z.ZodOptional<z.ZodArray<z.ZodString>>;
  }, z.core.$catchall<z.ZodUnknown>>>;
  annotations: z.ZodOptional<z.ZodObject<{
    title: z.ZodOptional<z.ZodString>;
    readOnlyHint: z.ZodOptional<z.ZodBoolean>;
    destructiveHint: z.ZodOptional<z.ZodBoolean>;
    idempotentHint: z.ZodOptional<z.ZodBoolean>;
    openWorldHint: z.ZodOptional<z.ZodBoolean>;
  }, z.core.$strip>>;
  execution: z.ZodOptional<z.ZodObject<{
    taskSupport: z.ZodOptional<z.ZodEnum<{
      optional: "optional";
      required: "required";
      forbidden: "forbidden";
    }>>;
  }, z.core.$strip>>;
  _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
  icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
    src: z.ZodString;
    mimeType: z.ZodOptional<z.ZodString>;
    sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
    theme: z.ZodOptional<z.ZodEnum<{
      light: "light";
      dark: "dark";
    }>>;
  }, z.core.$strip>>>;
  name: z.ZodString;
  title: z.ZodOptional<z.ZodString>;
}, z.core.$strip>;
/**
 * The server's response to a {@linkcode ListToolsRequest | tools/list} request from the client.
 */
declare const ListToolsResultSchema: z.ZodObject<{
  _meta: z.ZodOptional<z.ZodObject<{
    /**
     * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
     */
    progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
    /**
     * If specified, this request is related to the provided task.
     */
    "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
      taskId: z.ZodString;
    }, z.core.$strip>>;
  }, z.core.$loose>>;
  nextCursor: z.ZodOptional<z.ZodString>;
  tools: z.ZodArray<z.ZodObject<{
    description: z.ZodOptional<z.ZodString>;
    inputSchema: z.ZodObject<{
      type: z.ZodLiteral<"object">;
      properties: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodType<JSONValue, unknown, z.core.$ZodTypeInternals<JSONValue, unknown>>>>;
      required: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$catchall<z.ZodUnknown>>;
    outputSchema: z.ZodOptional<z.ZodObject<{
      type: z.ZodLiteral<"object">;
      properties: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodType<JSONValue, unknown, z.core.$ZodTypeInternals<JSONValue, unknown>>>>;
      required: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$catchall<z.ZodUnknown>>>;
    annotations: z.ZodOptional<z.ZodObject<{
      title: z.ZodOptional<z.ZodString>;
      readOnlyHint: z.ZodOptional<z.ZodBoolean>;
      destructiveHint: z.ZodOptional<z.ZodBoolean>;
      idempotentHint: z.ZodOptional<z.ZodBoolean>;
      openWorldHint: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    execution: z.ZodOptional<z.ZodObject<{
      taskSupport: z.ZodOptional<z.ZodEnum<{
        optional: "optional";
        required: "required";
        forbidden: "forbidden";
      }>>;
    }, z.core.$strip>>;
    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
      src: z.ZodString;
      mimeType: z.ZodOptional<z.ZodString>;
      sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
      theme: z.ZodOptional<z.ZodEnum<{
        light: "light";
        dark: "dark";
      }>>;
    }, z.core.$strip>>>;
    name: z.ZodString;
    title: z.ZodOptional<z.ZodString>;
  }, z.core.$strip>>;
}, z.core.$loose>;
/**
 * The server's response to a tool call.
 */
declare const CallToolResultSchema: z.ZodObject<{
  _meta: z.ZodOptional<z.ZodObject<{
    /**
     * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
     */
    progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
    /**
     * If specified, this request is related to the provided task.
     */
    "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
      taskId: z.ZodString;
    }, z.core.$strip>>;
  }, z.core.$loose>>;
  content: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
    type: z.ZodLiteral<"text">;
    text: z.ZodString;
    annotations: z.ZodOptional<z.ZodObject<{
      audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        user: "user";
        assistant: "assistant";
      }>>>;
      priority: z.ZodOptional<z.ZodNumber>;
      lastModified: z.ZodOptional<z.ZodISODateTime>;
    }, z.core.$strip>>;
    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
  }, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"image">;
    data: z.ZodString;
    mimeType: z.ZodString;
    annotations: z.ZodOptional<z.ZodObject<{
      audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        user: "user";
        assistant: "assistant";
      }>>>;
      priority: z.ZodOptional<z.ZodNumber>;
      lastModified: z.ZodOptional<z.ZodISODateTime>;
    }, z.core.$strip>>;
    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
  }, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"audio">;
    data: z.ZodString;
    mimeType: z.ZodString;
    annotations: z.ZodOptional<z.ZodObject<{
      audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        user: "user";
        assistant: "assistant";
      }>>>;
      priority: z.ZodOptional<z.ZodNumber>;
      lastModified: z.ZodOptional<z.ZodISODateTime>;
    }, z.core.$strip>>;
    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
  }, z.core.$strip>, z.ZodObject<{
    uri: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    mimeType: z.ZodOptional<z.ZodString>;
    size: z.ZodOptional<z.ZodNumber>;
    annotations: z.ZodOptional<z.ZodObject<{
      audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        user: "user";
        assistant: "assistant";
      }>>>;
      priority: z.ZodOptional<z.ZodNumber>;
      lastModified: z.ZodOptional<z.ZodISODateTime>;
    }, z.core.$strip>>;
    _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
    icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
      src: z.ZodString;
      mimeType: z.ZodOptional<z.ZodString>;
      sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
      theme: z.ZodOptional<z.ZodEnum<{
        light: "light";
        dark: "dark";
      }>>;
    }, z.core.$strip>>>;
    name: z.ZodString;
    title: z.ZodOptional<z.ZodString>;
    type: z.ZodLiteral<"resource_link">;
  }, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"resource">;
    resource: z.ZodUnion<readonly [z.ZodObject<{
      uri: z.ZodString;
      mimeType: z.ZodOptional<z.ZodString>;
      _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
      text: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
      uri: z.ZodString;
      mimeType: z.ZodOptional<z.ZodString>;
      _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
      blob: z.ZodString;
    }, z.core.$strip>]>;
    annotations: z.ZodOptional<z.ZodObject<{
      audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        user: "user";
        assistant: "assistant";
      }>>>;
      priority: z.ZodOptional<z.ZodNumber>;
      lastModified: z.ZodOptional<z.ZodISODateTime>;
    }, z.core.$strip>>;
    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
  }, z.core.$strip>]>>>;
  structuredContent: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
  isError: z.ZodOptional<z.ZodBoolean>;
}, z.core.$loose>;
/**
 * The severity of a log message.
 */
declare const LoggingLevelSchema: z.ZodEnum<{
  error: "error";
  debug: "debug";
  info: "info";
  notice: "notice";
  warning: "warning";
  critical: "critical";
  alert: "alert";
  emergency: "emergency";
}>;
/**
 * Notification of a log message passed from server to client. If no `logging/setLevel` request has been sent from the client, the server MAY decide which messages to send automatically.
 */
declare const LoggingMessageNotificationSchema: z.ZodObject<{
  method: z.ZodLiteral<"notifications/message">;
  params: z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
    level: z.ZodEnum<{
      error: "error";
      debug: "debug";
      info: "info";
      notice: "notice";
      warning: "warning";
      critical: "critical";
      alert: "alert";
      emergency: "emergency";
    }>;
    logger: z.ZodOptional<z.ZodString>;
    data: z.ZodUnknown;
  }, z.core.$strip>;
}, z.core.$strip>;
/**
 * Parameters for a `sampling/createMessage` request.
 */
declare const CreateMessageRequestParamsSchema: z.ZodObject<{
  _meta: z.ZodOptional<z.ZodObject<{
    /**
     * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
     */
    progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
    /**
     * If specified, this request is related to the provided task.
     */
    "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
      taskId: z.ZodString;
    }, z.core.$strip>>;
  }, z.core.$loose>>;
  task: z.ZodOptional<z.ZodObject<{
    ttl: z.ZodOptional<z.ZodNumber>;
  }, z.core.$strip>>;
  messages: z.ZodArray<z.ZodObject<{
    role: z.ZodEnum<{
      user: "user";
      assistant: "assistant";
    }>;
    content: z.ZodUnion<readonly [z.ZodDiscriminatedUnion<[z.ZodObject<{
      type: z.ZodLiteral<"text">;
      text: z.ZodString;
      annotations: z.ZodOptional<z.ZodObject<{
        audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
          user: "user";
          assistant: "assistant";
        }>>>;
        priority: z.ZodOptional<z.ZodNumber>;
        lastModified: z.ZodOptional<z.ZodISODateTime>;
      }, z.core.$strip>>;
      _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
      type: z.ZodLiteral<"image">;
      data: z.ZodString;
      mimeType: z.ZodString;
      annotations: z.ZodOptional<z.ZodObject<{
        audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
          user: "user";
          assistant: "assistant";
        }>>>;
        priority: z.ZodOptional<z.ZodNumber>;
        lastModified: z.ZodOptional<z.ZodISODateTime>;
      }, z.core.$strip>>;
      _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
      type: z.ZodLiteral<"audio">;
      data: z.ZodString;
      mimeType: z.ZodString;
      annotations: z.ZodOptional<z.ZodObject<{
        audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
          user: "user";
          assistant: "assistant";
        }>>>;
        priority: z.ZodOptional<z.ZodNumber>;
        lastModified: z.ZodOptional<z.ZodISODateTime>;
      }, z.core.$strip>>;
      _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
      type: z.ZodLiteral<"tool_use">;
      name: z.ZodString;
      id: z.ZodString;
      input: z.ZodRecord<z.ZodString, z.ZodUnknown>;
      _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
      type: z.ZodLiteral<"tool_result">;
      toolUseId: z.ZodString;
      content: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
        type: z.ZodLiteral<"text">;
        text: z.ZodString;
        annotations: z.ZodOptional<z.ZodObject<{
          audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
            user: "user";
            assistant: "assistant";
          }>>>;
          priority: z.ZodOptional<z.ZodNumber>;
          lastModified: z.ZodOptional<z.ZodISODateTime>;
        }, z.core.$strip>>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
      }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"image">;
        data: z.ZodString;
        mimeType: z.ZodString;
        annotations: z.ZodOptional<z.ZodObject<{
          audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
            user: "user";
            assistant: "assistant";
          }>>>;
          priority: z.ZodOptional<z.ZodNumber>;
          lastModified: z.ZodOptional<z.ZodISODateTime>;
        }, z.core.$strip>>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
      }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"audio">;
        data: z.ZodString;
        mimeType: z.ZodString;
        annotations: z.ZodOptional<z.ZodObject<{
          audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
            user: "user";
            assistant: "assistant";
          }>>>;
          priority: z.ZodOptional<z.ZodNumber>;
          lastModified: z.ZodOptional<z.ZodISODateTime>;
        }, z.core.$strip>>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
      }, z.core.$strip>, z.ZodObject<{
        uri: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        mimeType: z.ZodOptional<z.ZodString>;
        size: z.ZodOptional<z.ZodNumber>;
        annotations: z.ZodOptional<z.ZodObject<{
          audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
            user: "user";
            assistant: "assistant";
          }>>>;
          priority: z.ZodOptional<z.ZodNumber>;
          lastModified: z.ZodOptional<z.ZodISODateTime>;
        }, z.core.$strip>>;
        _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
        icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
          src: z.ZodString;
          mimeType: z.ZodOptional<z.ZodString>;
          sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
          theme: z.ZodOptional<z.ZodEnum<{
            light: "light";
            dark: "dark";
          }>>;
        }, z.core.$strip>>>;
        name: z.ZodString;
        title: z.ZodOptional<z.ZodString>;
        type: z.ZodLiteral<"resource_link">;
      }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"resource">;
        resource: z.ZodUnion<readonly [z.ZodObject<{
          uri: z.ZodString;
          mimeType: z.ZodOptional<z.ZodString>;
          _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
          text: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
          uri: z.ZodString;
          mimeType: z.ZodOptional<z.ZodString>;
          _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
          blob: z.ZodString;
        }, z.core.$strip>]>;
        annotations: z.ZodOptional<z.ZodObject<{
          audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
            user: "user";
            assistant: "assistant";
          }>>>;
          priority: z.ZodOptional<z.ZodNumber>;
          lastModified: z.ZodOptional<z.ZodISODateTime>;
        }, z.core.$strip>>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
      }, z.core.$strip>]>>>;
      structuredContent: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
      isError: z.ZodOptional<z.ZodBoolean>;
      _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>], "type">, z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
      type: z.ZodLiteral<"text">;
      text: z.ZodString;
      annotations: z.ZodOptional<z.ZodObject<{
        audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
          user: "user";
          assistant: "assistant";
        }>>>;
        priority: z.ZodOptional<z.ZodNumber>;
        lastModified: z.ZodOptional<z.ZodISODateTime>;
      }, z.core.$strip>>;
      _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
      type: z.ZodLiteral<"image">;
      data: z.ZodString;
      mimeType: z.ZodString;
      annotations: z.ZodOptional<z.ZodObject<{
        audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
          user: "user";
          assistant: "assistant";
        }>>>;
        priority: z.ZodOptional<z.ZodNumber>;
        lastModified: z.ZodOptional<z.ZodISODateTime>;
      }, z.core.$strip>>;
      _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
      type: z.ZodLiteral<"audio">;
      data: z.ZodString;
      mimeType: z.ZodString;
      annotations: z.ZodOptional<z.ZodObject<{
        audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
          user: "user";
          assistant: "assistant";
        }>>>;
        priority: z.ZodOptional<z.ZodNumber>;
        lastModified: z.ZodOptional<z.ZodISODateTime>;
      }, z.core.$strip>>;
      _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
      type: z.ZodLiteral<"tool_use">;
      name: z.ZodString;
      id: z.ZodString;
      input: z.ZodRecord<z.ZodString, z.ZodUnknown>;
      _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
      type: z.ZodLiteral<"tool_result">;
      toolUseId: z.ZodString;
      content: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
        type: z.ZodLiteral<"text">;
        text: z.ZodString;
        annotations: z.ZodOptional<z.ZodObject<{
          audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
            user: "user";
            assistant: "assistant";
          }>>>;
          priority: z.ZodOptional<z.ZodNumber>;
          lastModified: z.ZodOptional<z.ZodISODateTime>;
        }, z.core.$strip>>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
      }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"image">;
        data: z.ZodString;
        mimeType: z.ZodString;
        annotations: z.ZodOptional<z.ZodObject<{
          audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
            user: "user";
            assistant: "assistant";
          }>>>;
          priority: z.ZodOptional<z.ZodNumber>;
          lastModified: z.ZodOptional<z.ZodISODateTime>;
        }, z.core.$strip>>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
      }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"audio">;
        data: z.ZodString;
        mimeType: z.ZodString;
        annotations: z.ZodOptional<z.ZodObject<{
          audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
            user: "user";
            assistant: "assistant";
          }>>>;
          priority: z.ZodOptional<z.ZodNumber>;
          lastModified: z.ZodOptional<z.ZodISODateTime>;
        }, z.core.$strip>>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
      }, z.core.$strip>, z.ZodObject<{
        uri: z.ZodString;
        description: z.ZodOptional<z.ZodString>;
        mimeType: z.ZodOptional<z.ZodString>;
        size: z.ZodOptional<z.ZodNumber>;
        annotations: z.ZodOptional<z.ZodObject<{
          audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
            user: "user";
            assistant: "assistant";
          }>>>;
          priority: z.ZodOptional<z.ZodNumber>;
          lastModified: z.ZodOptional<z.ZodISODateTime>;
        }, z.core.$strip>>;
        _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
        icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
          src: z.ZodString;
          mimeType: z.ZodOptional<z.ZodString>;
          sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
          theme: z.ZodOptional<z.ZodEnum<{
            light: "light";
            dark: "dark";
          }>>;
        }, z.core.$strip>>>;
        name: z.ZodString;
        title: z.ZodOptional<z.ZodString>;
        type: z.ZodLiteral<"resource_link">;
      }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"resource">;
        resource: z.ZodUnion<readonly [z.ZodObject<{
          uri: z.ZodString;
          mimeType: z.ZodOptional<z.ZodString>;
          _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
          text: z.ZodString;
        }, z.core.$strip>, z.ZodObject<{
          uri: z.ZodString;
          mimeType: z.ZodOptional<z.ZodString>;
          _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
          blob: z.ZodString;
        }, z.core.$strip>]>;
        annotations: z.ZodOptional<z.ZodObject<{
          audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
            user: "user";
            assistant: "assistant";
          }>>>;
          priority: z.ZodOptional<z.ZodNumber>;
          lastModified: z.ZodOptional<z.ZodISODateTime>;
        }, z.core.$strip>>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
      }, z.core.$strip>]>>>;
      structuredContent: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
      isError: z.ZodOptional<z.ZodBoolean>;
      _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>], "type">>]>;
    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
  }, z.core.$strip>>;
  modelPreferences: z.ZodOptional<z.ZodObject<{
    hints: z.ZodOptional<z.ZodArray<z.ZodObject<{
      name: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
    costPriority: z.ZodOptional<z.ZodNumber>;
    speedPriority: z.ZodOptional<z.ZodNumber>;
    intelligencePriority: z.ZodOptional<z.ZodNumber>;
  }, z.core.$strip>>;
  systemPrompt: z.ZodOptional<z.ZodString>;
  includeContext: z.ZodOptional<z.ZodEnum<{
    none: "none";
    thisServer: "thisServer";
    allServers: "allServers";
  }>>;
  temperature: z.ZodOptional<z.ZodNumber>;
  maxTokens: z.ZodNumber;
  stopSequences: z.ZodOptional<z.ZodArray<z.ZodString>>;
  metadata: z.ZodOptional<z.ZodType<JSONObject, unknown, z.core.$ZodTypeInternals<JSONObject, unknown>>>;
  tools: z.ZodOptional<z.ZodArray<z.ZodObject<{
    description: z.ZodOptional<z.ZodString>;
    inputSchema: z.ZodObject<{
      type: z.ZodLiteral<"object">;
      properties: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodType<JSONValue, unknown, z.core.$ZodTypeInternals<JSONValue, unknown>>>>;
      required: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$catchall<z.ZodUnknown>>;
    outputSchema: z.ZodOptional<z.ZodObject<{
      type: z.ZodLiteral<"object">;
      properties: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodType<JSONValue, unknown, z.core.$ZodTypeInternals<JSONValue, unknown>>>>;
      required: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$catchall<z.ZodUnknown>>>;
    annotations: z.ZodOptional<z.ZodObject<{
      title: z.ZodOptional<z.ZodString>;
      readOnlyHint: z.ZodOptional<z.ZodBoolean>;
      destructiveHint: z.ZodOptional<z.ZodBoolean>;
      idempotentHint: z.ZodOptional<z.ZodBoolean>;
      openWorldHint: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>>;
    execution: z.ZodOptional<z.ZodObject<{
      taskSupport: z.ZodOptional<z.ZodEnum<{
        optional: "optional";
        required: "required";
        forbidden: "forbidden";
      }>>;
    }, z.core.$strip>>;
    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
      src: z.ZodString;
      mimeType: z.ZodOptional<z.ZodString>;
      sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
      theme: z.ZodOptional<z.ZodEnum<{
        light: "light";
        dark: "dark";
      }>>;
    }, z.core.$strip>>>;
    name: z.ZodString;
    title: z.ZodOptional<z.ZodString>;
  }, z.core.$strip>>>;
  toolChoice: z.ZodOptional<z.ZodObject<{
    mode: z.ZodOptional<z.ZodEnum<{
      required: "required";
      auto: "auto";
      none: "none";
    }>>;
  }, z.core.$strip>>;
}, z.core.$strip>;
/**
 * A request from the server to sample an LLM via the client. The client has full discretion over which model to select. The client should also inform the user before beginning sampling, to allow them to inspect the request (human in the loop) and decide whether to approve it.
 */
declare const CreateMessageRequestSchema: z.ZodObject<{
  method: z.ZodLiteral<"sampling/createMessage">;
  params: z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
    task: z.ZodOptional<z.ZodObject<{
      ttl: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    messages: z.ZodArray<z.ZodObject<{
      role: z.ZodEnum<{
        user: "user";
        assistant: "assistant";
      }>;
      content: z.ZodUnion<readonly [z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"text">;
        text: z.ZodString;
        annotations: z.ZodOptional<z.ZodObject<{
          audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
            user: "user";
            assistant: "assistant";
          }>>>;
          priority: z.ZodOptional<z.ZodNumber>;
          lastModified: z.ZodOptional<z.ZodISODateTime>;
        }, z.core.$strip>>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
      }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"image">;
        data: z.ZodString;
        mimeType: z.ZodString;
        annotations: z.ZodOptional<z.ZodObject<{
          audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
            user: "user";
            assistant: "assistant";
          }>>>;
          priority: z.ZodOptional<z.ZodNumber>;
          lastModified: z.ZodOptional<z.ZodISODateTime>;
        }, z.core.$strip>>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
      }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"audio">;
        data: z.ZodString;
        mimeType: z.ZodString;
        annotations: z.ZodOptional<z.ZodObject<{
          audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
            user: "user";
            assistant: "assistant";
          }>>>;
          priority: z.ZodOptional<z.ZodNumber>;
          lastModified: z.ZodOptional<z.ZodISODateTime>;
        }, z.core.$strip>>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
      }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"tool_use">;
        name: z.ZodString;
        id: z.ZodString;
        input: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
      }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"tool_result">;
        toolUseId: z.ZodString;
        content: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
          type: z.ZodLiteral<"text">;
          text: z.ZodString;
          annotations: z.ZodOptional<z.ZodObject<{
            audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
              user: "user";
              assistant: "assistant";
            }>>>;
            priority: z.ZodOptional<z.ZodNumber>;
            lastModified: z.ZodOptional<z.ZodISODateTime>;
          }, z.core.$strip>>;
          _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>, z.ZodObject<{
          type: z.ZodLiteral<"image">;
          data: z.ZodString;
          mimeType: z.ZodString;
          annotations: z.ZodOptional<z.ZodObject<{
            audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
              user: "user";
              assistant: "assistant";
            }>>>;
            priority: z.ZodOptional<z.ZodNumber>;
            lastModified: z.ZodOptional<z.ZodISODateTime>;
          }, z.core.$strip>>;
          _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>, z.ZodObject<{
          type: z.ZodLiteral<"audio">;
          data: z.ZodString;
          mimeType: z.ZodString;
          annotations: z.ZodOptional<z.ZodObject<{
            audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
              user: "user";
              assistant: "assistant";
            }>>>;
            priority: z.ZodOptional<z.ZodNumber>;
            lastModified: z.ZodOptional<z.ZodISODateTime>;
          }, z.core.$strip>>;
          _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>, z.ZodObject<{
          uri: z.ZodString;
          description: z.ZodOptional<z.ZodString>;
          mimeType: z.ZodOptional<z.ZodString>;
          size: z.ZodOptional<z.ZodNumber>;
          annotations: z.ZodOptional<z.ZodObject<{
            audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
              user: "user";
              assistant: "assistant";
            }>>>;
            priority: z.ZodOptional<z.ZodNumber>;
            lastModified: z.ZodOptional<z.ZodISODateTime>;
          }, z.core.$strip>>;
          _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
          icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
            src: z.ZodString;
            mimeType: z.ZodOptional<z.ZodString>;
            sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
            theme: z.ZodOptional<z.ZodEnum<{
              light: "light";
              dark: "dark";
            }>>;
          }, z.core.$strip>>>;
          name: z.ZodString;
          title: z.ZodOptional<z.ZodString>;
          type: z.ZodLiteral<"resource_link">;
        }, z.core.$strip>, z.ZodObject<{
          type: z.ZodLiteral<"resource">;
          resource: z.ZodUnion<readonly [z.ZodObject<{
            uri: z.ZodString;
            mimeType: z.ZodOptional<z.ZodString>;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            text: z.ZodString;
          }, z.core.$strip>, z.ZodObject<{
            uri: z.ZodString;
            mimeType: z.ZodOptional<z.ZodString>;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            blob: z.ZodString;
          }, z.core.$strip>]>;
          annotations: z.ZodOptional<z.ZodObject<{
            audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
              user: "user";
              assistant: "assistant";
            }>>>;
            priority: z.ZodOptional<z.ZodNumber>;
            lastModified: z.ZodOptional<z.ZodISODateTime>;
          }, z.core.$strip>>;
          _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>]>>>;
        structuredContent: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
        isError: z.ZodOptional<z.ZodBoolean>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
      }, z.core.$strip>], "type">, z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"text">;
        text: z.ZodString;
        annotations: z.ZodOptional<z.ZodObject<{
          audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
            user: "user";
            assistant: "assistant";
          }>>>;
          priority: z.ZodOptional<z.ZodNumber>;
          lastModified: z.ZodOptional<z.ZodISODateTime>;
        }, z.core.$strip>>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
      }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"image">;
        data: z.ZodString;
        mimeType: z.ZodString;
        annotations: z.ZodOptional<z.ZodObject<{
          audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
            user: "user";
            assistant: "assistant";
          }>>>;
          priority: z.ZodOptional<z.ZodNumber>;
          lastModified: z.ZodOptional<z.ZodISODateTime>;
        }, z.core.$strip>>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
      }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"audio">;
        data: z.ZodString;
        mimeType: z.ZodString;
        annotations: z.ZodOptional<z.ZodObject<{
          audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
            user: "user";
            assistant: "assistant";
          }>>>;
          priority: z.ZodOptional<z.ZodNumber>;
          lastModified: z.ZodOptional<z.ZodISODateTime>;
        }, z.core.$strip>>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
      }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"tool_use">;
        name: z.ZodString;
        id: z.ZodString;
        input: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
      }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"tool_result">;
        toolUseId: z.ZodString;
        content: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
          type: z.ZodLiteral<"text">;
          text: z.ZodString;
          annotations: z.ZodOptional<z.ZodObject<{
            audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
              user: "user";
              assistant: "assistant";
            }>>>;
            priority: z.ZodOptional<z.ZodNumber>;
            lastModified: z.ZodOptional<z.ZodISODateTime>;
          }, z.core.$strip>>;
          _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>, z.ZodObject<{
          type: z.ZodLiteral<"image">;
          data: z.ZodString;
          mimeType: z.ZodString;
          annotations: z.ZodOptional<z.ZodObject<{
            audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
              user: "user";
              assistant: "assistant";
            }>>>;
            priority: z.ZodOptional<z.ZodNumber>;
            lastModified: z.ZodOptional<z.ZodISODateTime>;
          }, z.core.$strip>>;
          _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>, z.ZodObject<{
          type: z.ZodLiteral<"audio">;
          data: z.ZodString;
          mimeType: z.ZodString;
          annotations: z.ZodOptional<z.ZodObject<{
            audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
              user: "user";
              assistant: "assistant";
            }>>>;
            priority: z.ZodOptional<z.ZodNumber>;
            lastModified: z.ZodOptional<z.ZodISODateTime>;
          }, z.core.$strip>>;
          _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>, z.ZodObject<{
          uri: z.ZodString;
          description: z.ZodOptional<z.ZodString>;
          mimeType: z.ZodOptional<z.ZodString>;
          size: z.ZodOptional<z.ZodNumber>;
          annotations: z.ZodOptional<z.ZodObject<{
            audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
              user: "user";
              assistant: "assistant";
            }>>>;
            priority: z.ZodOptional<z.ZodNumber>;
            lastModified: z.ZodOptional<z.ZodISODateTime>;
          }, z.core.$strip>>;
          _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
          icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
            src: z.ZodString;
            mimeType: z.ZodOptional<z.ZodString>;
            sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
            theme: z.ZodOptional<z.ZodEnum<{
              light: "light";
              dark: "dark";
            }>>;
          }, z.core.$strip>>>;
          name: z.ZodString;
          title: z.ZodOptional<z.ZodString>;
          type: z.ZodLiteral<"resource_link">;
        }, z.core.$strip>, z.ZodObject<{
          type: z.ZodLiteral<"resource">;
          resource: z.ZodUnion<readonly [z.ZodObject<{
            uri: z.ZodString;
            mimeType: z.ZodOptional<z.ZodString>;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            text: z.ZodString;
          }, z.core.$strip>, z.ZodObject<{
            uri: z.ZodString;
            mimeType: z.ZodOptional<z.ZodString>;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            blob: z.ZodString;
          }, z.core.$strip>]>;
          annotations: z.ZodOptional<z.ZodObject<{
            audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
              user: "user";
              assistant: "assistant";
            }>>>;
            priority: z.ZodOptional<z.ZodNumber>;
            lastModified: z.ZodOptional<z.ZodISODateTime>;
          }, z.core.$strip>>;
          _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>]>>>;
        structuredContent: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
        isError: z.ZodOptional<z.ZodBoolean>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
      }, z.core.$strip>], "type">>]>;
      _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>>;
    modelPreferences: z.ZodOptional<z.ZodObject<{
      hints: z.ZodOptional<z.ZodArray<z.ZodObject<{
        name: z.ZodOptional<z.ZodString>;
      }, z.core.$strip>>>;
      costPriority: z.ZodOptional<z.ZodNumber>;
      speedPriority: z.ZodOptional<z.ZodNumber>;
      intelligencePriority: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    systemPrompt: z.ZodOptional<z.ZodString>;
    includeContext: z.ZodOptional<z.ZodEnum<{
      none: "none";
      thisServer: "thisServer";
      allServers: "allServers";
    }>>;
    temperature: z.ZodOptional<z.ZodNumber>;
    maxTokens: z.ZodNumber;
    stopSequences: z.ZodOptional<z.ZodArray<z.ZodString>>;
    metadata: z.ZodOptional<z.ZodType<JSONObject, unknown, z.core.$ZodTypeInternals<JSONObject, unknown>>>;
    tools: z.ZodOptional<z.ZodArray<z.ZodObject<{
      description: z.ZodOptional<z.ZodString>;
      inputSchema: z.ZodObject<{
        type: z.ZodLiteral<"object">;
        properties: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodType<JSONValue, unknown, z.core.$ZodTypeInternals<JSONValue, unknown>>>>;
        required: z.ZodOptional<z.ZodArray<z.ZodString>>;
      }, z.core.$catchall<z.ZodUnknown>>;
      outputSchema: z.ZodOptional<z.ZodObject<{
        type: z.ZodLiteral<"object">;
        properties: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodType<JSONValue, unknown, z.core.$ZodTypeInternals<JSONValue, unknown>>>>;
        required: z.ZodOptional<z.ZodArray<z.ZodString>>;
      }, z.core.$catchall<z.ZodUnknown>>>;
      annotations: z.ZodOptional<z.ZodObject<{
        title: z.ZodOptional<z.ZodString>;
        readOnlyHint: z.ZodOptional<z.ZodBoolean>;
        destructiveHint: z.ZodOptional<z.ZodBoolean>;
        idempotentHint: z.ZodOptional<z.ZodBoolean>;
        openWorldHint: z.ZodOptional<z.ZodBoolean>;
      }, z.core.$strip>>;
      execution: z.ZodOptional<z.ZodObject<{
        taskSupport: z.ZodOptional<z.ZodEnum<{
          optional: "optional";
          required: "required";
          forbidden: "forbidden";
        }>>;
      }, z.core.$strip>>;
      _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
      icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
        src: z.ZodString;
        mimeType: z.ZodOptional<z.ZodString>;
        sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
        theme: z.ZodOptional<z.ZodEnum<{
          light: "light";
          dark: "dark";
        }>>;
      }, z.core.$strip>>>;
      name: z.ZodString;
      title: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
    toolChoice: z.ZodOptional<z.ZodObject<{
      mode: z.ZodOptional<z.ZodEnum<{
        required: "required";
        auto: "auto";
        none: "none";
      }>>;
    }, z.core.$strip>>;
  }, z.core.$strip>;
}, z.core.$strip>;
/**
 * The client's response to a `sampling/create_message` request from the server.
 * This is the backwards-compatible version that returns single content (no arrays).
 * Used when the request does not include tools.
 */
declare const CreateMessageResultSchema: z.ZodObject<{
  _meta: z.ZodOptional<z.ZodObject<{
    /**
     * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
     */
    progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
    /**
     * If specified, this request is related to the provided task.
     */
    "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
      taskId: z.ZodString;
    }, z.core.$strip>>;
  }, z.core.$loose>>;
  model: z.ZodString;
  stopReason: z.ZodOptional<z.ZodUnion<[z.ZodEnum<{
    maxTokens: "maxTokens";
    endTurn: "endTurn";
    stopSequence: "stopSequence";
  }>, z.ZodString]>>;
  role: z.ZodEnum<{
    user: "user";
    assistant: "assistant";
  }>;
  content: z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"text">;
    text: z.ZodString;
    annotations: z.ZodOptional<z.ZodObject<{
      audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        user: "user";
        assistant: "assistant";
      }>>>;
      priority: z.ZodOptional<z.ZodNumber>;
      lastModified: z.ZodOptional<z.ZodISODateTime>;
    }, z.core.$strip>>;
    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
  }, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"image">;
    data: z.ZodString;
    mimeType: z.ZodString;
    annotations: z.ZodOptional<z.ZodObject<{
      audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        user: "user";
        assistant: "assistant";
      }>>>;
      priority: z.ZodOptional<z.ZodNumber>;
      lastModified: z.ZodOptional<z.ZodISODateTime>;
    }, z.core.$strip>>;
    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
  }, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"audio">;
    data: z.ZodString;
    mimeType: z.ZodString;
    annotations: z.ZodOptional<z.ZodObject<{
      audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        user: "user";
        assistant: "assistant";
      }>>>;
      priority: z.ZodOptional<z.ZodNumber>;
      lastModified: z.ZodOptional<z.ZodISODateTime>;
    }, z.core.$strip>>;
    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
  }, z.core.$strip>], "type">;
}, z.core.$loose>;
/**
 * The client's response to a `sampling/create_message` request when tools were provided.
 * This version supports array content for tool use flows.
 */
declare const CreateMessageResultWithToolsSchema: z.ZodObject<{
  _meta: z.ZodOptional<z.ZodObject<{
    /**
     * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
     */
    progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
    /**
     * If specified, this request is related to the provided task.
     */
    "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
      taskId: z.ZodString;
    }, z.core.$strip>>;
  }, z.core.$loose>>;
  model: z.ZodString;
  stopReason: z.ZodOptional<z.ZodUnion<[z.ZodEnum<{
    maxTokens: "maxTokens";
    endTurn: "endTurn";
    stopSequence: "stopSequence";
    toolUse: "toolUse";
  }>, z.ZodString]>>;
  role: z.ZodEnum<{
    user: "user";
    assistant: "assistant";
  }>;
  content: z.ZodUnion<readonly [z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"text">;
    text: z.ZodString;
    annotations: z.ZodOptional<z.ZodObject<{
      audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        user: "user";
        assistant: "assistant";
      }>>>;
      priority: z.ZodOptional<z.ZodNumber>;
      lastModified: z.ZodOptional<z.ZodISODateTime>;
    }, z.core.$strip>>;
    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
  }, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"image">;
    data: z.ZodString;
    mimeType: z.ZodString;
    annotations: z.ZodOptional<z.ZodObject<{
      audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        user: "user";
        assistant: "assistant";
      }>>>;
      priority: z.ZodOptional<z.ZodNumber>;
      lastModified: z.ZodOptional<z.ZodISODateTime>;
    }, z.core.$strip>>;
    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
  }, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"audio">;
    data: z.ZodString;
    mimeType: z.ZodString;
    annotations: z.ZodOptional<z.ZodObject<{
      audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        user: "user";
        assistant: "assistant";
      }>>>;
      priority: z.ZodOptional<z.ZodNumber>;
      lastModified: z.ZodOptional<z.ZodISODateTime>;
    }, z.core.$strip>>;
    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
  }, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"tool_use">;
    name: z.ZodString;
    id: z.ZodString;
    input: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
  }, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"tool_result">;
    toolUseId: z.ZodString;
    content: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
      type: z.ZodLiteral<"text">;
      text: z.ZodString;
      annotations: z.ZodOptional<z.ZodObject<{
        audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
          user: "user";
          assistant: "assistant";
        }>>>;
        priority: z.ZodOptional<z.ZodNumber>;
        lastModified: z.ZodOptional<z.ZodISODateTime>;
      }, z.core.$strip>>;
      _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
      type: z.ZodLiteral<"image">;
      data: z.ZodString;
      mimeType: z.ZodString;
      annotations: z.ZodOptional<z.ZodObject<{
        audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
          user: "user";
          assistant: "assistant";
        }>>>;
        priority: z.ZodOptional<z.ZodNumber>;
        lastModified: z.ZodOptional<z.ZodISODateTime>;
      }, z.core.$strip>>;
      _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
      type: z.ZodLiteral<"audio">;
      data: z.ZodString;
      mimeType: z.ZodString;
      annotations: z.ZodOptional<z.ZodObject<{
        audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
          user: "user";
          assistant: "assistant";
        }>>>;
        priority: z.ZodOptional<z.ZodNumber>;
        lastModified: z.ZodOptional<z.ZodISODateTime>;
      }, z.core.$strip>>;
      _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
      uri: z.ZodString;
      description: z.ZodOptional<z.ZodString>;
      mimeType: z.ZodOptional<z.ZodString>;
      size: z.ZodOptional<z.ZodNumber>;
      annotations: z.ZodOptional<z.ZodObject<{
        audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
          user: "user";
          assistant: "assistant";
        }>>>;
        priority: z.ZodOptional<z.ZodNumber>;
        lastModified: z.ZodOptional<z.ZodISODateTime>;
      }, z.core.$strip>>;
      _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
      icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
        src: z.ZodString;
        mimeType: z.ZodOptional<z.ZodString>;
        sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
        theme: z.ZodOptional<z.ZodEnum<{
          light: "light";
          dark: "dark";
        }>>;
      }, z.core.$strip>>>;
      name: z.ZodString;
      title: z.ZodOptional<z.ZodString>;
      type: z.ZodLiteral<"resource_link">;
    }, z.core.$strip>, z.ZodObject<{
      type: z.ZodLiteral<"resource">;
      resource: z.ZodUnion<readonly [z.ZodObject<{
        uri: z.ZodString;
        mimeType: z.ZodOptional<z.ZodString>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        text: z.ZodString;
      }, z.core.$strip>, z.ZodObject<{
        uri: z.ZodString;
        mimeType: z.ZodOptional<z.ZodString>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        blob: z.ZodString;
      }, z.core.$strip>]>;
      annotations: z.ZodOptional<z.ZodObject<{
        audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
          user: "user";
          assistant: "assistant";
        }>>>;
        priority: z.ZodOptional<z.ZodNumber>;
        lastModified: z.ZodOptional<z.ZodISODateTime>;
      }, z.core.$strip>>;
      _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>]>>>;
    structuredContent: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
    isError: z.ZodOptional<z.ZodBoolean>;
    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
  }, z.core.$strip>], "type">, z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
    type: z.ZodLiteral<"text">;
    text: z.ZodString;
    annotations: z.ZodOptional<z.ZodObject<{
      audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        user: "user";
        assistant: "assistant";
      }>>>;
      priority: z.ZodOptional<z.ZodNumber>;
      lastModified: z.ZodOptional<z.ZodISODateTime>;
    }, z.core.$strip>>;
    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
  }, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"image">;
    data: z.ZodString;
    mimeType: z.ZodString;
    annotations: z.ZodOptional<z.ZodObject<{
      audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        user: "user";
        assistant: "assistant";
      }>>>;
      priority: z.ZodOptional<z.ZodNumber>;
      lastModified: z.ZodOptional<z.ZodISODateTime>;
    }, z.core.$strip>>;
    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
  }, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"audio">;
    data: z.ZodString;
    mimeType: z.ZodString;
    annotations: z.ZodOptional<z.ZodObject<{
      audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        user: "user";
        assistant: "assistant";
      }>>>;
      priority: z.ZodOptional<z.ZodNumber>;
      lastModified: z.ZodOptional<z.ZodISODateTime>;
    }, z.core.$strip>>;
    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
  }, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"tool_use">;
    name: z.ZodString;
    id: z.ZodString;
    input: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
  }, z.core.$strip>, z.ZodObject<{
    type: z.ZodLiteral<"tool_result">;
    toolUseId: z.ZodString;
    content: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
      type: z.ZodLiteral<"text">;
      text: z.ZodString;
      annotations: z.ZodOptional<z.ZodObject<{
        audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
          user: "user";
          assistant: "assistant";
        }>>>;
        priority: z.ZodOptional<z.ZodNumber>;
        lastModified: z.ZodOptional<z.ZodISODateTime>;
      }, z.core.$strip>>;
      _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
      type: z.ZodLiteral<"image">;
      data: z.ZodString;
      mimeType: z.ZodString;
      annotations: z.ZodOptional<z.ZodObject<{
        audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
          user: "user";
          assistant: "assistant";
        }>>>;
        priority: z.ZodOptional<z.ZodNumber>;
        lastModified: z.ZodOptional<z.ZodISODateTime>;
      }, z.core.$strip>>;
      _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
      type: z.ZodLiteral<"audio">;
      data: z.ZodString;
      mimeType: z.ZodString;
      annotations: z.ZodOptional<z.ZodObject<{
        audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
          user: "user";
          assistant: "assistant";
        }>>>;
        priority: z.ZodOptional<z.ZodNumber>;
        lastModified: z.ZodOptional<z.ZodISODateTime>;
      }, z.core.$strip>>;
      _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>, z.ZodObject<{
      uri: z.ZodString;
      description: z.ZodOptional<z.ZodString>;
      mimeType: z.ZodOptional<z.ZodString>;
      size: z.ZodOptional<z.ZodNumber>;
      annotations: z.ZodOptional<z.ZodObject<{
        audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
          user: "user";
          assistant: "assistant";
        }>>>;
        priority: z.ZodOptional<z.ZodNumber>;
        lastModified: z.ZodOptional<z.ZodISODateTime>;
      }, z.core.$strip>>;
      _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
      icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
        src: z.ZodString;
        mimeType: z.ZodOptional<z.ZodString>;
        sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
        theme: z.ZodOptional<z.ZodEnum<{
          light: "light";
          dark: "dark";
        }>>;
      }, z.core.$strip>>>;
      name: z.ZodString;
      title: z.ZodOptional<z.ZodString>;
      type: z.ZodLiteral<"resource_link">;
    }, z.core.$strip>, z.ZodObject<{
      type: z.ZodLiteral<"resource">;
      resource: z.ZodUnion<readonly [z.ZodObject<{
        uri: z.ZodString;
        mimeType: z.ZodOptional<z.ZodString>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        text: z.ZodString;
      }, z.core.$strip>, z.ZodObject<{
        uri: z.ZodString;
        mimeType: z.ZodOptional<z.ZodString>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        blob: z.ZodString;
      }, z.core.$strip>]>;
      annotations: z.ZodOptional<z.ZodObject<{
        audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
          user: "user";
          assistant: "assistant";
        }>>>;
        priority: z.ZodOptional<z.ZodNumber>;
        lastModified: z.ZodOptional<z.ZodISODateTime>;
      }, z.core.$strip>>;
      _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>]>>>;
    structuredContent: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
    isError: z.ZodOptional<z.ZodBoolean>;
    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
  }, z.core.$strip>], "type">>]>;
}, z.core.$loose>;
/**
 * Parameters for an `elicitation/create` request for form-based elicitation.
 */
declare const ElicitRequestFormParamsSchema: z.ZodObject<{
  _meta: z.ZodOptional<z.ZodObject<{
    /**
     * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
     */
    progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
    /**
     * If specified, this request is related to the provided task.
     */
    "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
      taskId: z.ZodString;
    }, z.core.$strip>>;
  }, z.core.$loose>>;
  task: z.ZodOptional<z.ZodObject<{
    ttl: z.ZodOptional<z.ZodNumber>;
  }, z.core.$strip>>;
  mode: z.ZodOptional<z.ZodLiteral<"form">>;
  message: z.ZodString;
  requestedSchema: z.ZodObject<{
    type: z.ZodLiteral<"object">;
    properties: z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodUnion<readonly [z.ZodObject<{
      type: z.ZodLiteral<"string">;
      title: z.ZodOptional<z.ZodString>;
      description: z.ZodOptional<z.ZodString>;
      enum: z.ZodArray<z.ZodString>;
      enumNames: z.ZodOptional<z.ZodArray<z.ZodString>>;
      default: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>, z.ZodUnion<readonly [z.ZodObject<{
      type: z.ZodLiteral<"string">;
      title: z.ZodOptional<z.ZodString>;
      description: z.ZodOptional<z.ZodString>;
      enum: z.ZodArray<z.ZodString>;
      default: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>, z.ZodObject<{
      type: z.ZodLiteral<"string">;
      title: z.ZodOptional<z.ZodString>;
      description: z.ZodOptional<z.ZodString>;
      oneOf: z.ZodArray<z.ZodObject<{
        const: z.ZodString;
        title: z.ZodString;
      }, z.core.$strip>>;
      default: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>]>, z.ZodUnion<readonly [z.ZodObject<{
      type: z.ZodLiteral<"array">;
      title: z.ZodOptional<z.ZodString>;
      description: z.ZodOptional<z.ZodString>;
      minItems: z.ZodOptional<z.ZodNumber>;
      maxItems: z.ZodOptional<z.ZodNumber>;
      items: z.ZodObject<{
        type: z.ZodLiteral<"string">;
        enum: z.ZodArray<z.ZodString>;
      }, z.core.$strip>;
      default: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>, z.ZodObject<{
      type: z.ZodLiteral<"array">;
      title: z.ZodOptional<z.ZodString>;
      description: z.ZodOptional<z.ZodString>;
      minItems: z.ZodOptional<z.ZodNumber>;
      maxItems: z.ZodOptional<z.ZodNumber>;
      items: z.ZodObject<{
        anyOf: z.ZodArray<z.ZodObject<{
          const: z.ZodString;
          title: z.ZodString;
        }, z.core.$strip>>;
      }, z.core.$strip>;
      default: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>]>]>, z.ZodObject<{
      type: z.ZodLiteral<"boolean">;
      title: z.ZodOptional<z.ZodString>;
      description: z.ZodOptional<z.ZodString>;
      default: z.ZodOptional<z.ZodBoolean>;
    }, z.core.$strip>, z.ZodObject<{
      type: z.ZodLiteral<"string">;
      title: z.ZodOptional<z.ZodString>;
      description: z.ZodOptional<z.ZodString>;
      minLength: z.ZodOptional<z.ZodNumber>;
      maxLength: z.ZodOptional<z.ZodNumber>;
      format: z.ZodOptional<z.ZodEnum<{
        email: "email";
        date: "date";
        uri: "uri";
        "date-time": "date-time";
      }>>;
      default: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>, z.ZodObject<{
      type: z.ZodEnum<{
        number: "number";
        integer: "integer";
      }>;
      title: z.ZodOptional<z.ZodString>;
      description: z.ZodOptional<z.ZodString>;
      minimum: z.ZodOptional<z.ZodNumber>;
      maximum: z.ZodOptional<z.ZodNumber>;
      default: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>]>>;
    required: z.ZodOptional<z.ZodArray<z.ZodString>>;
  }, z.core.$strip>;
}, z.core.$strip>;
/**
 * Parameters for an {@linkcode ElicitRequest | elicitation/create} request for URL-based elicitation.
 */
declare const ElicitRequestURLParamsSchema: z.ZodObject<{
  _meta: z.ZodOptional<z.ZodObject<{
    /**
     * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
     */
    progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
    /**
     * If specified, this request is related to the provided task.
     */
    "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
      taskId: z.ZodString;
    }, z.core.$strip>>;
  }, z.core.$loose>>;
  task: z.ZodOptional<z.ZodObject<{
    ttl: z.ZodOptional<z.ZodNumber>;
  }, z.core.$strip>>;
  mode: z.ZodLiteral<"url">;
  message: z.ZodString;
  elicitationId: z.ZodString;
  url: z.ZodString;
}, z.core.$strip>;
/**
 * The client's response to an {@linkcode ElicitRequest | elicitation/create} request from the server.
 */
declare const ElicitResultSchema: z.ZodObject<{
  _meta: z.ZodOptional<z.ZodObject<{
    /**
     * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
     */
    progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
    /**
     * If specified, this request is related to the provided task.
     */
    "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
      taskId: z.ZodString;
    }, z.core.$strip>>;
  }, z.core.$loose>>;
  action: z.ZodEnum<{
    cancel: "cancel";
    accept: "accept";
    decline: "decline";
  }>;
  content: z.ZodPipe<z.ZodTransform<{} | undefined, unknown>, z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodArray<z.ZodString>]>>>>;
}, z.core.$loose>;
/**
 * The server's response to a {@linkcode CompleteRequest | completion/complete} request
 */
declare const CompleteResultSchema: z.ZodObject<{
  _meta: z.ZodOptional<z.ZodObject<{
    /**
     * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
     */
    progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
    /**
     * If specified, this request is related to the provided task.
     */
    "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
      taskId: z.ZodString;
    }, z.core.$strip>>;
  }, z.core.$loose>>;
  completion: z.ZodObject<{
    /**
     * An array of completion values. Must not exceed 100 items.
     */
    values: z.ZodArray<z.ZodString>;
    /**
     * The total number of completion options available. This can exceed the number of values actually sent in the response.
     */
    total: z.ZodOptional<z.ZodNumber>;
    /**
     * Indicates whether there are additional completion options beyond those provided in the current response, even if the exact total is unknown.
     */
    hasMore: z.ZodOptional<z.ZodBoolean>;
  }, z.core.$loose>;
}, z.core.$loose>;
/**
 * Sent from the server to request a list of root URIs from the client.
 */
declare const ListRootsRequestSchema: z.ZodObject<{
  method: z.ZodLiteral<"roots/list">;
  params: z.ZodOptional<z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
  }, z.core.$strip>>;
}, z.core.$strip>;
/**
 * The client's response to a `roots/list` request from the server.
 */
declare const ListRootsResultSchema: z.ZodObject<{
  _meta: z.ZodOptional<z.ZodObject<{
    /**
     * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
     */
    progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
    /**
     * If specified, this request is related to the provided task.
     */
    "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
      taskId: z.ZodString;
    }, z.core.$strip>>;
  }, z.core.$loose>>;
  roots: z.ZodArray<z.ZodObject<{
    uri: z.ZodString;
    name: z.ZodOptional<z.ZodString>;
    _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
  }, z.core.$strip>>;
}, z.core.$loose>;
declare const ClientRequestSchema: z.ZodUnion<readonly [z.ZodObject<{
  method: z.ZodLiteral<"ping">;
  params: z.ZodOptional<z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
  }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
  method: z.ZodLiteral<"initialize">;
  params: z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
    protocolVersion: z.ZodString;
    capabilities: z.ZodObject<{
      experimental: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodType<JSONObject, unknown, z.core.$ZodTypeInternals<JSONObject, unknown>>>>;
      sampling: z.ZodOptional<z.ZodObject<{
        context: z.ZodOptional<z.ZodType<JSONObject, unknown, z.core.$ZodTypeInternals<JSONObject, unknown>>>;
        tools: z.ZodOptional<z.ZodType<JSONObject, unknown, z.core.$ZodTypeInternals<JSONObject, unknown>>>;
      }, z.core.$strip>>;
      elicitation: z.ZodOptional<z.ZodPipe<z.ZodTransform<unknown, unknown>, z.ZodIntersection<z.ZodObject<{
        form: z.ZodOptional<z.ZodIntersection<z.ZodObject<{
          applyDefaults: z.ZodOptional<z.ZodBoolean>;
        }, z.core.$strip>, z.ZodType<JSONObject, unknown, z.core.$ZodTypeInternals<JSONObject, unknown>>>>;
        url: z.ZodOptional<z.ZodType<JSONObject, unknown, z.core.$ZodTypeInternals<JSONObject, unknown>>>;
      }, z.core.$strip>, z.ZodOptional<z.ZodType<JSONObject, unknown, z.core.$ZodTypeInternals<JSONObject, unknown>>>>>>;
      roots: z.ZodOptional<z.ZodObject<{
        listChanged: z.ZodOptional<z.ZodBoolean>;
      }, z.core.$strip>>;
      tasks: z.ZodOptional<z.ZodObject<{
        /**
         * Present if the client supports listing tasks.
         */
        list: z.ZodOptional<z.ZodType<JSONObject, unknown, z.core.$ZodTypeInternals<JSONObject, unknown>>>;
        /**
         * Present if the client supports cancelling tasks.
         */
        cancel: z.ZodOptional<z.ZodType<JSONObject, unknown, z.core.$ZodTypeInternals<JSONObject, unknown>>>;
        /**
         * Capabilities for task creation on specific request types.
         */
        requests: z.ZodOptional<z.ZodObject<{
          /**
           * Task support for sampling requests.
           */
          sampling: z.ZodOptional<z.ZodObject<{
            createMessage: z.ZodOptional<z.ZodType<JSONObject, unknown, z.core.$ZodTypeInternals<JSONObject, unknown>>>;
          }, z.core.$loose>>;
          /**
           * Task support for elicitation requests.
           */
          elicitation: z.ZodOptional<z.ZodObject<{
            create: z.ZodOptional<z.ZodType<JSONObject, unknown, z.core.$ZodTypeInternals<JSONObject, unknown>>>;
          }, z.core.$loose>>;
        }, z.core.$loose>>;
      }, z.core.$loose>>;
      extensions: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodType<JSONObject, unknown, z.core.$ZodTypeInternals<JSONObject, unknown>>>>;
    }, z.core.$strip>;
    clientInfo: z.ZodObject<{
      version: z.ZodString;
      websiteUrl: z.ZodOptional<z.ZodString>;
      description: z.ZodOptional<z.ZodString>;
      icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
        src: z.ZodString;
        mimeType: z.ZodOptional<z.ZodString>;
        sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
        theme: z.ZodOptional<z.ZodEnum<{
          light: "light";
          dark: "dark";
        }>>;
      }, z.core.$strip>>>;
      name: z.ZodString;
      title: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>;
  }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
  method: z.ZodLiteral<"completion/complete">;
  params: z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
    ref: z.ZodUnion<readonly [z.ZodObject<{
      type: z.ZodLiteral<"ref/prompt">;
      name: z.ZodString;
    }, z.core.$strip>, z.ZodObject<{
      type: z.ZodLiteral<"ref/resource">;
      uri: z.ZodString;
    }, z.core.$strip>]>;
    argument: z.ZodObject<{
      name: z.ZodString;
      value: z.ZodString;
    }, z.core.$strip>;
    context: z.ZodOptional<z.ZodObject<{
      arguments: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    }, z.core.$strip>>;
  }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
  method: z.ZodLiteral<"logging/setLevel">;
  params: z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
    level: z.ZodEnum<{
      error: "error";
      debug: "debug";
      info: "info";
      notice: "notice";
      warning: "warning";
      critical: "critical";
      alert: "alert";
      emergency: "emergency";
    }>;
  }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
  method: z.ZodLiteral<"prompts/get">;
  params: z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
    name: z.ZodString;
    arguments: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
  }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
  params: z.ZodOptional<z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
    cursor: z.ZodOptional<z.ZodString>;
  }, z.core.$strip>>;
  method: z.ZodLiteral<"prompts/list">;
}, z.core.$strip>, z.ZodObject<{
  params: z.ZodOptional<z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
    cursor: z.ZodOptional<z.ZodString>;
  }, z.core.$strip>>;
  method: z.ZodLiteral<"resources/list">;
}, z.core.$strip>, z.ZodObject<{
  params: z.ZodOptional<z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
    cursor: z.ZodOptional<z.ZodString>;
  }, z.core.$strip>>;
  method: z.ZodLiteral<"resources/templates/list">;
}, z.core.$strip>, z.ZodObject<{
  method: z.ZodLiteral<"resources/read">;
  params: z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
    uri: z.ZodString;
  }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
  method: z.ZodLiteral<"resources/subscribe">;
  params: z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
    uri: z.ZodString;
  }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
  method: z.ZodLiteral<"resources/unsubscribe">;
  params: z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
    uri: z.ZodString;
  }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
  method: z.ZodLiteral<"tools/call">;
  params: z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
    task: z.ZodOptional<z.ZodObject<{
      ttl: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    name: z.ZodString;
    arguments: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
  }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
  params: z.ZodOptional<z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
    cursor: z.ZodOptional<z.ZodString>;
  }, z.core.$strip>>;
  method: z.ZodLiteral<"tools/list">;
}, z.core.$strip>, z.ZodObject<{
  method: z.ZodLiteral<"tasks/get">;
  params: z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
    taskId: z.ZodString;
  }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
  method: z.ZodLiteral<"tasks/result">;
  params: z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
    taskId: z.ZodString;
  }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
  params: z.ZodOptional<z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
    cursor: z.ZodOptional<z.ZodString>;
  }, z.core.$strip>>;
  method: z.ZodLiteral<"tasks/list">;
}, z.core.$strip>, z.ZodObject<{
  method: z.ZodLiteral<"tasks/cancel">;
  params: z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
    taskId: z.ZodString;
  }, z.core.$strip>;
}, z.core.$strip>]>;
declare const ClientNotificationSchema: z.ZodUnion<readonly [z.ZodObject<{
  method: z.ZodLiteral<"notifications/cancelled">;
  params: z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
    requestId: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
    reason: z.ZodOptional<z.ZodString>;
  }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
  method: z.ZodLiteral<"notifications/progress">;
  params: z.ZodObject<{
    progressToken: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
    progress: z.ZodNumber;
    total: z.ZodOptional<z.ZodNumber>;
    message: z.ZodOptional<z.ZodString>;
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
  }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
  method: z.ZodLiteral<"notifications/initialized">;
  params: z.ZodOptional<z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
  }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
  method: z.ZodLiteral<"notifications/roots/list_changed">;
  params: z.ZodOptional<z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
  }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
  method: z.ZodLiteral<"notifications/tasks/status">;
  params: z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
    taskId: z.ZodString;
    status: z.ZodEnum<{
      working: "working";
      input_required: "input_required";
      completed: "completed";
      failed: "failed";
      cancelled: "cancelled";
    }>;
    ttl: z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>;
    createdAt: z.ZodString;
    lastUpdatedAt: z.ZodString;
    pollInterval: z.ZodOptional<z.ZodNumber>;
    statusMessage: z.ZodOptional<z.ZodString>;
  }, z.core.$strip>;
}, z.core.$strip>]>;
declare const ServerRequestSchema: z.ZodUnion<readonly [z.ZodObject<{
  method: z.ZodLiteral<"ping">;
  params: z.ZodOptional<z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
  }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
  method: z.ZodLiteral<"sampling/createMessage">;
  params: z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
    task: z.ZodOptional<z.ZodObject<{
      ttl: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    messages: z.ZodArray<z.ZodObject<{
      role: z.ZodEnum<{
        user: "user";
        assistant: "assistant";
      }>;
      content: z.ZodUnion<readonly [z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"text">;
        text: z.ZodString;
        annotations: z.ZodOptional<z.ZodObject<{
          audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
            user: "user";
            assistant: "assistant";
          }>>>;
          priority: z.ZodOptional<z.ZodNumber>;
          lastModified: z.ZodOptional<z.ZodISODateTime>;
        }, z.core.$strip>>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
      }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"image">;
        data: z.ZodString;
        mimeType: z.ZodString;
        annotations: z.ZodOptional<z.ZodObject<{
          audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
            user: "user";
            assistant: "assistant";
          }>>>;
          priority: z.ZodOptional<z.ZodNumber>;
          lastModified: z.ZodOptional<z.ZodISODateTime>;
        }, z.core.$strip>>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
      }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"audio">;
        data: z.ZodString;
        mimeType: z.ZodString;
        annotations: z.ZodOptional<z.ZodObject<{
          audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
            user: "user";
            assistant: "assistant";
          }>>>;
          priority: z.ZodOptional<z.ZodNumber>;
          lastModified: z.ZodOptional<z.ZodISODateTime>;
        }, z.core.$strip>>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
      }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"tool_use">;
        name: z.ZodString;
        id: z.ZodString;
        input: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
      }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"tool_result">;
        toolUseId: z.ZodString;
        content: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
          type: z.ZodLiteral<"text">;
          text: z.ZodString;
          annotations: z.ZodOptional<z.ZodObject<{
            audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
              user: "user";
              assistant: "assistant";
            }>>>;
            priority: z.ZodOptional<z.ZodNumber>;
            lastModified: z.ZodOptional<z.ZodISODateTime>;
          }, z.core.$strip>>;
          _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>, z.ZodObject<{
          type: z.ZodLiteral<"image">;
          data: z.ZodString;
          mimeType: z.ZodString;
          annotations: z.ZodOptional<z.ZodObject<{
            audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
              user: "user";
              assistant: "assistant";
            }>>>;
            priority: z.ZodOptional<z.ZodNumber>;
            lastModified: z.ZodOptional<z.ZodISODateTime>;
          }, z.core.$strip>>;
          _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>, z.ZodObject<{
          type: z.ZodLiteral<"audio">;
          data: z.ZodString;
          mimeType: z.ZodString;
          annotations: z.ZodOptional<z.ZodObject<{
            audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
              user: "user";
              assistant: "assistant";
            }>>>;
            priority: z.ZodOptional<z.ZodNumber>;
            lastModified: z.ZodOptional<z.ZodISODateTime>;
          }, z.core.$strip>>;
          _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>, z.ZodObject<{
          uri: z.ZodString;
          description: z.ZodOptional<z.ZodString>;
          mimeType: z.ZodOptional<z.ZodString>;
          size: z.ZodOptional<z.ZodNumber>;
          annotations: z.ZodOptional<z.ZodObject<{
            audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
              user: "user";
              assistant: "assistant";
            }>>>;
            priority: z.ZodOptional<z.ZodNumber>;
            lastModified: z.ZodOptional<z.ZodISODateTime>;
          }, z.core.$strip>>;
          _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
          icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
            src: z.ZodString;
            mimeType: z.ZodOptional<z.ZodString>;
            sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
            theme: z.ZodOptional<z.ZodEnum<{
              light: "light";
              dark: "dark";
            }>>;
          }, z.core.$strip>>>;
          name: z.ZodString;
          title: z.ZodOptional<z.ZodString>;
          type: z.ZodLiteral<"resource_link">;
        }, z.core.$strip>, z.ZodObject<{
          type: z.ZodLiteral<"resource">;
          resource: z.ZodUnion<readonly [z.ZodObject<{
            uri: z.ZodString;
            mimeType: z.ZodOptional<z.ZodString>;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            text: z.ZodString;
          }, z.core.$strip>, z.ZodObject<{
            uri: z.ZodString;
            mimeType: z.ZodOptional<z.ZodString>;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            blob: z.ZodString;
          }, z.core.$strip>]>;
          annotations: z.ZodOptional<z.ZodObject<{
            audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
              user: "user";
              assistant: "assistant";
            }>>>;
            priority: z.ZodOptional<z.ZodNumber>;
            lastModified: z.ZodOptional<z.ZodISODateTime>;
          }, z.core.$strip>>;
          _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>]>>>;
        structuredContent: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
        isError: z.ZodOptional<z.ZodBoolean>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
      }, z.core.$strip>], "type">, z.ZodArray<z.ZodDiscriminatedUnion<[z.ZodObject<{
        type: z.ZodLiteral<"text">;
        text: z.ZodString;
        annotations: z.ZodOptional<z.ZodObject<{
          audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
            user: "user";
            assistant: "assistant";
          }>>>;
          priority: z.ZodOptional<z.ZodNumber>;
          lastModified: z.ZodOptional<z.ZodISODateTime>;
        }, z.core.$strip>>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
      }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"image">;
        data: z.ZodString;
        mimeType: z.ZodString;
        annotations: z.ZodOptional<z.ZodObject<{
          audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
            user: "user";
            assistant: "assistant";
          }>>>;
          priority: z.ZodOptional<z.ZodNumber>;
          lastModified: z.ZodOptional<z.ZodISODateTime>;
        }, z.core.$strip>>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
      }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"audio">;
        data: z.ZodString;
        mimeType: z.ZodString;
        annotations: z.ZodOptional<z.ZodObject<{
          audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
            user: "user";
            assistant: "assistant";
          }>>>;
          priority: z.ZodOptional<z.ZodNumber>;
          lastModified: z.ZodOptional<z.ZodISODateTime>;
        }, z.core.$strip>>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
      }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"tool_use">;
        name: z.ZodString;
        id: z.ZodString;
        input: z.ZodRecord<z.ZodString, z.ZodUnknown>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
      }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"tool_result">;
        toolUseId: z.ZodString;
        content: z.ZodDefault<z.ZodArray<z.ZodUnion<readonly [z.ZodObject<{
          type: z.ZodLiteral<"text">;
          text: z.ZodString;
          annotations: z.ZodOptional<z.ZodObject<{
            audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
              user: "user";
              assistant: "assistant";
            }>>>;
            priority: z.ZodOptional<z.ZodNumber>;
            lastModified: z.ZodOptional<z.ZodISODateTime>;
          }, z.core.$strip>>;
          _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>, z.ZodObject<{
          type: z.ZodLiteral<"image">;
          data: z.ZodString;
          mimeType: z.ZodString;
          annotations: z.ZodOptional<z.ZodObject<{
            audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
              user: "user";
              assistant: "assistant";
            }>>>;
            priority: z.ZodOptional<z.ZodNumber>;
            lastModified: z.ZodOptional<z.ZodISODateTime>;
          }, z.core.$strip>>;
          _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>, z.ZodObject<{
          type: z.ZodLiteral<"audio">;
          data: z.ZodString;
          mimeType: z.ZodString;
          annotations: z.ZodOptional<z.ZodObject<{
            audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
              user: "user";
              assistant: "assistant";
            }>>>;
            priority: z.ZodOptional<z.ZodNumber>;
            lastModified: z.ZodOptional<z.ZodISODateTime>;
          }, z.core.$strip>>;
          _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>, z.ZodObject<{
          uri: z.ZodString;
          description: z.ZodOptional<z.ZodString>;
          mimeType: z.ZodOptional<z.ZodString>;
          size: z.ZodOptional<z.ZodNumber>;
          annotations: z.ZodOptional<z.ZodObject<{
            audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
              user: "user";
              assistant: "assistant";
            }>>>;
            priority: z.ZodOptional<z.ZodNumber>;
            lastModified: z.ZodOptional<z.ZodISODateTime>;
          }, z.core.$strip>>;
          _meta: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
          icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
            src: z.ZodString;
            mimeType: z.ZodOptional<z.ZodString>;
            sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
            theme: z.ZodOptional<z.ZodEnum<{
              light: "light";
              dark: "dark";
            }>>;
          }, z.core.$strip>>>;
          name: z.ZodString;
          title: z.ZodOptional<z.ZodString>;
          type: z.ZodLiteral<"resource_link">;
        }, z.core.$strip>, z.ZodObject<{
          type: z.ZodLiteral<"resource">;
          resource: z.ZodUnion<readonly [z.ZodObject<{
            uri: z.ZodString;
            mimeType: z.ZodOptional<z.ZodString>;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            text: z.ZodString;
          }, z.core.$strip>, z.ZodObject<{
            uri: z.ZodString;
            mimeType: z.ZodOptional<z.ZodString>;
            _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            blob: z.ZodString;
          }, z.core.$strip>]>;
          annotations: z.ZodOptional<z.ZodObject<{
            audience: z.ZodOptional<z.ZodArray<z.ZodEnum<{
              user: "user";
              assistant: "assistant";
            }>>>;
            priority: z.ZodOptional<z.ZodNumber>;
            lastModified: z.ZodOptional<z.ZodISODateTime>;
          }, z.core.$strip>>;
          _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
        }, z.core.$strip>]>>>;
        structuredContent: z.ZodOptional<z.ZodObject<{}, z.core.$loose>>;
        isError: z.ZodOptional<z.ZodBoolean>;
        _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
      }, z.core.$strip>], "type">>]>;
      _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, z.core.$strip>>;
    modelPreferences: z.ZodOptional<z.ZodObject<{
      hints: z.ZodOptional<z.ZodArray<z.ZodObject<{
        name: z.ZodOptional<z.ZodString>;
      }, z.core.$strip>>>;
      costPriority: z.ZodOptional<z.ZodNumber>;
      speedPriority: z.ZodOptional<z.ZodNumber>;
      intelligencePriority: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    systemPrompt: z.ZodOptional<z.ZodString>;
    includeContext: z.ZodOptional<z.ZodEnum<{
      none: "none";
      thisServer: "thisServer";
      allServers: "allServers";
    }>>;
    temperature: z.ZodOptional<z.ZodNumber>;
    maxTokens: z.ZodNumber;
    stopSequences: z.ZodOptional<z.ZodArray<z.ZodString>>;
    metadata: z.ZodOptional<z.ZodType<JSONObject, unknown, z.core.$ZodTypeInternals<JSONObject, unknown>>>;
    tools: z.ZodOptional<z.ZodArray<z.ZodObject<{
      description: z.ZodOptional<z.ZodString>;
      inputSchema: z.ZodObject<{
        type: z.ZodLiteral<"object">;
        properties: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodType<JSONValue, unknown, z.core.$ZodTypeInternals<JSONValue, unknown>>>>;
        required: z.ZodOptional<z.ZodArray<z.ZodString>>;
      }, z.core.$catchall<z.ZodUnknown>>;
      outputSchema: z.ZodOptional<z.ZodObject<{
        type: z.ZodLiteral<"object">;
        properties: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodType<JSONValue, unknown, z.core.$ZodTypeInternals<JSONValue, unknown>>>>;
        required: z.ZodOptional<z.ZodArray<z.ZodString>>;
      }, z.core.$catchall<z.ZodUnknown>>>;
      annotations: z.ZodOptional<z.ZodObject<{
        title: z.ZodOptional<z.ZodString>;
        readOnlyHint: z.ZodOptional<z.ZodBoolean>;
        destructiveHint: z.ZodOptional<z.ZodBoolean>;
        idempotentHint: z.ZodOptional<z.ZodBoolean>;
        openWorldHint: z.ZodOptional<z.ZodBoolean>;
      }, z.core.$strip>>;
      execution: z.ZodOptional<z.ZodObject<{
        taskSupport: z.ZodOptional<z.ZodEnum<{
          optional: "optional";
          required: "required";
          forbidden: "forbidden";
        }>>;
      }, z.core.$strip>>;
      _meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
      icons: z.ZodOptional<z.ZodArray<z.ZodObject<{
        src: z.ZodString;
        mimeType: z.ZodOptional<z.ZodString>;
        sizes: z.ZodOptional<z.ZodArray<z.ZodString>>;
        theme: z.ZodOptional<z.ZodEnum<{
          light: "light";
          dark: "dark";
        }>>;
      }, z.core.$strip>>>;
      name: z.ZodString;
      title: z.ZodOptional<z.ZodString>;
    }, z.core.$strip>>>;
    toolChoice: z.ZodOptional<z.ZodObject<{
      mode: z.ZodOptional<z.ZodEnum<{
        required: "required";
        auto: "auto";
        none: "none";
      }>>;
    }, z.core.$strip>>;
  }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
  method: z.ZodLiteral<"elicitation/create">;
  params: z.ZodUnion<readonly [z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
    task: z.ZodOptional<z.ZodObject<{
      ttl: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    mode: z.ZodOptional<z.ZodLiteral<"form">>;
    message: z.ZodString;
    requestedSchema: z.ZodObject<{
      type: z.ZodLiteral<"object">;
      properties: z.ZodRecord<z.ZodString, z.ZodUnion<readonly [z.ZodUnion<readonly [z.ZodObject<{
        type: z.ZodLiteral<"string">;
        title: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        enum: z.ZodArray<z.ZodString>;
        enumNames: z.ZodOptional<z.ZodArray<z.ZodString>>;
        default: z.ZodOptional<z.ZodString>;
      }, z.core.$strip>, z.ZodUnion<readonly [z.ZodObject<{
        type: z.ZodLiteral<"string">;
        title: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        enum: z.ZodArray<z.ZodString>;
        default: z.ZodOptional<z.ZodString>;
      }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"string">;
        title: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        oneOf: z.ZodArray<z.ZodObject<{
          const: z.ZodString;
          title: z.ZodString;
        }, z.core.$strip>>;
        default: z.ZodOptional<z.ZodString>;
      }, z.core.$strip>]>, z.ZodUnion<readonly [z.ZodObject<{
        type: z.ZodLiteral<"array">;
        title: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        minItems: z.ZodOptional<z.ZodNumber>;
        maxItems: z.ZodOptional<z.ZodNumber>;
        items: z.ZodObject<{
          type: z.ZodLiteral<"string">;
          enum: z.ZodArray<z.ZodString>;
        }, z.core.$strip>;
        default: z.ZodOptional<z.ZodArray<z.ZodString>>;
      }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"array">;
        title: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        minItems: z.ZodOptional<z.ZodNumber>;
        maxItems: z.ZodOptional<z.ZodNumber>;
        items: z.ZodObject<{
          anyOf: z.ZodArray<z.ZodObject<{
            const: z.ZodString;
            title: z.ZodString;
          }, z.core.$strip>>;
        }, z.core.$strip>;
        default: z.ZodOptional<z.ZodArray<z.ZodString>>;
      }, z.core.$strip>]>]>, z.ZodObject<{
        type: z.ZodLiteral<"boolean">;
        title: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        default: z.ZodOptional<z.ZodBoolean>;
      }, z.core.$strip>, z.ZodObject<{
        type: z.ZodLiteral<"string">;
        title: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        minLength: z.ZodOptional<z.ZodNumber>;
        maxLength: z.ZodOptional<z.ZodNumber>;
        format: z.ZodOptional<z.ZodEnum<{
          email: "email";
          date: "date";
          uri: "uri";
          "date-time": "date-time";
        }>>;
        default: z.ZodOptional<z.ZodString>;
      }, z.core.$strip>, z.ZodObject<{
        type: z.ZodEnum<{
          number: "number";
          integer: "integer";
        }>;
        title: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        minimum: z.ZodOptional<z.ZodNumber>;
        maximum: z.ZodOptional<z.ZodNumber>;
        default: z.ZodOptional<z.ZodNumber>;
      }, z.core.$strip>]>>;
      required: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$strip>;
  }, z.core.$strip>, z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
    task: z.ZodOptional<z.ZodObject<{
      ttl: z.ZodOptional<z.ZodNumber>;
    }, z.core.$strip>>;
    mode: z.ZodLiteral<"url">;
    message: z.ZodString;
    elicitationId: z.ZodString;
    url: z.ZodString;
  }, z.core.$strip>]>;
}, z.core.$strip>, z.ZodObject<{
  method: z.ZodLiteral<"roots/list">;
  params: z.ZodOptional<z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
  }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
  method: z.ZodLiteral<"tasks/get">;
  params: z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
    taskId: z.ZodString;
  }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
  method: z.ZodLiteral<"tasks/result">;
  params: z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
    taskId: z.ZodString;
  }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
  params: z.ZodOptional<z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
    cursor: z.ZodOptional<z.ZodString>;
  }, z.core.$strip>>;
  method: z.ZodLiteral<"tasks/list">;
}, z.core.$strip>, z.ZodObject<{
  method: z.ZodLiteral<"tasks/cancel">;
  params: z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
    taskId: z.ZodString;
  }, z.core.$strip>;
}, z.core.$strip>]>;
declare const ServerNotificationSchema: z.ZodUnion<readonly [z.ZodObject<{
  method: z.ZodLiteral<"notifications/cancelled">;
  params: z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
    requestId: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
    reason: z.ZodOptional<z.ZodString>;
  }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
  method: z.ZodLiteral<"notifications/progress">;
  params: z.ZodObject<{
    progressToken: z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>;
    progress: z.ZodNumber;
    total: z.ZodOptional<z.ZodNumber>;
    message: z.ZodOptional<z.ZodString>;
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
  }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
  method: z.ZodLiteral<"notifications/message">;
  params: z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
    level: z.ZodEnum<{
      error: "error";
      debug: "debug";
      info: "info";
      notice: "notice";
      warning: "warning";
      critical: "critical";
      alert: "alert";
      emergency: "emergency";
    }>;
    logger: z.ZodOptional<z.ZodString>;
    data: z.ZodUnknown;
  }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
  method: z.ZodLiteral<"notifications/resources/updated">;
  params: z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
    uri: z.ZodString;
  }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
  method: z.ZodLiteral<"notifications/resources/list_changed">;
  params: z.ZodOptional<z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
  }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
  method: z.ZodLiteral<"notifications/tools/list_changed">;
  params: z.ZodOptional<z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
  }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
  method: z.ZodLiteral<"notifications/prompts/list_changed">;
  params: z.ZodOptional<z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
  }, z.core.$strip>>;
}, z.core.$strip>, z.ZodObject<{
  method: z.ZodLiteral<"notifications/tasks/status">;
  params: z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
    taskId: z.ZodString;
    status: z.ZodEnum<{
      working: "working";
      input_required: "input_required";
      completed: "completed";
      failed: "failed";
      cancelled: "cancelled";
    }>;
    ttl: z.ZodUnion<readonly [z.ZodNumber, z.ZodNull]>;
    createdAt: z.ZodString;
    lastUpdatedAt: z.ZodString;
    pollInterval: z.ZodOptional<z.ZodNumber>;
    statusMessage: z.ZodOptional<z.ZodString>;
  }, z.core.$strip>;
}, z.core.$strip>, z.ZodObject<{
  method: z.ZodLiteral<"notifications/elicitation/complete">;
  params: z.ZodObject<{
    _meta: z.ZodOptional<z.ZodObject<{
      /**
       * If specified, the caller is requesting out-of-band progress notifications for this request (as represented by notifications/progress). The value of this parameter is an opaque token that will be attached to any subsequent notifications. The receiver is not obligated to provide these notifications.
       */
      progressToken: z.ZodOptional<z.ZodUnion<readonly [z.ZodString, z.ZodNumber]>>;
      /**
       * If specified, this request is related to the provided task.
       */
      "io.modelcontextprotocol/related-task": z.ZodOptional<z.ZodObject<{
        taskId: z.ZodString;
      }, z.core.$strip>>;
    }, z.core.$loose>>;
    elicitationId: z.ZodString;
  }, z.core.$strip>;
}, z.core.$strip>]>;
//#endregion
//#region ../core/src/types/types.d.ts
type JSONValue = string | number | boolean | null | JSONObject | JSONArray;
type JSONObject = {
  [key: string]: JSONValue;
};
type JSONArray = JSONValue[];
type Primitive = string | number | boolean | bigint | null | undefined;
type Flatten<T$1> = T$1 extends Primitive ? T$1 : T$1 extends Array<infer U> ? Array<Flatten<U>> : T$1 extends Set<infer U> ? Set<Flatten<U>> : T$1 extends Map<infer K, infer V> ? Map<Flatten<K>, Flatten<V>> : T$1 extends object ? { [K in keyof T$1]: Flatten<T$1[K]> } : T$1;
type Infer<Schema extends z.ZodTypeAny> = Flatten<z.infer<Schema>>;
type Request = Infer<typeof RequestSchema>;
type RequestMeta = Infer<typeof RequestMetaSchema>;
type Notification = Infer<typeof NotificationSchema>;
type Result$1 = Infer<typeof ResultSchema>;
type RequestId = Infer<typeof RequestIdSchema>;
type JSONRPCRequest = Infer<typeof JSONRPCRequestSchema>;
type JSONRPCNotification = Infer<typeof JSONRPCNotificationSchema>;
type JSONRPCResponse = Infer<typeof JSONRPCResponseSchema>;
type JSONRPCErrorResponse = Infer<typeof JSONRPCErrorResponseSchema>;
type JSONRPCResultResponse = Infer<typeof JSONRPCResultResponseSchema>;
type JSONRPCMessage = Infer<typeof JSONRPCMessageSchema>;
type EmptyResult = Infer<typeof EmptyResultSchema>;
type Implementation = Infer<typeof ImplementationSchema>;
type ClientCapabilities = Infer<typeof ClientCapabilitiesSchema>;
type ServerCapabilities = Infer<typeof ServerCapabilitiesSchema>;
type InitializeResult = Infer<typeof InitializeResultSchema>;
type Progress = Infer<typeof ProgressSchema>;
type Task = Infer<typeof TaskSchema>;
type TaskCreationParams = Infer<typeof TaskCreationParamsSchema>;
type RelatedTaskMetadata = Infer<typeof RelatedTaskMetadataSchema>;
type CreateTaskResult = Infer<typeof CreateTaskResultSchema>;
type GetTaskRequest = Infer<typeof GetTaskRequestSchema>;
type GetTaskResult = Infer<typeof GetTaskResultSchema>;
type GetTaskPayloadRequest = Infer<typeof GetTaskPayloadRequestSchema>;
type ListTasksResult = Infer<typeof ListTasksResultSchema>;
type CancelTaskResult = Infer<typeof CancelTaskResultSchema>;
type GetTaskPayloadResult = Infer<typeof GetTaskPayloadResultSchema>;
type Resource = Infer<typeof ResourceSchema>;
type ListResourcesResult = Infer<typeof ListResourcesResultSchema>;
type ListResourceTemplatesResult = Infer<typeof ListResourceTemplatesResultSchema>;
type ReadResourceResult = Infer<typeof ReadResourceResultSchema>;
type ResourceUpdatedNotification = Infer<typeof ResourceUpdatedNotificationSchema>;
type ListPromptsResult = Infer<typeof ListPromptsResultSchema>;
type GetPromptResult = Infer<typeof GetPromptResultSchema>;
type ToolAnnotations = Infer<typeof ToolAnnotationsSchema>;
type ToolExecution = Infer<typeof ToolExecutionSchema>;
type Tool = Infer<typeof ToolSchema>;
type ListToolsResult = Infer<typeof ListToolsResultSchema>;
type CallToolResult = Infer<typeof CallToolResultSchema>;
type LoggingLevel = Infer<typeof LoggingLevelSchema>;
type LoggingMessageNotification = Infer<typeof LoggingMessageNotificationSchema>;
type CreateMessageRequestParams = Infer<typeof CreateMessageRequestParamsSchema>;
type CreateMessageRequest = Infer<typeof CreateMessageRequestSchema>;
type CreateMessageResult = Infer<typeof CreateMessageResultSchema>;
type CreateMessageResultWithTools = Infer<typeof CreateMessageResultWithToolsSchema>;
type ElicitRequestFormParams = Infer<typeof ElicitRequestFormParamsSchema>;
type ElicitRequestURLParams = Infer<typeof ElicitRequestURLParamsSchema>;
type ElicitResult = Infer<typeof ElicitResultSchema>;
type CompleteResult = Infer<typeof CompleteResultSchema>;
type ListRootsRequest = Infer<typeof ListRootsRequestSchema>;
type ListRootsResult = Infer<typeof ListRootsResultSchema>;
type ClientRequest = Infer<typeof ClientRequestSchema>;
type ClientNotification = Infer<typeof ClientNotificationSchema>;
type ServerRequest = Infer<typeof ServerRequestSchema>;
type ServerNotification = Infer<typeof ServerNotificationSchema>;
type MethodToTypeMap<U$1> = { [T in U$1 as T extends {
  method: infer M extends string;
} ? M : never]: T };
type RequestMethod = ClientRequest['method'] | ServerRequest['method'];
type NotificationMethod = ClientNotification['method'] | ServerNotification['method'];
type RequestTypeMap = MethodToTypeMap<ClientRequest | ServerRequest>;
type NotificationTypeMap = MethodToTypeMap<ClientNotification | ServerNotification>;
type ResultTypeMap = {
  ping: EmptyResult;
  initialize: InitializeResult;
  'completion/complete': CompleteResult;
  'logging/setLevel': EmptyResult;
  'prompts/get': GetPromptResult;
  'prompts/list': ListPromptsResult;
  'resources/list': ListResourcesResult;
  'resources/templates/list': ListResourceTemplatesResult;
  'resources/read': ReadResourceResult;
  'resources/subscribe': EmptyResult;
  'resources/unsubscribe': EmptyResult;
  'tools/call': CallToolResult | CreateTaskResult;
  'tools/list': ListToolsResult;
  'sampling/createMessage': CreateMessageResult | CreateMessageResultWithTools | CreateTaskResult;
  'elicitation/create': ElicitResult | CreateTaskResult;
  'roots/list': ListRootsResult;
  'tasks/get': GetTaskResult;
  'tasks/result': Result$1;
  'tasks/list': ListTasksResult;
  'tasks/cancel': CancelTaskResult;
};
/**
 * Information about a validated access token, provided to request handlers.
 */
interface AuthInfo {
  /**
   * The access token.
   */
  token: string;
  /**
   * The client ID associated with this token.
   */
  clientId: string;
  /**
   * Scopes associated with this token.
   */
  scopes: string[];
  /**
   * When the token expires (in seconds since epoch).
   */
  expiresAt?: number;
  /**
   * The RFC 8707 resource server identifier for which this token is valid.
   * If set, this MUST match the MCP server's resource identifier (minus hash fragment).
   */
  resource?: URL;
  /**
   * Additional data associated with the token.
   * This field should be used for any additional data that needs to be attached to the auth info.
   */
  extra?: Record<string, unknown>;
}
/**
 * Information about the incoming request.
 */
interface RequestInfo {
  /**
   * The headers of the request.
   */
  headers: Headers;
}
/**
 * Extra information about a message.
 */
interface MessageExtraInfo {
  /**
   * The request information.
   */
  requestInfo?: RequestInfo;
  /**
   * The authentication information.
   */
  authInfo?: AuthInfo;
  /**
   * Callback to close the SSE stream for this request, triggering client reconnection.
   * Only available when using {@linkcode @modelcontextprotocol/node!streamableHttp.NodeStreamableHTTPServerTransport | NodeStreamableHTTPServerTransport} with eventStore configured.
   */
  closeSSEStream?: () => void;
  /**
   * Callback to close the standalone GET SSE stream, triggering client reconnection.
   * Only available when using {@linkcode @modelcontextprotocol/node!streamableHttp.NodeStreamableHTTPServerTransport | NodeStreamableHTTPServerTransport} with eventStore configured.
   */
  closeStandaloneSSEStream?: () => void;
}
/**
 * {@linkcode CreateMessageRequestParams} without tools - for backwards-compatible overload.
 * Excludes tools/toolChoice to indicate they should not be provided.
 */
type CreateMessageRequestParamsBase = Omit<CreateMessageRequestParams, 'tools' | 'toolChoice'>;
/**
 * {@linkcode CreateMessageRequestParams} with required tools - for tool-enabled overload.
 */
interface CreateMessageRequestParamsWithTools extends CreateMessageRequestParams {
  tools: Tool[];
}
//#endregion
//#region ../core/src/util/schema.d.ts
/**
 * Base type for any Zod schema.
 */
type AnySchema = z.core.$ZodType;
/**
 * A Zod schema for objects specifically.
 */
type AnyObjectSchema = z.core.$ZodObject;
/**
 * Extracts the output type from a Zod schema.
 */
type SchemaOutput<T$1 extends AnySchema> = z.output<T$1>;
//#endregion
//#region ../core/src/experimental/tasks/interfaces.d.ts
/**
 * Server context with guaranteed task store for task creation.
 * @experimental
 */
type CreateTaskServerContext = ServerContext & {
  task: {
    store: RequestTaskStore;
    requestedTtl?: number;
  };
};
/**
 * Server context with guaranteed task ID and store for task operations.
 * @experimental
 */
type TaskServerContext = ServerContext & {
  task: {
    id: string;
    store: RequestTaskStore;
    requestedTtl?: number;
  };
};
/**
 * Task-specific execution configuration.
 * `taskSupport` cannot be `'forbidden'` for task-based tools.
 * @experimental
 */
type TaskToolExecution<TaskSupport = ToolExecution['taskSupport']> = Omit<ToolExecution, 'taskSupport'> & {
  taskSupport: TaskSupport extends 'forbidden' | undefined ? never : TaskSupport;
};
/**
 * Represents a message queued for side-channel delivery via tasks/result.
 *
 * This is a serializable data structure that can be stored in external systems.
 * All fields are JSON-serializable.
 */
type QueuedMessage = QueuedRequest | QueuedNotification | QueuedResponse | QueuedError;
interface BaseQueuedMessage {
  /** Type of message */
  type: string;
  /** When the message was queued (milliseconds since epoch) */
  timestamp: number;
}
interface QueuedRequest extends BaseQueuedMessage {
  type: 'request';
  /** The actual JSONRPC request */
  message: JSONRPCRequest;
}
interface QueuedNotification extends BaseQueuedMessage {
  type: 'notification';
  /** The actual JSONRPC notification */
  message: JSONRPCNotification;
}
interface QueuedResponse extends BaseQueuedMessage {
  type: 'response';
  /** The actual JSONRPC response */
  message: JSONRPCResultResponse;
}
interface QueuedError extends BaseQueuedMessage {
  type: 'error';
  /** The actual JSONRPC error */
  message: JSONRPCErrorResponse;
}
/**
 * Interface for managing per-task FIFO message queues.
 *
 * Similar to {@linkcode TaskStore}, this allows pluggable queue implementations
 * (in-memory, Redis, other distributed queues, etc.).
 *
 * Each method accepts taskId and optional sessionId parameters to enable
 * a single queue instance to manage messages for multiple tasks, with
 * isolation based on task ID and session ID.
 *
 * All methods are async to support external storage implementations.
 * All data in {@linkcode QueuedMessage} must be JSON-serializable.
 *
 * @see {@linkcode InMemoryTaskMessageQueue} for a reference implementation
 * @experimental
 */
interface TaskMessageQueue {
  /**
   * Adds a message to the end of the queue for a specific task.
   * Atomically checks queue size and throws if maxSize would be exceeded.
   * @param taskId The task identifier
   * @param message The message to enqueue
   * @param sessionId Optional session ID for binding the operation to a specific session
   * @param maxSize Optional maximum queue size - if specified and queue is full, throws an error
   * @throws Error if maxSize is specified and would be exceeded
   */
  enqueue(taskId: string, message: QueuedMessage, sessionId?: string, maxSize?: number): Promise<void>;
  /**
   * Removes and returns the first message from the queue for a specific task.
   * @param taskId The task identifier
   * @param sessionId Optional session ID for binding the query to a specific session
   * @returns The first message, or `undefined` if the queue is empty
   */
  dequeue(taskId: string, sessionId?: string): Promise<QueuedMessage | undefined>;
  /**
   * Removes and returns all messages from the queue for a specific task.
   * Used when tasks are cancelled or failed to clean up pending messages.
   * @param taskId The task identifier
   * @param sessionId Optional session ID for binding the query to a specific session
   * @returns Array of all messages that were in the queue
   */
  dequeueAll(taskId: string, sessionId?: string): Promise<QueuedMessage[]>;
}
/**
 * Task creation options.
 * @experimental
 */
interface CreateTaskOptions {
  /**
   * Duration in milliseconds to retain task from creation.
   * If `null`, the task has unlimited lifetime until manually cleaned up.
   */
  ttl?: number | null;
  /**
   * Time in milliseconds to wait between task status requests.
   */
  pollInterval?: number;
  /**
   * Additional context to pass to the task store.
   */
  context?: Record<string, unknown>;
}
/**
 * Interface for storing and retrieving task state and results.
 *
 * Similar to {@linkcode Transport}, this allows pluggable task storage implementations
 * (in-memory, database, distributed cache, etc.).
 *
 * @see {@linkcode InMemoryTaskStore} for a reference implementation
 * @experimental
 */
interface TaskStore {
  /**
   * Creates a new task with the given creation parameters and original request.
   * The implementation must generate a unique taskId and createdAt timestamp.
   *
   * TTL Management:
   * - The implementation receives the TTL suggested by the requestor via `taskParams.ttl`
   * - The implementation MAY override the requested TTL (e.g., to enforce limits)
   * - The actual TTL used MUST be returned in the {@linkcode Task} object
   * - `null` TTL indicates unlimited task lifetime (no automatic cleanup)
   * - Cleanup SHOULD occur automatically after TTL expires, regardless of task status
   *
   * @param taskParams - The task creation parameters from the request (ttl, pollInterval)
   * @param requestId - The JSON-RPC request ID
   * @param request - The original request that triggered task creation
   * @param sessionId - Optional session ID for binding the task to a specific session
   * @returns The created {@linkcode Task} object
   */
  createTask(taskParams: CreateTaskOptions, requestId: RequestId, request: Request, sessionId?: string): Promise<Task>;
  /**
   * Gets the current status of a task.
   *
   * @param taskId - The task identifier
   * @param sessionId - Optional session ID for binding the query to a specific session
   * @returns The {@linkcode Task} object, or `null` if it does not exist
   */
  getTask(taskId: string, sessionId?: string): Promise<Task | null>;
  /**
   * Stores the result of a task and sets its final status.
   *
   * @param taskId - The task identifier
   * @param status - The final status: `'completed'` for success, `'failed'` for errors
   * @param result - The result to store
   * @param sessionId - Optional session ID for binding the operation to a specific session
   */
  storeTaskResult(taskId: string, status: 'completed' | 'failed', result: Result$1, sessionId?: string): Promise<void>;
  /**
   * Retrieves the stored result of a task.
   *
   * @param taskId - The task identifier
   * @param sessionId - Optional session ID for binding the query to a specific session
   * @returns The stored result
   */
  getTaskResult(taskId: string, sessionId?: string): Promise<Result$1>;
  /**
   * Updates a task's status (e.g., to `'cancelled'`, `'failed'`, `'completed'`).
   *
   * @param taskId - The task identifier
   * @param status - The new status
   * @param statusMessage - Optional diagnostic message for failed tasks or other status information
   * @param sessionId - Optional session ID for binding the operation to a specific session
   */
  updateTaskStatus(taskId: string, status: Task['status'], statusMessage?: string, sessionId?: string): Promise<void>;
  /**
   * Lists tasks, optionally starting from a pagination cursor.
   *
   * @param cursor - Optional cursor for pagination
   * @param sessionId - Optional session ID for binding the query to a specific session
   * @returns An object containing the tasks array and an optional nextCursor
   */
  listTasks(cursor?: string, sessionId?: string): Promise<{
    tasks: Task[];
    nextCursor?: string;
  }>;
}
//#endregion
//#region ../core/src/shared/responseMessage.d.ts
/**
 * Base message type for the response stream.
 */
interface BaseResponseMessage {
  type: string;
}
/**
 * Task status update message.
 *
 * Yielded on each poll iteration while the task is active (e.g. while
 * `working`). May be emitted multiple times with the same status.
 */
interface TaskStatusMessage extends BaseResponseMessage {
  type: 'taskStatus';
  task: Task;
}
/**
 * Task created message.
 *
 * Yielded once when the server creates a new task for a long-running operation.
 * This is always the first message for task-augmented requests.
 */
interface TaskCreatedMessage extends BaseResponseMessage {
  type: 'taskCreated';
  task: Task;
}
/**
 * Final result message.
 *
 * Yielded once when the operation completes successfully. Terminal — no further
 * messages will follow.
 */
interface ResultMessage<T$1 extends Result$1> extends BaseResponseMessage {
  type: 'result';
  result: T$1;
}
/**
 * Error message.
 *
 * Yielded once if the operation fails. Terminal — no further messages will follow.
 */
interface ErrorMessage extends BaseResponseMessage {
  type: 'error';
  error: Error;
}
/**
 * Union of all message types yielded by task-aware streaming APIs such as
 * {@linkcode @modelcontextprotocol/client!experimental/tasks/client.ExperimentalClientTasks#callToolStream | callToolStream()},
 * {@linkcode @modelcontextprotocol/client!experimental/tasks/client.ExperimentalClientTasks#requestStream | ExperimentalClientTasks.requestStream()}, and
 * {@linkcode @modelcontextprotocol/server!experimental/tasks/server.ExperimentalServerTasks#requestStream | ExperimentalServerTasks.requestStream()}.
 *
 * A typical sequence is:
 * 1. `taskCreated` — task is registered (once)
 * 2. `taskStatus`  — zero or more progress updates
 * 3. `result` **or** `error` — terminal message (once)
 *
 * Progress notifications are handled through the existing {@linkcode index.RequestOptions | onprogress} callback.
 * Side-channeled messages (server requests/notifications) are handled through registered handlers.
 */
type ResponseMessage<T$1 extends Result$1> = TaskStatusMessage | TaskCreatedMessage | ResultMessage<T$1> | ErrorMessage;
//#endregion
//#region ../core/src/shared/taskManager.d.ts
/**
 * Host interface for TaskManager to call back into Protocol. @internal
 */
interface TaskManagerHost {
  request<T$1 extends AnySchema>(request: Request, resultSchema: T$1, options?: RequestOptions): Promise<SchemaOutput<T$1>>;
  notification(notification: Notification, options?: NotificationOptions): Promise<void>;
  reportError(error: Error): void;
  removeProgressHandler(token: number): void;
  registerHandler(method: string, handler: (request: JSONRPCRequest, ctx: BaseContext) => Promise<Result$1>): void;
  sendOnResponseStream(message: JSONRPCNotification | JSONRPCRequest, relatedRequestId: RequestId): Promise<void>;
  enforceStrictCapabilities: boolean;
  assertTaskCapability(method: string): void;
  assertTaskHandlerCapability(method: string): void;
}
/**
 * Context provided to TaskManager when processing an inbound request.
 * @internal
 */
interface InboundContext {
  sessionId?: string;
  sendNotification: (notification: Notification, options?: NotificationOptions) => Promise<void>;
  sendRequest: <U$1 extends AnySchema>(request: Request, resultSchema: U$1, options?: RequestOptions) => Promise<SchemaOutput<U$1>>;
}
/**
 * Result returned by TaskManager after processing an inbound request.
 * @internal
 */
interface InboundResult {
  taskContext?: BaseContext['task'];
  sendNotification: (notification: Notification) => Promise<void>;
  sendRequest: <U$1 extends AnySchema>(request: Request, resultSchema: U$1, options?: Omit<RequestOptions, 'relatedTask'>) => Promise<SchemaOutput<U$1>>;
  routeResponse: (message: JSONRPCResponse | JSONRPCErrorResponse) => Promise<boolean>;
  hasTaskCreationParams: boolean;
  /**
   * Optional validation to run inside the async handler chain (before the request handler).
   * Throwing here produces a proper JSON-RPC error response, matching the behavior of
   * capability checks on main.
   */
  validateInbound?: () => void;
}
/**
 * Options that can be given per request.
 */
type TaskRequestOptions = Omit<RequestOptions, 'relatedTask'>;
/**
 * Request-scoped TaskStore interface.
 */
interface RequestTaskStore {
  /**
   * Creates a new task with the given creation parameters.
   * The implementation generates a unique taskId and createdAt timestamp.
   *
   * @param taskParams - The task creation parameters from the request
   * @returns The created task object
   */
  createTask(taskParams: CreateTaskOptions): Promise<Task>;
  /**
   * Gets the current status of a task.
   *
   * @param taskId - The task identifier
   * @returns The task object
   * @throws If the task does not exist
   */
  getTask(taskId: string): Promise<Task>;
  /**
   * Stores the result of a task and sets its final status.
   *
   * @param taskId - The task identifier
   * @param status - The final status: 'completed' for success, 'failed' for errors
   * @param result - The result to store
   */
  storeTaskResult(taskId: string, status: 'completed' | 'failed', result: Result$1): Promise<void>;
  /**
   * Retrieves the stored result of a task.
   *
   * @param taskId - The task identifier
   * @returns The stored result
   */
  getTaskResult(taskId: string): Promise<Result$1>;
  /**
   * Updates a task's status (e.g., to 'cancelled', 'failed', 'completed').
   *
   * @param taskId - The task identifier
   * @param status - The new status
   * @param statusMessage - Optional diagnostic message for failed tasks or other status information
   */
  updateTaskStatus(taskId: string, status: Task['status'], statusMessage?: string): Promise<void>;
  /**
   * Lists tasks, optionally starting from a pagination cursor.
   *
   * @param cursor - Optional cursor for pagination
   * @returns An object containing the tasks array and an optional nextCursor
   */
  listTasks(cursor?: string): Promise<{
    tasks: Task[];
    nextCursor?: string;
  }>;
}
/**
 * Task context provided to request handlers when task storage is configured.
 */
type TaskContext = {
  id?: string;
  store: RequestTaskStore;
  requestedTtl?: number;
};
type TaskManagerOptions = {
  /**
   * Task storage implementation. Required for handling incoming task requests (server-side).
   * Not required for sending task requests (client-side outbound API).
   */
  taskStore?: TaskStore;
  /**
   * Optional task message queue implementation for managing server-initiated messages
   * that will be delivered through the tasks/result response stream.
   */
  taskMessageQueue?: TaskMessageQueue;
  /**
   * Default polling interval (in milliseconds) for task status checks when no pollInterval
   * is provided by the server. Defaults to 1000ms if not specified.
   */
  defaultTaskPollInterval?: number;
  /**
   * Maximum number of messages that can be queued per task for side-channel delivery.
   * If undefined, the queue size is unbounded.
   */
  maxTaskQueueSize?: number;
};
/**
 * Manages task orchestration: state, message queuing, and polling.
 * Capability checking is delegated to the Protocol host.
 * @internal
 */
declare class TaskManager {
  private _taskStore?;
  private _taskMessageQueue?;
  private _taskProgressTokens;
  private _requestResolvers;
  private _options;
  private _host?;
  constructor(options: TaskManagerOptions);
  bind(host: TaskManagerHost): void;
  protected get _requireHost(): TaskManagerHost;
  get taskStore(): TaskStore | undefined;
  private get _requireTaskStore();
  get taskMessageQueue(): TaskMessageQueue | undefined;
  requestStream<T$1 extends AnyObjectSchema>(request: Request, resultSchema: T$1, options?: RequestOptions): AsyncGenerator<ResponseMessage<SchemaOutput<T$1>>, void, void>;
  getTask(params: GetTaskRequest['params'], options?: RequestOptions): Promise<GetTaskResult>;
  getTaskResult<T$1 extends AnySchema>(params: GetTaskPayloadRequest['params'], resultSchema: T$1, options?: RequestOptions): Promise<SchemaOutput<T$1>>;
  listTasks(params?: {
    cursor?: string;
  }, options?: RequestOptions): Promise<SchemaOutput<typeof ListTasksResultSchema>>;
  cancelTask(params: {
    taskId: string;
  }, options?: RequestOptions): Promise<SchemaOutput<typeof CancelTaskResultSchema>>;
  private handleGetTask;
  private handleGetTaskPayload;
  private handleListTasks;
  private handleCancelTask;
  private prepareOutboundRequest;
  private extractInboundTaskContext;
  private wrapSendNotification;
  private wrapSendRequest;
  private handleResponse;
  private shouldPreserveProgressHandler;
  private routeNotification;
  private routeResponse;
  private createRequestTaskStore;
  processInboundRequest(request: JSONRPCRequest, ctx: InboundContext): InboundResult;
  processOutboundRequest(jsonrpcRequest: JSONRPCRequest, options: RequestOptions | undefined, messageId: number, responseHandler: (response: JSONRPCResultResponse | Error) => void, onError: (error: unknown) => void): {
    queued: boolean;
  };
  processInboundResponse(response: JSONRPCResponse | JSONRPCErrorResponse, messageId: number): {
    consumed: boolean;
    preserveProgress: boolean;
  };
  processOutboundNotification(notification: Notification, options?: NotificationOptions): Promise<{
    queued: boolean;
    jsonrpcNotification?: JSONRPCNotification;
  }>;
  onClose(): void;
  private _enqueueTaskMessage;
  private _clearTaskQueue;
  private _waitForTaskUpdate;
  private _cleanupTaskProgressHandler;
}
//#endregion
//#region ../core/src/shared/transport.d.ts
/**
 * Options for sending a JSON-RPC message.
 */
type TransportSendOptions = {
  /**
   * If present, `relatedRequestId` is used to indicate to the transport which incoming request to associate this outgoing message with.
   */
  relatedRequestId?: RequestId;
  /**
   * The resumption token used to continue long-running requests that were interrupted.
   *
   * This allows clients to reconnect and continue from where they left off, if supported by the transport.
   */
  resumptionToken?: string;
  /**
   * A callback that is invoked when the resumption token changes, if supported by the transport.
   *
   * This allows clients to persist the latest token for potential reconnection.
   */
  onresumptiontoken?: (token: string) => void;
};
/**
 * Describes the minimal contract for an MCP transport that a client or server can communicate over.
 */
interface Transport {
  /**
   * Starts processing messages on the transport, including any connection steps that might need to be taken.
   *
   * This method should only be called after callbacks are installed, or else messages may be lost.
   *
   * NOTE: This method should not be called explicitly when using {@linkcode @modelcontextprotocol/client!client/client.Client | Client} or {@linkcode @modelcontextprotocol/server!server/server.Server | Server} classes, as they will implicitly call {@linkcode Transport.start | start()}.
   */
  start(): Promise<void>;
  /**
   * Sends a JSON-RPC message (request or response).
   *
   * If present, `relatedRequestId` is used to indicate to the transport which incoming request to associate this outgoing message with.
   */
  send(message: JSONRPCMessage, options?: TransportSendOptions): Promise<void>;
  /**
   * Closes the connection.
   */
  close(): Promise<void>;
  /**
   * Callback for when the connection is closed for any reason.
   *
   * This should be invoked when {@linkcode Transport.close | close()} is called as well.
   */
  onclose?: () => void;
  /**
   * Callback for when an error occurs.
   *
   * Note that errors are not necessarily fatal; they are used for reporting any kind of exceptional condition out of band.
   */
  onerror?: (error: Error) => void;
  /**
   * Callback for when a message (request or response) is received over the connection.
   *
   * Includes the {@linkcode MessageExtraInfo.requestInfo | requestInfo} and {@linkcode MessageExtraInfo.authInfo | authInfo} if the transport is authenticated.
   *
   * The {@linkcode MessageExtraInfo.requestInfo | requestInfo} can be used to get the original request information (headers, etc.)
   */
  onmessage?: <T$1 extends JSONRPCMessage>(message: T$1, extra?: MessageExtraInfo) => void;
  /**
   * The session ID generated for this connection.
   */
  sessionId?: string;
  /**
   * Sets the protocol version used for the connection (called when the initialize response is received).
   */
  setProtocolVersion?: (version: string) => void;
  /**
   * Sets the supported protocol versions for header validation (called during connect).
   * This allows the server to pass its supported versions to the transport.
   */
  setSupportedProtocolVersions?: (versions: string[]) => void;
}
//#endregion
//#region ../core/src/shared/protocol.d.ts
/**
 * Callback for progress notifications.
 */
type ProgressCallback = (progress: Progress) => void;
/**
 * Additional initialization options.
 */
type ProtocolOptions = {
  /**
   * Protocol versions supported. First version is preferred (sent by client,
   * used as fallback by server). Passed to transport during {@linkcode Protocol.connect | connect()}.
   *
   * @default {@linkcode SUPPORTED_PROTOCOL_VERSIONS}
   */
  supportedProtocolVersions?: string[];
  /**
   * Whether to restrict emitted requests to only those that the remote side has indicated that they can handle, through their advertised capabilities.
   *
   * Note that this DOES NOT affect checking of _local_ side capabilities, as it is considered a logic error to mis-specify those.
   *
   * Currently this defaults to `false`, for backwards compatibility with SDK versions that did not advertise capabilities correctly. In future, this will default to `true`.
   */
  enforceStrictCapabilities?: boolean;
  /**
   * An array of notification method names that should be automatically debounced.
   * Any notifications with a method in this list will be coalesced if they
   * occur in the same tick of the event loop.
   * e.g., `['notifications/tools/list_changed']`
   */
  debouncedNotificationMethods?: string[];
  /**
   * Runtime configuration for task management.
   * If provided, creates a TaskManager with the given options; otherwise a NullTaskManager is used.
   *
   * Capability assertions are wired automatically from the protocol's
   * `assertTaskCapability()` and `assertTaskHandlerCapability()` methods,
   * so they should NOT be included here.
   */
  tasks?: TaskManagerOptions;
};
/**
 * Options that can be given per request.
 */
type RequestOptions = {
  /**
   * If set, requests progress notifications from the remote end (if supported). When progress notifications are received, this callback will be invoked.
   *
   * For task-augmented requests: progress notifications continue after {@linkcode CreateTaskResult} is returned and stop automatically when the task reaches a terminal status.
   */
  onprogress?: ProgressCallback;
  /**
   * Can be used to cancel an in-flight request. This will cause an `AbortError` to be raised from {@linkcode Protocol.request | request()}.
   */
  signal?: AbortSignal;
  /**
   * A timeout (in milliseconds) for this request. If exceeded, an {@linkcode SdkError} with code {@linkcode SdkErrorCode.RequestTimeout} will be raised from {@linkcode Protocol.request | request()}.
   *
   * If not specified, {@linkcode DEFAULT_REQUEST_TIMEOUT_MSEC} will be used as the timeout.
   */
  timeout?: number;
  /**
   * If `true`, receiving a progress notification will reset the request timeout.
   * This is useful for long-running operations that send periodic progress updates.
   * Default: `false`
   */
  resetTimeoutOnProgress?: boolean;
  /**
   * Maximum total time (in milliseconds) to wait for a response.
   * If exceeded, an {@linkcode SdkError} with code {@linkcode SdkErrorCode.RequestTimeout} will be raised, regardless of progress notifications.
   * If not specified, there is no maximum total timeout.
   */
  maxTotalTimeout?: number;
  /**
   * If provided, augments the request with task creation parameters to enable call-now, fetch-later execution patterns.
   */
  task?: TaskCreationParams;
  /**
   * If provided, associates this request with a related task.
   */
  relatedTask?: RelatedTaskMetadata;
} & TransportSendOptions;
/**
 * Options that can be given per notification.
 */
type NotificationOptions = {
  /**
   * May be used to indicate to the transport which incoming request to associate this outgoing notification with.
   */
  relatedRequestId?: RequestId;
  /**
   * If provided, associates this notification with a related task.
   */
  relatedTask?: RelatedTaskMetadata;
};
/**
 * Base context provided to all request handlers.
 */
type BaseContext = {
  /**
   * The session ID from the transport, if available.
   */
  sessionId?: string;
  /**
   * Information about the MCP request being handled.
   */
  mcpReq: {
    /**
     * The JSON-RPC ID of the request being handled.
     */
    id: RequestId;
    /**
     * The method name of the request (e.g., 'tools/call', 'ping').
     */
    method: string;
    /**
     * Metadata from the original request.
     */
    _meta?: RequestMeta;
    /**
     * An abort signal used to communicate if the request was cancelled from the sender's side.
     */
    signal: AbortSignal;
    /**
     * Sends a request that relates to the current request being handled.
     *
     * This is used by certain transports to correctly associate related messages.
     */
    send: <M extends RequestMethod>(request: {
      method: M;
      params?: Record<string, unknown>;
    }, options?: TaskRequestOptions) => Promise<ResultTypeMap[M]>;
    /**
     * Sends a notification that relates to the current request being handled.
     *
     * This is used by certain transports to correctly associate related messages.
     */
    notify: (notification: Notification) => Promise<void>;
  };
  /**
   * HTTP transport information, only available when using an HTTP-based transport.
   */
  http?: {
    /**
     * Information about a validated access token, provided to request handlers.
     */
    authInfo?: AuthInfo;
  };
  /**
   * Task context, available when task storage is configured.
   */
  task?: TaskContext;
};
/**
 * Context provided to server-side request handlers, extending {@linkcode BaseContext} with server-specific fields.
 */
type ServerContext = BaseContext & {
  mcpReq: {
    /**
     * Send a log message notification to the client.
     * Respects the client's log level filter set via logging/setLevel.
     */
    log: (level: LoggingLevel, data: unknown, logger?: string) => Promise<void>;
    /**
     * Send an elicitation request to the client, requesting user input.
     */
    elicitInput: (params: ElicitRequestFormParams | ElicitRequestURLParams, options?: RequestOptions) => Promise<ElicitResult>;
    /**
     * Request LLM sampling from the client.
     */
    requestSampling: (params: CreateMessageRequest['params'], options?: RequestOptions) => Promise<CreateMessageResult | CreateMessageResultWithTools>;
  };
  http?: {
    /**
     * The original HTTP request information.
     */
    req?: RequestInfo;
    /**
     * Closes the SSE stream for this request, triggering client reconnection.
     * Only available when using a StreamableHTTPServerTransport with eventStore configured.
     */
    closeSSE?: () => void;
    /**
     * Closes the standalone GET SSE stream, triggering client reconnection.
     * Only available when using a StreamableHTTPServerTransport with eventStore configured.
     */
    closeStandaloneSSE?: () => void;
  };
};
/**
 * Implements MCP protocol framing on top of a pluggable transport, including
 * features like request/response linking, notifications, and progress.
 */
declare abstract class Protocol<ContextT extends BaseContext> {
  private _options?;
  private _transport?;
  private _requestMessageId;
  private _requestHandlers;
  private _requestHandlerAbortControllers;
  private _notificationHandlers;
  private _responseHandlers;
  private _progressHandlers;
  private _timeoutInfo;
  private _pendingDebouncedNotifications;
  private _taskManager;
  protected _supportedProtocolVersions: string[];
  /**
   * Callback for when the connection is closed for any reason.
   *
   * This is invoked when {@linkcode Protocol.close | close()} is called as well.
   */
  onclose?: () => void;
  /**
   * Callback for when an error occurs.
   *
   * Note that errors are not necessarily fatal; they are used for reporting any kind of exceptional condition out of band.
   */
  onerror?: (error: Error) => void;
  /**
   * A handler to invoke for any request types that do not have their own handler installed.
   */
  fallbackRequestHandler?: (request: JSONRPCRequest, ctx: ContextT) => Promise<Result$1>;
  /**
   * A handler to invoke for any notification types that do not have their own handler installed.
   */
  fallbackNotificationHandler?: (notification: Notification) => Promise<void>;
  constructor(_options?: ProtocolOptions | undefined);
  /**
   * Access the TaskManager for task orchestration.
   * Always available; returns a NullTaskManager when no task store is configured.
   */
  get taskManager(): TaskManager;
  private _bindTaskManager;
  /**
   * Builds the context object for request handlers. Subclasses must override
   * to return the appropriate context type (e.g., ServerContext adds requestInfo).
   */
  protected abstract buildContext(ctx: BaseContext, transportInfo?: MessageExtraInfo): ContextT;
  private _oncancel;
  private _setupTimeout;
  private _resetTimeout;
  private _cleanupTimeout;
  /**
   * Attaches to the given transport, starts it, and starts listening for messages.
   *
   * The caller assumes ownership of the {@linkcode Transport}, replacing any callbacks that have already been set, and expects that it is the only user of the {@linkcode Transport} instance going forward.
   */
  connect(transport: Transport): Promise<void>;
  private _onclose;
  private _onerror;
  private _onnotification;
  private _onrequest;
  private _onprogress;
  private _onresponse;
  get transport(): Transport | undefined;
  /**
   * Closes the connection.
   */
  close(): Promise<void>;
  /**
   * A method to check if a capability is supported by the remote side, for the given method to be called.
   *
   * This should be implemented by subclasses.
   */
  protected abstract assertCapabilityForMethod(method: RequestMethod): void;
  /**
   * A method to check if a notification is supported by the local side, for the given method to be sent.
   *
   * This should be implemented by subclasses.
   */
  protected abstract assertNotificationCapability(method: NotificationMethod): void;
  /**
   * A method to check if a request handler is supported by the local side, for the given method to be handled.
   *
   * This should be implemented by subclasses.
   */
  protected abstract assertRequestHandlerCapability(method: string): void;
  /**
   * A method to check if the remote side supports task creation for the given method.
   *
   * Called when sending a task-augmented outbound request (only when enforceStrictCapabilities is true).
   * This should be implemented by subclasses.
   */
  protected abstract assertTaskCapability(method: string): void;
  /**
   * A method to check if this side supports handling task creation for the given method.
   *
   * Called when receiving a task-augmented inbound request.
   * This should be implemented by subclasses.
   */
  protected abstract assertTaskHandlerCapability(method: string): void;
  /**
   * Sends a request and waits for a response, resolving the result schema
   * automatically from the method name.
   *
   * Do not use this method to emit notifications! Use {@linkcode Protocol.notification | notification()} instead.
   */
  request<M extends RequestMethod>(request: {
    method: M;
    params?: Record<string, unknown>;
  }, options?: RequestOptions): Promise<ResultTypeMap[M]>;
  /**
   * Sends a request and waits for a response, using the provided schema for validation.
   *
   * This is the internal implementation used by SDK methods that need to specify
   * a particular result schema (e.g., for compatibility or task-specific schemas).
   */
  protected _requestWithSchema<T$1 extends AnySchema>(request: Request, resultSchema: T$1, options?: RequestOptions): Promise<SchemaOutput<T$1>>;
  /**
   * Emits a notification, which is a one-way message that does not expect a response.
   */
  notification(notification: Notification, options?: NotificationOptions): Promise<void>;
  /**
   * Registers a handler to invoke when this protocol object receives a request with the given method.
   *
   * Note that this will replace any previous request handler for the same method.
   */
  setRequestHandler<M extends RequestMethod>(method: M, handler: (request: RequestTypeMap[M], ctx: ContextT) => Result$1 | Promise<Result$1>): void;
  /**
   * Removes the request handler for the given method.
   */
  removeRequestHandler(method: RequestMethod): void;
  /**
   * Asserts that a request handler has not already been set for the given method, in preparation for a new one being automatically installed.
   */
  assertCanSetRequestHandler(method: RequestMethod): void;
  /**
   * Registers a handler to invoke when this protocol object receives a notification with the given method.
   *
   * Note that this will replace any previous notification handler for the same method.
   */
  setNotificationHandler<M extends NotificationMethod>(method: M, handler: (notification: NotificationTypeMap[M]) => void | Promise<void>): void;
  /**
   * Removes the notification handler for the given method.
   */
  removeNotificationHandler(method: NotificationMethod): void;
}
//#endregion
//#region ../core/src/shared/uriTemplate.d.ts
type Variables = Record<string, string | string[]>;
declare class UriTemplate {
  /**
   * Returns true if the given string contains any URI template expressions.
   * A template expression is a sequence of characters enclosed in curly braces,
   * like `{foo}` or `{?bar}`.
   */
  static isTemplate(str: string): boolean;
  private static validateLength;
  private readonly template;
  private readonly parts;
  get variableNames(): string[];
  constructor(template: string);
  toString(): string;
  private parse;
  private getOperator;
  private getNames;
  private encodeValue;
  private expandPart;
  expand(variables: Variables): string;
  private escapeRegExp;
  private partToRegExp;
  match(uri: string): Variables | null;
}
//#endregion
//#region ../core/src/util/standardSchema.d.ts
/**
 * Standard Schema utilities for user-provided schemas.
 * Supports Zod v4, Valibot, ArkType, and other Standard Schema implementations.
 * @see https://standardschema.dev
 */
interface StandardTypedV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardTypedV1.Props<Input, Output>;
}
declare namespace StandardTypedV1 {
  interface Props<Input = unknown, Output = Input> {
    readonly version: 1;
    readonly vendor: string;
    readonly types?: Types<Input, Output> | undefined;
  }
  interface Types<Input = unknown, Output = Input> {
    readonly input: Input;
    readonly output: Output;
  }
  type InferInput<Schema extends StandardTypedV1> = NonNullable<Schema['~standard']['types']>['input'];
  type InferOutput<Schema extends StandardTypedV1> = NonNullable<Schema['~standard']['types']>['output'];
}
interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardSchemaV1.Props<Input, Output>;
}
declare namespace StandardSchemaV1 {
  interface Props<Input = unknown, Output = Input> extends StandardTypedV1.Props<Input, Output> {
    readonly validate: (value: unknown, options?: Options | undefined) => Result<Output> | Promise<Result<Output>>;
  }
  interface Options {
    readonly libraryOptions?: Record<string, unknown> | undefined;
  }
  type Result<Output> = SuccessResult<Output> | FailureResult;
  interface SuccessResult<Output> {
    readonly value: Output;
    readonly issues?: undefined;
  }
  interface FailureResult {
    readonly issues: ReadonlyArray<Issue>;
  }
  interface Issue {
    readonly message: string;
    readonly path?: ReadonlyArray<PropertyKey | PathSegment> | undefined;
  }
  interface PathSegment {
    readonly key: PropertyKey;
  }
  type InferInput<Schema extends StandardTypedV1> = StandardTypedV1.InferInput<Schema>;
  type InferOutput<Schema extends StandardTypedV1> = StandardTypedV1.InferOutput<Schema>;
}
interface StandardJSONSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': StandardJSONSchemaV1.Props<Input, Output>;
}
declare namespace StandardJSONSchemaV1 {
  interface Props<Input = unknown, Output = Input> extends StandardTypedV1.Props<Input, Output> {
    readonly jsonSchema: Converter;
  }
  interface Converter {
    readonly input: (options: Options) => Record<string, unknown>;
    readonly output: (options: Options) => Record<string, unknown>;
  }
  type Target = 'draft-2020-12' | 'draft-07' | 'openapi-3.0' | (object & string);
  interface Options {
    readonly target: Target;
    readonly libraryOptions?: Record<string, unknown> | undefined;
  }
  type InferInput<Schema extends StandardTypedV1> = StandardTypedV1.InferInput<Schema>;
  type InferOutput<Schema extends StandardTypedV1> = StandardTypedV1.InferOutput<Schema>;
}
/**
 * Combined interface for schemas with both validation and JSON Schema conversion —
 * the intersection of {@linkcode StandardSchemaV1} and {@linkcode StandardJSONSchemaV1}.
 *
 * This is the type accepted by `registerTool` / `registerPrompt`. The SDK needs
 * `~standard.jsonSchema` to advertise the tool's argument shape in `tools/list`, and
 * `~standard.validate` to check incoming arguments when a `tools/call` arrives.
 *
 * Zod v4, ArkType, and Valibot (via `@valibot/to-json-schema`'s `toStandardJsonSchema`)
 * all implement both interfaces.
 *
 * @see https://standardschema.dev/ for the Standard Schema specification
 */
interface StandardSchemaWithJSON<Input = unknown, Output = Input> {
  readonly '~standard': StandardSchemaV1.Props<Input, Output> & StandardJSONSchemaV1.Props<Input, Output>;
}
declare namespace StandardSchemaWithJSON {
  type InferInput<Schema extends StandardTypedV1> = StandardTypedV1.InferInput<Schema>;
  type InferOutput<Schema extends StandardTypedV1> = StandardTypedV1.InferOutput<Schema>;
}
//#endregion
//#region ../core/src/validators/types.d.ts
/**
 * JSON Schema type definition (JSON Schema Draft 2020-12)
 *
 * This uses the object form of JSON Schema (excluding boolean schemas).
 * While `true` and `false` are valid JSON Schemas, this SDK uses the
 * object form for practical type safety.
 *
 * Re-exported from json-schema-typed for convenience.
 * @see https://json-schema.org/draft/2020-12/json-schema-core.html
 */
type JsonSchemaType = JSONSchema.Interface;
/**
 * Result of a JSON Schema validation operation
 */
type JsonSchemaValidatorResult<T$1> = {
  valid: true;
  data: T$1;
  errorMessage: undefined;
} | {
  valid: false;
  data: undefined;
  errorMessage: string;
};
/**
 * A validator function that validates data against a JSON Schema
 */
type JsonSchemaValidator<T$1> = (input: unknown) => JsonSchemaValidatorResult<T$1>;
/**
 * Provider interface for creating validators from JSON Schemas
 *
 * This is the main extension point for custom validator implementations.
 * Implementations should:
 * - Support JSON Schema Draft 2020-12 (or be compatible with it)
 * - Return validator functions that can be called multiple times
 * - Handle schema compilation/caching internally
 * - Provide clear error messages on validation failure
 *
 * @example
 * ```ts source="./types.examples.ts#jsonSchemaValidator_implementation"
 * class MyValidatorProvider implements jsonSchemaValidator {
 *     getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
 *         // Compile/cache validator from schema
 *         return (input: unknown) =>
 *             isValid(schema, input)
 *                 ? { valid: true, data: input as T, errorMessage: undefined }
 *                 : { valid: false, data: undefined, errorMessage: 'Error details' };
 *     }
 * }
 * ```
 */
interface jsonSchemaValidator {
  /**
   * Create a validator for the given JSON Schema
   *
   * @param schema - Standard JSON Schema object
   * @returns A validator function that can be called multiple times
   */
  getValidator<T$1>(schema: JsonSchemaType): JsonSchemaValidator<T$1>;
}
//#endregion
//#region ../core/src/validators/ajvProvider.d.ts
/**
 * @example Use with default AJV instance (recommended)
 * ```ts source="./ajvProvider.examples.ts#AjvJsonSchemaValidator_default"
 * const validator = new AjvJsonSchemaValidator();
 * ```
 *
 * @example Use with custom AJV instance
 * ```ts source="./ajvProvider.examples.ts#AjvJsonSchemaValidator_customInstance"
 * const ajv = new Ajv({ strict: true, allErrors: true });
 * const validator = new AjvJsonSchemaValidator(ajv);
 * ```
 *
 * @see {@linkcode CfWorkerJsonSchemaValidator} for an edge-runtime-compatible alternative
 */
declare class AjvJsonSchemaValidator implements jsonSchemaValidator {
  private _ajv;
  /**
   * Create an AJV validator
   *
   * @param ajv - Optional pre-configured AJV instance. If not provided, a default instance will be created.
   *
   * @example Use default configuration (recommended for most cases)
   * ```ts source="./ajvProvider.examples.ts#AjvJsonSchemaValidator_default"
   * const validator = new AjvJsonSchemaValidator();
   * ```
   *
   * @example Provide custom AJV instance for advanced configuration
   * ```ts source="./ajvProvider.examples.ts#AjvJsonSchemaValidator_constructor_withFormats"
   * const ajv = new Ajv({ validateFormats: true });
   * addFormats(ajv);
   * const validator = new AjvJsonSchemaValidator(ajv);
   * ```
   */
  constructor(ajv?: Ajv);
  /**
   * Create a validator for the given JSON Schema
   *
   * The validator is compiled once and can be reused multiple times.
   * If the schema has an `$id`, it will be cached by AJV automatically.
   *
   * @param schema - Standard JSON Schema object
   * @returns A validator function that validates input data
   */
  getValidator<T$1>(schema: JsonSchemaType): JsonSchemaValidator<T$1>;
}
//#endregion
//#region ../core/src/validators/cfWorkerProvider.d.ts
/**
 * JSON Schema draft version supported by @cfworker/json-schema
 */
type CfWorkerSchemaDraft = '4' | '7' | '2019-09' | '2020-12';
/**
 *
 * @example Use with default configuration (2020-12, shortcircuit)
 * ```ts source="./cfWorkerProvider.examples.ts#CfWorkerJsonSchemaValidator_default"
 * const validator = new CfWorkerJsonSchemaValidator();
 * ```
 *
 * @example Use with custom configuration
 * ```ts source="./cfWorkerProvider.examples.ts#CfWorkerJsonSchemaValidator_customConfig"
 * const validator = new CfWorkerJsonSchemaValidator({
 *     draft: '2020-12',
 *     shortcircuit: false // Report all errors
 * });
 * ```
 */
declare class CfWorkerJsonSchemaValidator implements jsonSchemaValidator {
  private shortcircuit;
  private draft;
  /**
   * Create a validator
   *
   * @param options - Configuration options
   * @param options.shortcircuit - If `true`, stop validation after first error (default: `true`)
   * @param options.draft - JSON Schema draft version to use (default: `'2020-12'`)
   */
  constructor(options?: {
    shortcircuit?: boolean;
    draft?: CfWorkerSchemaDraft;
  });
  /**
   * Create a validator for the given JSON Schema
   *
   * Unlike AJV, this validator is not cached internally
   *
   * @param schema - Standard JSON Schema object
   * @returns A validator function that validates input data
   */
  getValidator<T$1>(schema: JsonSchemaType): JsonSchemaValidator<T$1>;
}
//#endregion
export { ToolAnnotations as $, ElicitRequestFormParams as A, ListTasksResult as B, CreateMessageRequest as C, CreateMessageResult as D, CreateMessageRequestParamsWithTools as E, GetTaskResult as F, RequestId as G, MessageExtraInfo as H, Implementation as I, Resource as J, RequestMethod as K, JSONRPCMessage as L, ElicitResult as M, GetPromptResult as N, CreateMessageResultWithTools as O, GetTaskPayloadResult as P, ServerCapabilities as Q, ListResourcesResult as R, ClientCapabilities as S, CreateMessageRequestParamsBase as T, NotificationMethod as U, LoggingMessageNotification as V, ReadResourceResult as W, Result$1 as X, ResourceUpdatedNotification as Y, ResultTypeMap as Z, TaskServerContext as _, UriTemplate as a, CallToolResult as b, NotificationOptions as c, RequestOptions as d, ToolExecution as et, ServerContext as f, CreateTaskServerContext as g, ResponseMessage as h, StandardSchemaWithJSON as i, ElicitRequestURLParams as j, CreateTaskResult as k, Protocol as l, TaskManagerOptions as m, AjvJsonSchemaValidator as n, Variables as o, Transport as p, RequestTypeMap as q, jsonSchemaValidator as r, BaseContext as s, CfWorkerJsonSchemaValidator as t, ProtocolOptions as u, TaskToolExecution as v, CreateMessageRequestParams as w, CancelTaskResult as x, AuthInfo as y, ListRootsRequest as z };
//# sourceMappingURL=index-Df8mSdyO.d.mts.map