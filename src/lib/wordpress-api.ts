import { mkdir, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import path from "node:path";
import { readConnectorConfigFromDatabase, writeConnectorConfigToDatabase } from "@/lib/database";
import {
  CINATRA_NANGO_PROVIDER_CONFIG_KEYS,
  deleteNangoConnection,
  getNangoConnection,
  ensureNangoIntegration,
  getNangoCredentials,
  importNangoConnection,
  isNangoConfigured,
} from "@/lib/nango";

export type WordPressInstanceSettings = {
  id: string;
  name: string;
  siteUrl: string;
  username: string;
  applicationPassword: string;
  providerConfigKey?: string;
  connectionId?: string;
  lastValidatedAt?: string;
  createdAt: string;
  updatedAt: string;
  /**
   * Opt-in site-specific blog-connector binding. When unset, the
   * @cinatra-ai/blog-connector facade routes WordPress publishes
   * through the generic `defaultBlogConnector`. When set, the facade routes
   * through the named connector — the bundled site connector that registered
   * under that id (e.g. one carrying a site-specific page-builder layout).
   *
   * Persisted as part of the `connector_config:wordpress` JSON blob — no
   * schema migration. Both `saveWordPressInstance` and
   * `saveWordPressInstanceFromNangoConnection` preserve this field across
   * edit + reconnect-via-Nango flows.
   */
  blogConnectorId?: string;
};

type WordPressAPISettings = {
  instances: WordPressInstanceSettings[];
  loggingEnabled?: boolean;
};

export const WORDPRESS_API_LOG_DIRECTORY = path.join(process.cwd(), "data", "logs", "wordpress-api");

type WordPressPostRecord = {
  id: number;
  link?: string;
  slug?: string;
  author?: number;
  comment_status?: "open" | "closed";
  ping_status?: "open" | "closed";
  format?: string;
  sticky?: boolean;
  template?: string;
  categories?: number[];
  tags?: number[];
  meta?: Record<string, unknown>;
  featured_media?: number;
  date?: string;
  title?: {
    raw?: string;
    rendered?: string;
  };
  content?: {
    raw?: string;
    rendered?: string;
  };
  excerpt?: {
    raw?: string;
    rendered?: string;
  };
  status?: string;
};

export type WordPressPostStatusRecord = {
  id: number;
  status: string;
  adminUrl: string;
  publicUrl?: string;
};

export type WordPressWritablePostPayload = {
  title: string;
  content: string;
  excerpt: string;
  status: "draft";
  slug?: string;
  author?: number;
  comment_status?: "open" | "closed";
  ping_status?: "open" | "closed";
  format?: string;
  sticky?: boolean;
  template?: string;
  categories?: number[];
  tags?: number[];
  meta?: Record<string, unknown>;
  featured_media?: number;
};

type WordPressCreateDraftPayload = {
  title: string;
  content: string;
  excerpt: string;
  status: "draft";
  featured_media?: number;
};

function readSettings() {
  return readConnectorConfigFromDatabase<WordPressAPISettings>("wordpress", { instances: [] });
}

function writeSettings(value: WordPressAPISettings) {
  writeConnectorConfigToDatabase("wordpress", value);
}

function sanitizeLogLabel(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "wordpress-call"
  );
}

function buildLogTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function isWordPressLoggingEnabled() {
  return readSettings().loggingEnabled !== false;
}

async function writeWordPressLogFile(input: {
  label: string;
  kind: "request" | "response";
  body: unknown;
}) {
  if (!isWordPressLoggingEnabled()) {
    return;
  }

  await mkdir(WORDPRESS_API_LOG_DIRECTORY, { recursive: true });
  const filename = `${buildLogTimestamp()}__${sanitizeLogLabel(input.label)}__${input.kind}.json`;
  const content = typeof input.body === "string" ? { raw: input.body } : input.body;
  await writeFile(path.join(WORDPRESS_API_LOG_DIRECTORY, filename), JSON.stringify(content, null, 2), "utf8");
}

function normalizeSiteUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  try {
    const url = new URL(withProtocol);
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return withProtocol.replace(/\/+$/, "");
  }
}

function buildAuthHeader(instance: Pick<WordPressInstanceSettings, "username" | "applicationPassword">) {
  return `Basic ${Buffer.from(`${instance.username}:${instance.applicationPassword}`).toString("base64")}`;
}

async function resolveWordPressBasicAuth(instance: WordPressInstanceSettings) {
  if (!isNangoConfigured()) {
    throw new Error("Configure Nango first so WordPress API requests can authenticate through Nango.");
  }

  if (!instance.providerConfigKey || !instance.connectionId) {
    throw new Error("This WordPress instance is missing its Nango connection.");
  }

  const credentials = await resolveWordPressNangoCredentials(instance.providerConfigKey, instance.connectionId);
  if (!credentials) {
    throw new Error("Unable to load the WordPress credentials from Nango.");
  }

  return {
    username: credentials.username,
    applicationPassword: credentials.password,
    authHeader: buildAuthHeader({
      username: credentials.username,
      applicationPassword: credentials.password,
    }),
  };
}

async function resolveWordPressNangoCredentials(providerConfigKey: string, connectionId: string) {
  const tokenCredentials = await getNangoCredentials(providerConfigKey, connectionId);
  if (
    tokenCredentials &&
    typeof tokenCredentials === "object" &&
    "username" in tokenCredentials &&
    typeof tokenCredentials.username === "string" &&
    "password" in tokenCredentials &&
    typeof tokenCredentials.password === "string"
  ) {
    return {
      username: tokenCredentials.username,
      password: tokenCredentials.password,
    };
  }

  const connection = await getNangoConnection(providerConfigKey, connectionId, {
    forceRefresh: false,
    refreshToken: false,
  });
  const connectionCredentials = (connection as
    | {
        credentials?: {
          type?: string;
          username?: string;
          password?: string;
        };
      }
    | null)?.credentials;

  if (
    connectionCredentials?.type === "BASIC" &&
    typeof connectionCredentials.username === "string" &&
    typeof connectionCredentials.password === "string"
  ) {
    return {
      username: connectionCredentials.username,
      password: connectionCredentials.password,
    };
  }

  return null;
}

function buildRESTBase(siteUrl: string) {
  const normalized = normalizeSiteUrl(siteUrl);
  return `${normalized}/index.php?rest_route=/wp/v2`;
}

function buildRESTEndpoint(siteUrl: string, route: string, params?: URLSearchParams) {
  const endpoint = new URL(buildRESTBase(siteUrl));
  const normalizedRoute = route.startsWith("/") ? route : `/${route}`;
  endpoint.searchParams.set("rest_route", `/wp/v2${normalizedRoute}`);

  if (params) {
    for (const [key, value] of params.entries()) {
      endpoint.searchParams.set(key, value);
    }
  }

  return endpoint.toString();
}

function extractRenderedText(value?: { raw?: string; rendered?: string }) {
  return value?.raw?.trim() || value?.rendered?.trim() || "";
}

export function getWordPressAPISettings() {
  const settings = readSettings();
  return {
    instances: Array.isArray(settings.instances)
      ? settings.instances
          .map((instance) => ({
            id: String(instance.id ?? ""),
            name: String(instance.name ?? "").trim(),
            siteUrl: normalizeSiteUrl(String(instance.siteUrl ?? "")),
            username: String(instance.username ?? "").trim(),
            applicationPassword: String(instance.applicationPassword ?? "").trim(),
            providerConfigKey: typeof instance.providerConfigKey === "string" ? instance.providerConfigKey.trim() || undefined : undefined,
            connectionId: typeof instance.connectionId === "string" ? instance.connectionId.trim() || undefined : undefined,
            lastValidatedAt: typeof instance.lastValidatedAt === "string" ? instance.lastValidatedAt : undefined,
            createdAt: typeof instance.createdAt === "string" ? instance.createdAt : new Date().toISOString(),
            updatedAt: typeof instance.updatedAt === "string" ? instance.updatedAt : new Date().toISOString(),
            // Optional vendor-scoped blog-connector binding.
            // Persisted as part of the wordpress connector_config JSON blob.
            blogConnectorId: typeof instance.blogConnectorId === "string" ? instance.blogConnectorId.trim() || undefined : undefined,
          }))
          .filter((instance) => instance.id && instance.name && instance.siteUrl && instance.username && instance.applicationPassword)
      : [],
    loggingEnabled: settings.loggingEnabled ?? true,
  } satisfies WordPressAPISettings;
}

export function getWordPressLoggingSettings() {
  const settings = getWordPressAPISettings();
  return {
    enabled: settings.loggingEnabled !== false,
    directory: WORDPRESS_API_LOG_DIRECTORY,
  };
}

export function getWordPressAPIStatus() {
  const settings = getWordPressAPISettings();
  if (settings.instances.length > 0) {
    return {
      status: "connected" as const,
      detail:
        settings.instances.length === 1
          ? "1 WordPress instance is configured."
          : `${settings.instances.length} WordPress instances are configured.`,
    };
  }

  return {
    status: "not_connected" as const,
    detail: "Add one or more WordPress instances to publish blog post drafts.",
  };
}

export function readWordPressInstanceById(instanceId: string) {
  return getWordPressAPISettings().instances.find((instance) => instance.id === instanceId) ?? null;
}

export async function validateWordPressInstanceConnection(input: {
  siteUrl: string;
  username: string;
  applicationPassword: string;
}) {
  const siteUrl = normalizeSiteUrl(input.siteUrl);
  const authHeader = buildAuthHeader({
    username: input.username,
    applicationPassword: input.applicationPassword,
  });

  await writeWordPressLogFile({
    label: "wordpress-users-me",
    kind: "request",
    body: {
      endpoint: buildRESTEndpoint(siteUrl, "/users/me", new URLSearchParams({ context: "edit" })),
      method: "GET",
      siteUrl,
      username: input.username,
    },
  });
  const userResponse = await fetch(buildRESTEndpoint(siteUrl, "/users/me", new URLSearchParams({ context: "edit" })), {
    method: "GET",
    headers: {
      Authorization: authHeader,
      Accept: "application/json",
    },
    cache: "no-store",
  });

  const userPayload = (await userResponse.json().catch(() => null)) as { name?: string; error?: { message?: string }; message?: string } | null;
  await writeWordPressLogFile({
    label: "wordpress-users-me",
    kind: "response",
    body: {
      status: userResponse.status,
      body: userPayload,
    },
  });
  if (!userResponse.ok) {
    const code =
      userPayload && typeof userPayload === "object" && "code" in userPayload && typeof userPayload.code === "string"
        ? userPayload.code
        : undefined;

    if (userResponse.status === 401 && code === "rest_not_logged_in") {
      throw new Error(
        "Nango connected successfully, but WordPress rejected the authenticated API request. Check that the WordPress username and application password are correct and that the server forwards the Authorization header to WordPress.",
      );
    }

    throw new Error(userPayload?.message || userPayload?.error?.message || "Unable to validate the WordPress connection.");
  }

  await writeWordPressLogFile({
    label: "wordpress-administration",
    kind: "request",
    body: {
      endpoint: buildRESTEndpoint(siteUrl, "/administration"),
      method: "GET",
      siteUrl,
      username: input.username,
    },
  });
  const settingsResponse = await fetch(buildRESTEndpoint(siteUrl, "/administration"), {
    method: "GET",
    headers: {
      Authorization: authHeader,
      Accept: "application/json",
    },
    cache: "no-store",
  });

  const settingsPayload = (await settingsResponse.json().catch(() => null)) as { title?: string; error?: { message?: string }; message?: string } | null;
  await writeWordPressLogFile({
    label: "wordpress-administration",
    kind: "response",
    body: {
      status: settingsResponse.status,
      body: settingsPayload,
    },
  });
  if (!settingsResponse.ok) {
    throw new Error(settingsPayload?.message || settingsPayload?.error?.message || "Unable to retrieve the WordPress site title.");
  }

  return {
    siteUrl,
    detectedSiteTitle:
      typeof settingsPayload?.title === "string" && settingsPayload.title.trim() ? settingsPayload.title.trim() : undefined,
    detectedUserName: typeof userPayload?.name === "string" && userPayload.name.trim() ? userPayload.name.trim() : undefined,
  };
}

export async function saveWordPressInstance(input: {
  id?: string;
  siteUrl: string;
  username: string;
  applicationPassword?: string;
  /**
   * Optional override for the site-specific blog-connector binding. When
   * omitted, the existing instance's value is preserved (the
   * field round-trips through edit-save without callers having to re-pass it).
   */
  blogConnectorId?: string;
}) {
  const current = getWordPressAPISettings();
  const existing = input.id ? current.instances.find((instance) => instance.id === input.id) : null;
  const applicationPassword = input.applicationPassword?.trim() || existing?.applicationPassword || "";

  if (!applicationPassword) {
    throw new Error("Enter an application password to continue.");
  }

  const validated = await validateWordPressInstanceConnection({
    siteUrl: input.siteUrl,
    username: input.username.trim(),
    applicationPassword,
  });

  const timestamp = new Date().toISOString();
  const instanceId = input.id?.trim() || crypto.randomUUID();
  const nextBlogConnectorId =
    input.blogConnectorId !== undefined
      ? (input.blogConnectorId.trim() || undefined)
      : existing?.blogConnectorId;
  const nextInstance: WordPressInstanceSettings = {
    id: instanceId,
    name: validated.detectedSiteTitle || validated.siteUrl,
    siteUrl: validated.siteUrl,
    username: input.username.trim(),
    applicationPassword,
    providerConfigKey: existing?.providerConfigKey ?? CINATRA_NANGO_PROVIDER_CONFIG_KEYS.wordpress,
    connectionId: existing?.connectionId ?? instanceId,
    lastValidatedAt: timestamp,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
    // Preserve site-specific blog-connector binding across edit-save (when
    // caller doesn't pass an override, inherit from existing). Without this,
    // the JSON-blob save path would silently drop the field on every edit.
    blogConnectorId: nextBlogConnectorId,
  };

  writeSettings({
    loggingEnabled: current.loggingEnabled ?? true,
    instances: existing
      ? current.instances.map((instance) => (instance.id === nextInstance.id ? nextInstance : instance))
      : [nextInstance, ...current.instances],
  });

  await syncWordPressInstanceToNango(nextInstance).catch(() => null);

  return nextInstance;
}

export async function saveWordPressInstanceFromNangoConnection(input: {
  siteUrl: string;
  providerConfigKey: string;
  connectionId: string;
}) {
  const credentials = await resolveWordPressNangoCredentials(input.providerConfigKey, input.connectionId);

  if (!credentials) {
    throw new Error("Unable to load the WordPress credentials from Nango.");
  }

  const current = getWordPressAPISettings();
  const existing = current.instances.find((instance) => instance.connectionId === input.connectionId);
  const validated = await validateWordPressInstanceConnection({
    siteUrl: input.siteUrl,
    username: credentials.username,
    applicationPassword: credentials.password,
  });
  const timestamp = new Date().toISOString();
  const nextInstance: WordPressInstanceSettings = {
    id: existing?.id ?? crypto.randomUUID(),
    name: validated.detectedSiteTitle || validated.siteUrl,
    siteUrl: validated.siteUrl,
    username: credentials.username,
    applicationPassword: credentials.password,
    providerConfigKey: input.providerConfigKey,
    connectionId: input.connectionId,
    lastValidatedAt: timestamp,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
    // Nango re-save path NEVER receives blogConnectorId (Nango knows nothing
    // about Cinatra's connector bindings). Preserve the existing value
    // unconditionally; otherwise a disconnect→reconnect flow would silently
    // drop the operator's site-connector binding and re-route the live site to
    // the generic path.
    blogConnectorId: existing?.blogConnectorId,
  };

  writeSettings({
    loggingEnabled: current.loggingEnabled ?? true,
    instances: existing
      ? current.instances.map((instance) => (instance.id === nextInstance.id ? nextInstance : instance))
      : [nextInstance, ...current.instances.filter((instance) => instance.siteUrl !== nextInstance.siteUrl)],
  });

  return nextInstance;
}

export async function deleteWordPressInstance(instanceId: string) {
  const current = getWordPressAPISettings();
  const existing = current.instances.find((instance) => instance.id === instanceId);
  if (existing?.providerConfigKey && existing.connectionId) {
    await deleteNangoConnection(existing.providerConfigKey, existing.connectionId);
  }
  writeSettings({
    loggingEnabled: current.loggingEnabled ?? true,
    instances: current.instances.filter((instance) => instance.id !== instanceId),
  });
}

/**
 * Focused setter for the per-instance blog-connector binding. The full
 * `saveWordPressInstance` requires the
 * application password (and re-validates the connection over the network),
 * so the WordPress connection UI's connector-selector cannot reuse it.
 * This writes the `connector_config:wordpress` blob DIRECTLY (same
 * lossless JSON-blob storage; no schema migration, no network call).
 * Pass `connectorId === ""` (or "default") to clear the binding back to
 * the generic path.
 */
export function setWordPressInstanceBlogConnector(
  instanceId: string,
  connectorId: string,
): void {
  const current = getWordPressAPISettings();
  const normalized = connectorId.trim();
  const next =
    normalized && normalized !== "default" ? normalized : undefined;
  let found = false;
  const instances = current.instances.map((instance) => {
    if (instance.id !== instanceId) return instance;
    found = true;
    return { ...instance, blogConnectorId: next };
  });
  if (!found) {
    throw new Error(`WordPress instance "${instanceId}" not found.`);
  }
  writeSettings({
    loggingEnabled: current.loggingEnabled ?? true,
    instances,
  });
}

export async function saveWordPressLoggingSettings(enabled: boolean) {
  writeSettings({
    ...readSettings(),
    loggingEnabled: enabled,
  });
}

export async function listWordPressInstances() {
  return getWordPressAPISettings().instances.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function readLatestPublishedWordPressPost(instance: WordPressInstanceSettings) {
  const auth = await resolveWordPressBasicAuth(instance);
  const params = new URLSearchParams({
    context: "edit",
    status: "publish",
    per_page: "1",
    orderby: "date",
    order: "desc",
  });
  await writeWordPressLogFile({
    label: "wordpress-latest-post",
    kind: "request",
    body: {
      endpoint: buildRESTEndpoint(instance.siteUrl, "/posts", params),
      method: "GET",
      siteUrl: instance.siteUrl,
      username: auth.username,
    },
  });
  const response = await fetch(buildRESTEndpoint(instance.siteUrl, "/posts", params), {
    method: "GET",
    headers: {
      Authorization: auth.authHeader,
      Accept: "application/json",
    },
    cache: "no-store",
  });

  const payload = (await response.json().catch(() => null)) as Array<WordPressPostRecord> | { message?: string } | null;
  await writeWordPressLogFile({
    label: "wordpress-latest-post",
    kind: "response",
    body: {
      status: response.status,
      body: payload,
    },
  });
  if (!response.ok) {
    const message = !Array.isArray(payload) && payload?.message ? payload.message : "Unable to load the latest published WordPress post.";
    throw new Error(message);
  }

  const post = Array.isArray(payload) ? payload[0] : undefined;
  if (!post) {
    return null;
  }

  return {
    apiResponse: post,
    writableTemplate: buildWritableWordPressPostPayload(post),
  };
}

// ---------------------------------------------------------------------------
// List published posts — metadata-only, cursor-paginated
// ---------------------------------------------------------------------------

export type WordPressPostListItem = {
  id: number;
  title: string;
  status: string;
  date: string;
  url: string;
};

export async function listPublishedWordPressPosts(
  instance: WordPressInstanceSettings,
  options: { offset?: number; limit?: number } = {},
): Promise<{ items: WordPressPostListItem[]; total: number }> {
  const auth = await resolveWordPressBasicAuth(instance);
  const limit = Math.max(1, Math.min(100, options.limit ?? 10));
  const offset = Math.max(0, options.offset ?? 0);
  const params = new URLSearchParams({
    context: "edit",
    status: "publish",
    per_page: String(limit),
    offset: String(offset),
    orderby: "date",
    order: "desc",
    _fields: "id,title,status,date,link",
  });
  await writeWordPressLogFile({
    label: "wordpress-posts-list",
    kind: "request",
    body: {
      endpoint: buildRESTEndpoint(instance.siteUrl, "/posts", params),
      method: "GET",
      siteUrl: instance.siteUrl,
      username: auth.username,
      offset,
      limit,
    },
  });
  const response = await fetch(buildRESTEndpoint(instance.siteUrl, "/posts", params), {
    method: "GET",
    headers: {
      Authorization: auth.authHeader,
      Accept: "application/json",
    },
    cache: "no-store",
  });

  const payload = (await response.json().catch(() => null)) as Array<WordPressPostRecord> | { message?: string } | null;
  const totalHeader = response.headers.get("x-wp-total");
  const total = totalHeader ? parseInt(totalHeader, 10) : 0;
  await writeWordPressLogFile({
    label: "wordpress-posts-list",
    kind: "response",
    body: { status: response.status, total, count: Array.isArray(payload) ? payload.length : 0 },
  });
  if (!response.ok) {
    const message = !Array.isArray(payload) && payload?.message
      ? payload.message
      : "Unable to list WordPress posts.";
    throw new Error(message);
  }

  const rows = Array.isArray(payload) ? payload : [];
  const items: WordPressPostListItem[] = rows.map((post) => ({
    id: typeof post.id === "number" ? post.id : 0,
    title: extractRenderedText(post.title),
    status: typeof post.status === "string" ? post.status : "publish",
    date: typeof post.date === "string" ? post.date : "",
    url: typeof post.link === "string" ? post.link : "",
  }));
  return { items, total: Number.isFinite(total) ? total : items.length };
}

function buildWritableWordPressPostPayload(post?: WordPressPostRecord | null): WordPressWritablePostPayload {
  return {
    title: extractRenderedText(post?.title),
    content: extractRenderedText(post?.content),
    excerpt: extractRenderedText(post?.excerpt),
    status: "draft",
    slug: typeof post?.slug === "string" && post.slug.trim() ? post.slug : undefined,
    author: typeof post?.author === "number" ? post.author : undefined,
    comment_status: post?.comment_status,
    ping_status: post?.ping_status,
    format: typeof post?.format === "string" && post.format.trim() ? post.format : undefined,
    sticky: typeof post?.sticky === "boolean" ? post.sticky : undefined,
    template: typeof post?.template === "string" && post.template.trim() ? post.template : undefined,
    categories: Array.isArray(post?.categories) ? post.categories.filter((value): value is number => typeof value === "number") : undefined,
    tags: Array.isArray(post?.tags) ? post.tags.filter((value): value is number => typeof value === "number") : undefined,
    meta: post?.meta && typeof post.meta === "object" ? post.meta : undefined,
    featured_media: typeof post?.featured_media === "number" ? post.featured_media : undefined,
  };
}

function buildCreateDraftPayload(payload: WordPressWritablePostPayload): WordPressCreateDraftPayload {
  return {
    title: payload.title,
    content: payload.content,
    excerpt: payload.excerpt,
    status: "draft",
    featured_media: typeof payload.featured_media === "number" ? payload.featured_media : undefined,
  };
}

export async function createWordPressDraft(input: {
  instance: WordPressInstanceSettings;
  payload: WordPressWritablePostPayload;
}) {
  const auth = await resolveWordPressBasicAuth(input.instance);
  const createPayload = buildCreateDraftPayload(input.payload);
  await writeWordPressLogFile({
    label: "wordpress-create-draft",
    kind: "request",
    body: {
      endpoint: buildRESTEndpoint(input.instance.siteUrl, "/posts"),
      method: "POST",
      siteUrl: input.instance.siteUrl,
      username: auth.username,
      body: createPayload,
    },
  });
  const response = await fetch(buildRESTEndpoint(input.instance.siteUrl, "/posts"), {
    method: "POST",
    headers: {
      Authorization: auth.authHeader,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(createPayload),
    cache: "no-store",
  });

  const payload = (await response.json().catch(() => null)) as { id?: number; link?: string; message?: string } | null;
  await writeWordPressLogFile({
    label: "wordpress-create-draft",
    kind: "response",
    body: {
      status: response.status,
      body: payload,
    },
  });
  if (!response.ok || !payload?.id) {
    throw new Error(payload?.message || "Unable to create the WordPress draft.");
  }

  return {
    wordpressPostId: payload.id,
    publicUrl: payload.link,
    adminUrl: `${normalizeSiteUrl(input.instance.siteUrl)}/wp-admin/post.php?post=${payload.id}&action=edit`,
  };
}

export async function readWordPressPostStatus(input: {
  instance: WordPressInstanceSettings;
  wordpressPostId: number;
}) {
  const auth = await resolveWordPressBasicAuth(input.instance);
  await writeWordPressLogFile({
    label: "wordpress-post-status",
    kind: "request",
    body: {
      endpoint: buildRESTEndpoint(input.instance.siteUrl, `/posts/${input.wordpressPostId}`, new URLSearchParams({ context: "edit" })),
      method: "GET",
      siteUrl: input.instance.siteUrl,
      username: auth.username,
    },
  });

  const response = await fetch(
    buildRESTEndpoint(input.instance.siteUrl, `/posts/${input.wordpressPostId}`, new URLSearchParams({ context: "edit" })),
    {
      method: "GET",
      headers: {
        Authorization: auth.authHeader,
        Accept: "application/json",
      },
      cache: "no-store",
    },
  );

  const payload = (await response.json().catch(() => null)) as (WordPressPostRecord & { message?: string; code?: string }) | null;
  await writeWordPressLogFile({
    label: "wordpress-post-status",
    kind: "response",
    body: {
      status: response.status,
      body: payload,
    },
  });

  if (response.status === 404 || payload?.code === "rest_post_invalid_id") {
    return {
      id: input.wordpressPostId,
      status: "deleted",
      adminUrl: `${normalizeSiteUrl(input.instance.siteUrl)}/wp-admin/post.php?post=${input.wordpressPostId}&action=edit`,
      publicUrl: undefined,
    } satisfies WordPressPostStatusRecord;
  }

  if (!response.ok || !payload?.id) {
    throw new Error(payload?.message || "Unable to check the WordPress post status.");
  }

  return {
    id: payload.id,
    status: typeof payload.status === "string" && payload.status.trim() ? payload.status : "unknown",
    adminUrl: `${normalizeSiteUrl(input.instance.siteUrl)}/wp-admin/post.php?post=${payload.id}&action=edit`,
    publicUrl: payload.status === "publish" && typeof payload.link === "string" && payload.link.trim() ? payload.link : undefined,
  } satisfies WordPressPostStatusRecord;
}

export async function deleteWordPressPost(input: {
  instance: WordPressInstanceSettings;
  wordpressPostId: number;
}) {
  const auth = await resolveWordPressBasicAuth(input.instance);
  await writeWordPressLogFile({
    label: "wordpress-delete-post",
    kind: "request",
    body: {
      endpoint: buildRESTEndpoint(input.instance.siteUrl, `/posts/${input.wordpressPostId}`),
      method: "DELETE",
      siteUrl: input.instance.siteUrl,
      username: auth.username,
    },
  });

  const response = await fetch(buildRESTEndpoint(input.instance.siteUrl, `/posts/${input.wordpressPostId}`), {
    method: "DELETE",
    headers: {
      Authorization: auth.authHeader,
      Accept: "application/json",
    },
    cache: "no-store",
  });

  const payload = (await response.json().catch(() => null)) as { deleted?: boolean; previous?: WordPressPostRecord; message?: string } | null;
  await writeWordPressLogFile({
    label: "wordpress-delete-post",
    kind: "response",
    body: {
      status: response.status,
      body: payload,
    },
  });

  if (!response.ok) {
    throw new Error(payload?.message || "Unable to delete the WordPress post.");
  }

  return {
    deleted: payload?.deleted === true,
    previousStatus: typeof payload?.previous?.status === "string" ? payload.previous.status : undefined,
  };
}

export async function updateWordPressDraftMeta(input: {
  instance: WordPressInstanceSettings;
  wordpressPostId: number;
  meta: Record<string, unknown>;
}) {
  const auth = await resolveWordPressBasicAuth(input.instance);
  await writeWordPressLogFile({
    label: "wordpress-update-draft-meta",
    kind: "request",
    body: {
      endpoint: buildRESTEndpoint(input.instance.siteUrl, `/posts/${input.wordpressPostId}`),
      method: "POST",
      siteUrl: input.instance.siteUrl,
      username: auth.username,
      body: {
        meta: input.meta,
      },
    },
  });

  const response = await fetch(buildRESTEndpoint(input.instance.siteUrl, `/posts/${input.wordpressPostId}`), {
    method: "POST",
    headers: {
      Authorization: auth.authHeader,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      meta: input.meta,
    }),
    cache: "no-store",
  });

  const payload = (await response.json().catch(() => null)) as { id?: number; message?: string } | null;
  await writeWordPressLogFile({
    label: "wordpress-update-draft-meta",
    kind: "response",
    body: {
      status: response.status,
      body: payload,
    },
  });

  if (!response.ok || !payload?.id) {
    throw new Error(payload?.message || "Unable to update the WordPress draft template metadata.");
  }

  return payload;
}

/**
 * Top-level WordPress post update.
 *
 * Unlike updateWordPressDraftMeta (which only POSTs `{ meta }`), this helper
 * forwards top-level fields (title, content, excerpt, status, meta) to the
 * WordPress REST API. Required by the wordpress_post_update MCP primitive
 * which the wordpress-content-editor SKILL.md uses for the demote-then-edit
 * pattern.
 *
 * Only the fields present in `input.fields` are sent; undefined fields are
 * stripped so WordPress does not overwrite existing values with empty strings.
 */
export async function updateWordPressPost(input: {
  instance: WordPressInstanceSettings;
  wordpressPostId: number;
  postType?: string;
  fields: {
    title?: string;
    content?: string;
    excerpt?: string;
    status?: "publish" | "future" | "draft" | "pending" | "private";
    meta?: Record<string, unknown>;
  };
}) {
  const auth = await resolveWordPressBasicAuth(input.instance);

  // Strip undefined fields so WordPress only updates what the caller specified.
  // Also guard content/excerpt against empty strings — WordPress applies them
  // literally and would wipe the body if an LLM passes content:"" for a field
  // it wasn't asked to change.
  const body: Record<string, unknown> = {};
  if (typeof input.fields.title === "string") body.title = input.fields.title;
  if (typeof input.fields.content === "string" && input.fields.content.length > 0) body.content = input.fields.content;
  if (typeof input.fields.excerpt === "string" && input.fields.excerpt.length > 0) body.excerpt = input.fields.excerpt;
  if (typeof input.fields.status === "string") body.status = input.fields.status;
  if (input.fields.meta && typeof input.fields.meta === "object") body.meta = input.fields.meta;

  // Use the correct REST route for the post type (pages live under /pages/, not /posts/).
  const restPath = input.postType === "page"
    ? `/pages/${input.wordpressPostId}`
    : `/posts/${input.wordpressPostId}`;

  await writeWordPressLogFile({
    label: "wordpress-update-post",
    kind: "request",
    body: {
      endpoint: buildRESTEndpoint(input.instance.siteUrl, restPath),
      method: "POST",
      siteUrl: input.instance.siteUrl,
      username: auth.username,
      body,
    },
  });

  const response = await fetch(buildRESTEndpoint(input.instance.siteUrl, restPath), {
    method: "POST",
    headers: {
      Authorization: auth.authHeader,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });

  const payload = (await response.json().catch(() => null)) as
    | (WordPressPostRecord & { message?: string })
    | null;
  await writeWordPressLogFile({
    label: "wordpress-update-post",
    kind: "response",
    body: {
      status: response.status,
      body: payload,
    },
  });

  if (!response.ok || !payload?.id) {
    throw new Error(payload?.message || "Unable to update the WordPress post.");
  }

  return {
    id: payload.id,
    status: typeof payload.status === "string" && payload.status.trim() ? payload.status : "unknown",
    title: payload.title?.rendered ?? payload.title?.raw ?? "",
    content: payload.content?.rendered ?? payload.content?.raw ?? "",
    excerpt: payload.excerpt?.rendered ?? payload.excerpt?.raw ?? "",
    adminUrl: `${normalizeSiteUrl(input.instance.siteUrl)}/wp-admin/post.php?post=${payload.id}&action=edit`,
  };
}

export async function readWordPressPost(input: {
  instance: WordPressInstanceSettings;
  wordpressPostId: number;
  postType?: string;
}) {
  const auth = await resolveWordPressBasicAuth(input.instance);
  // Use the correct REST route for the post type (pages live under /pages/, not /posts/).
  const restPath = input.postType === "page"
    ? `/pages/${input.wordpressPostId}`
    : `/posts/${input.wordpressPostId}`;
  const response = await fetch(
    buildRESTEndpoint(input.instance.siteUrl, restPath, new URLSearchParams({ context: "edit" })),
    {
      method: "GET",
      headers: {
        Authorization: auth.authHeader,
        Accept: "application/json",
      },
      cache: "no-store",
    },
  );

  const payload = (await response.json().catch(() => null)) as (WordPressPostRecord & { message?: string; code?: string }) | null;

  if (response.status === 404 || payload?.code === "rest_post_invalid_id") {
    throw new Error(`WordPress post ${input.wordpressPostId} not found.`);
  }
  if (!response.ok || !payload?.id) {
    throw new Error(payload?.message || "Unable to read the WordPress post.");
  }

  return {
    id: payload.id,
    status: payload.status ?? "unknown",
    title: payload.title?.rendered ?? payload.title?.raw ?? "",
    content: payload.content?.raw ?? payload.content?.rendered ?? "",
    excerpt: payload.excerpt?.rendered ?? payload.excerpt?.raw ?? "",
    slug: payload.slug,
    link: payload.link,
    featured_media: payload.featured_media,
    categories: payload.categories,
    tags: payload.tags,
    adminUrl: `${normalizeSiteUrl(input.instance.siteUrl)}/wp-admin/post.php?post=${payload.id}&action=edit`,
  };
}

function inferFileExtension(mimeType: string) {
  switch (mimeType) {
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    default:
      return "jpg";
  }
}

export async function uploadWordPressMedia(input: {
  instance: WordPressInstanceSettings;
  imageBase64: string;
  imageMimeType: string;
  title: string;
}) {
  const auth = await resolveWordPressBasicAuth(input.instance);
  const filenameBase = input.title.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "blog-post-image";
  const filename = `${filenameBase}.${inferFileExtension(input.imageMimeType)}`;
  await writeWordPressLogFile({
    label: "wordpress-upload-media",
    kind: "request",
    body: {
      endpoint: buildRESTEndpoint(input.instance.siteUrl, "/media"),
      method: "POST",
      siteUrl: input.instance.siteUrl,
      username: auth.username,
      fileName: filename,
      mimeType: input.imageMimeType,
    },
  });
  const response = await fetch(buildRESTEndpoint(input.instance.siteUrl, "/media"), {
    method: "POST",
    headers: {
      Authorization: auth.authHeader,
      "Content-Type": input.imageMimeType,
      "Content-Disposition": `attachment; filename="${filename}"`,
      Accept: "application/json",
    },
    body: Buffer.from(input.imageBase64, "base64"),
    cache: "no-store",
  });

  const payload = (await response.json().catch(() => null)) as { id?: number; source_url?: string; message?: string } | null;
  await writeWordPressLogFile({
    label: "wordpress-upload-media",
    kind: "response",
    body: {
      status: response.status,
      body: payload,
    },
  });
  if (!response.ok || !payload?.id) {
    throw new Error(payload?.message || "Unable to upload the featured image to WordPress.");
  }

  return {
    mediaId: payload.id,
    sourceUrl: payload.source_url,
  };
}

async function syncWordPressInstanceToNango(instance: WordPressInstanceSettings) {
  if (!isNangoConfigured()) {
    return;
  }

  await ensureNangoIntegration({
    provider: "private-api-basic",
    providerConfigKey: instance.providerConfigKey ?? CINATRA_NANGO_PROVIDER_CONFIG_KEYS.wordpress,
    displayName: "WordPress API",
  });

  await importNangoConnection({
    connectorKey: "wordpress",
    providerConfigKey: instance.providerConfigKey ?? CINATRA_NANGO_PROVIDER_CONFIG_KEYS.wordpress,
    connectionId: instance.connectionId ?? instance.id,
    credentials: {
      type: "BASIC",
      username: instance.username,
      password: instance.applicationPassword,
    },
    metadata: {
      siteUrl: instance.siteUrl,
    },
    endUser: {
      id: instance.id,
      display_name: instance.name,
    },
    tags: {
      site_url: instance.siteUrl,
    },
  });
}

// ---------------------------------------------------------------------------
// cinatra/v1/webhooks subscription client
// Uses DIRECT Basic auth (instance.username + instance.applicationPassword),
// NOT resolveWordPressBasicAuth(), because this must work in environments
// without Nango configured.
// URL form uses index.php?rest_route= so it works without pretty permalinks
// (Pitfall 3).
// ---------------------------------------------------------------------------

export type WordPressWebhookSubscription = {
  id: string;
  event_type: string;
  target_url: string;
  post_types: string[];
  created_at: string;
};

// Builds the endpoint URL in index.php?rest_route=/cinatra/v1/webhooks form
// (and /cinatra/v1/webhooks/{id} for single subscriptions) so it works on
// WordPress sites without pretty permalinks enabled.
function buildCinatraWebhooksEndpoint(siteUrl: string, subscriptionId?: string) {
  const normalized = normalizeSiteUrl(siteUrl);
  const route = subscriptionId
    ? `/cinatra/v1/webhooks/${encodeURIComponent(subscriptionId)}`
    : `/cinatra/v1/webhooks`;
  return `${normalized}/index.php?rest_route=${route}`;
}

function buildDirectBasicAuthHeader(
  instance: Pick<WordPressInstanceSettings, "username" | "applicationPassword">,
) {
  return `Basic ${Buffer.from(`${instance.username}:${instance.applicationPassword}`).toString("base64")}`;
}

export async function listWordPressWebhookSubscriptions(
  instance: Pick<WordPressInstanceSettings, "siteUrl" | "username" | "applicationPassword">,
): Promise<WordPressWebhookSubscription[]> {
  const endpoint = buildCinatraWebhooksEndpoint(instance.siteUrl);
  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      Authorization: buildDirectBasicAuthHeader(instance),
      Accept: "application/json",
    },
    cache: "no-store",
  });

  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload && typeof (payload as { error: unknown }).error === "string"
        ? (payload as { error: string }).error
        : `WordPress returned HTTP ${response.status} while listing webhook subscriptions.`;
    throw new Error(message);
  }

  if (!Array.isArray(payload)) {
    return [];
  }
  return payload.filter(
    (item): item is WordPressWebhookSubscription =>
      !!item &&
      typeof item === "object" &&
      typeof (item as { id?: unknown }).id === "string" &&
      typeof (item as { event_type?: unknown }).event_type === "string" &&
      typeof (item as { target_url?: unknown }).target_url === "string",
  );
}

export async function registerWordPressWebhookSubscription(
  instance: Pick<WordPressInstanceSettings, "siteUrl" | "username" | "applicationPassword">,
  subscription: {
    event_type: string;
    target_url: string;
    post_types?: string[];
  },
): Promise<WordPressWebhookSubscription> {
  const endpoint = buildCinatraWebhooksEndpoint(instance.siteUrl);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: buildDirectBasicAuthHeader(instance),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      event_type: subscription.event_type,
      target_url: subscription.target_url,
      post_types: subscription.post_types ?? [],
    }),
    cache: "no-store",
  });

  const payload = (await response.json().catch(() => null)) as unknown;

  // 201 = newly created, 409 = already existed — both are "success" from Cinatra's POV.
  if (response.status === 201 || response.status === 409) {
    if (
      payload &&
      typeof payload === "object" &&
      typeof (payload as { id?: unknown }).id === "string"
    ) {
      return payload as WordPressWebhookSubscription;
    }
    throw new Error("WordPress accepted the subscription but returned an unexpected body.");
  }

  const message =
    payload && typeof payload === "object" && "error" in payload && typeof (payload as { error: unknown }).error === "string"
      ? (payload as { error: string }).error
      : `WordPress returned HTTP ${response.status} while registering the webhook subscription.`;
  throw new Error(message);
}

export async function deleteWordPressWebhookSubscription(
  instance: Pick<WordPressInstanceSettings, "siteUrl" | "username" | "applicationPassword">,
  subscriptionId: string,
): Promise<void> {
  const endpoint = buildCinatraWebhooksEndpoint(instance.siteUrl, subscriptionId);
  const response = await fetch(endpoint, {
    method: "DELETE",
    headers: {
      Authorization: buildDirectBasicAuthHeader(instance),
      Accept: "application/json",
    },
    cache: "no-store",
  });

  if (response.status === 404) {
    // Idempotent — treat already-gone as success.
    return;
  }
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as unknown;
    const message =
      payload && typeof payload === "object" && "error" in payload && typeof (payload as { error: unknown }).error === "string"
        ? (payload as { error: string }).error
        : `WordPress returned HTTP ${response.status} while deleting the webhook subscription.`;
    throw new Error(message);
  }
}
