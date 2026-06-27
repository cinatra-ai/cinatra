import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { readConnectorConfigFromDatabase, writeConnectorConfigToDatabase } from "@/lib/database";
import {
  CINATRA_NANGO_PROVIDER_CONFIG_KEYS,
  deleteNangoConnection,
  ensureNangoIntegration,
  getNangoConnection,
  getNangoOAuth2IntegrationCredentials,
  getNangoOAuthCallbackUrl,
  isNangoConfigured,
  listSavedNangoConnections,
  removeNangoConnectionRecord,
} from "@/lib/nango-system";

const LINKEDIN_API_VERSION = "202603";
export const LINKEDIN_API_LOG_DIRECTORY = path.join(process.cwd(), "data", "logs", "linkedin-api");

const LINKEDIN_OAUTH_SCOPES = [
  "openid",
  "profile",
  "email",
  "w_member_social",
].join(" ");

type LinkedInDestination = {
  id: string;
  type: "member" | "organization";
  name: string;
  urn?: string;
};

export type LinkedInAccountConnection = {
  id: string;
  memberId: string;
  name: string;
  email?: string;
  accessToken?: string;
  tokenExpiresAt?: string;
  profileUrl?: string;
  destinations: LinkedInDestination[];
  createdAt: string;
  updatedAt: string;
};

type LinkedInAPISettings = {
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  accounts: LinkedInAccountConnection[];
  loggingEnabled?: boolean;
};

type LinkedInUserInfoResponse = {
  sub?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  email?: string;
  picture?: string;
};

type LinkedInOrganizationAclResponse = {
  elements?: Array<Record<string, unknown>>;
};

type LinkedInOrganizationResponse = {
  localizedName?: string;
  vanityName?: string;
  name?: string;
};

type LinkedInPublishResponse = {
  id?: string;
};

type LinkedInDestinationOption = {
  linkedinAccountId: string;
  linkedinAccountName: string;
  destinationType: "member" | "organization";
  destinationId: string;
  destinationName: string;
  authorUrn: string;
};

function nowIso() {
  return new Date().toISOString();
}

function sanitizeLogLabel(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "linkedin-call"
  );
}

function buildLogTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function isLinkedInLoggingEnabled() {
  return readSettings().loggingEnabled !== false;
}

export async function writeLinkedInLogFile(input: {
  label: string;
  kind: "request" | "response";
  body: unknown;
}) {
  if (!isLinkedInLoggingEnabled()) {
    return;
  }

  await mkdir(LINKEDIN_API_LOG_DIRECTORY, { recursive: true });
  const filename = `${buildLogTimestamp()}__${sanitizeLogLabel(input.label)}__${input.kind}.json`;
  const content = typeof input.body === "string" ? { raw: input.body } : input.body;
  await writeFile(path.join(LINKEDIN_API_LOG_DIRECTORY, filename), JSON.stringify(content, null, 2), "utf8");
}

function normalizeLinkedInRedirectUri(value?: string) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) {
    return "";
  }

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;

  try {
    const url = new URL(withProtocol);
    url.hash = "";
    return url.toString();
  } catch {
    throw new Error("Enter a valid absolute LinkedIn redirect URI, for example http://localhost:3000/api/apps/linkedin/oauth/callback.");
  }
}

function readStoredLinkedInRedirectUri(value?: string) {
  const trimmed = String(value ?? "").trim();
  return trimmed;
}

function readSettings(): LinkedInAPISettings {
  const stored = readConnectorConfigFromDatabase<LinkedInAPISettings>("linkedin", { accounts: [] });
  return {
    clientId: typeof stored.clientId === "string" && stored.clientId.trim() ? stored.clientId.trim() : undefined,
    clientSecret: typeof stored.clientSecret === "string" && stored.clientSecret.trim() ? stored.clientSecret.trim() : undefined,
    redirectUri: readStoredLinkedInRedirectUri(stored.redirectUri),
    accounts: Array.isArray(stored.accounts)
      ? stored.accounts
          .map((account) => ({
            id: String(account.id ?? ""),
            memberId: String(account.memberId ?? ""),
            name: String(account.name ?? "").trim(),
            email: typeof account.email === "string" && account.email.trim() ? account.email.trim() : undefined,
            accessToken: String(account.accessToken ?? "").trim(),
            tokenExpiresAt:
              typeof account.tokenExpiresAt === "string" && account.tokenExpiresAt.trim() ? account.tokenExpiresAt : undefined,
            profileUrl:
              typeof account.profileUrl === "string" && account.profileUrl.trim() ? account.profileUrl.trim() : undefined,
            destinations: Array.isArray(account.destinations)
              ? account.destinations
                  .map(
                    (destination): LinkedInDestination => ({
                      id: String(destination.id ?? ""),
                      type: destination.type === "organization" ? "organization" : "member",
                      name: String(destination.name ?? "").trim(),
                      urn: typeof destination.urn === "string" && destination.urn.trim() ? destination.urn.trim() : undefined,
                    }),
                  )
                  .filter((destination) => destination.id && destination.name)
              : [],
            createdAt: typeof account.createdAt === "string" && account.createdAt.trim() ? account.createdAt : nowIso(),
            updatedAt: typeof account.updatedAt === "string" && account.updatedAt.trim() ? account.updatedAt : nowIso(),
          }))
          .filter((account) => account.id && account.memberId && account.name)
      : [],
    loggingEnabled: stored.loggingEnabled ?? true,
  };
}

function writeSettings(value: LinkedInAPISettings) {
  writeConnectorConfigToDatabase("linkedin", {
    clientId: value.clientId,
    clientSecret: value.clientSecret,
    accounts: value.accounts,
    loggingEnabled: value.loggingEnabled,
    redirectUri: value.redirectUri,
  });
}

function buildLinkedInHeaders(accessToken: string) {
  return {
    Authorization: `Bearer ${accessToken}`,
    "X-Restli-Protocol-Version": "2.0.0",
    "Linkedin-Version": LINKEDIN_API_VERSION,
  };
}

async function fetchLinkedInJson<T>(url: string, accessToken: string) {
  await writeLinkedInLogFile({
    label: "linkedin-api",
    kind: "request",
    body: {
      endpoint: url,
      method: "GET",
    },
  });
  const response = await fetch(url, {
    headers: buildLinkedInHeaders(accessToken),
    cache: "no-store",
  });
  const payload = (await response.json().catch(() => null)) as (T & { message?: string; error_description?: string }) | null;
  await writeLinkedInLogFile({
    label: "linkedin-api",
    kind: "response",
    body: {
      endpoint: url,
      status: response.status,
      body: payload,
    },
  });
  if (!response.ok) {
    throw new Error(payload?.message || payload?.error_description || "LinkedIn API request failed.");
  }
  return payload;
}

async function resolveLinkedInAccessToken(account: LinkedInAccountConnection) {
  if (!isNangoConfigured()) {
    throw new Error("Configure Nango first so LinkedIn API requests can authenticate through Nango.");
  }

  const connection = await getNangoConnection(
    CINATRA_NANGO_PROVIDER_CONFIG_KEYS.linkedin,
    account.id,
    { forceRefresh: true, refreshToken: true },
  );
  const credentials = (connection as {
    credentials?: {
      type?: string;
      access_token?: string;
    };
  } | null)?.credentials;

  if (credentials?.type === "OAUTH2" && typeof credentials.access_token === "string" && credentials.access_token.trim()) {
    return credentials.access_token;
  }

  throw new Error("Unable to load the LinkedIn access token from Nango.");
}

async function readLinkedInUserConnection(input: {
  connectionId: string;
  userId: string;
}) {
  const savedConnection = listSavedNangoConnections("linkedin", {
    scope: "user",
    userId: input.userId,
  }).find((entry) => entry.connectionId === input.connectionId);
  if (!savedConnection) {
    return null;
  }

  const connection = await getNangoConnection(savedConnection.providerConfigKey, savedConnection.connectionId, {
    forceRefresh: true,
    refreshToken: true,
  });
  const credentials = (connection as
    | {
        credentials?: {
          type?: string;
          access_token?: string;
        };
      }
    | null)?.credentials;

  if (credentials?.type !== "OAUTH2" || typeof credentials.access_token !== "string" || !credentials.access_token.trim()) {
    throw new Error("Unable to load the LinkedIn access token from Nango.");
  }

  return {
    accessToken: credentials.access_token,
    savedConnection,
  };
}

function extractOrganizationId(value: unknown) {
  if (typeof value !== "string") {
    return "";
  }
  const match = value.match(/urn:li:organization:(\d+)/i);
  return match?.[1] ?? "";
}

async function listManagedOrganizationDestinations(accessToken: string): Promise<LinkedInDestination[]> {
  try {
    const aclPayload = await fetchLinkedInJson<LinkedInOrganizationAclResponse>(
      "https://api.linkedin.com/v2/organizationAcls?q=roleAssignee",
      accessToken,
    );
    if (!aclPayload) {
      return [];
    }
    const organizationIds = Array.from(
      new Set(
        (aclPayload.elements ?? [])
          .map((entry) =>
            extractOrganizationId(
              (entry.organization as string | undefined) ??
                (entry.organizationalTarget as string | undefined) ??
                (entry.organizationTarget as string | undefined),
            ),
          )
          .filter(Boolean),
      ),
    );

    const organizations = await Promise.all(
      organizationIds.map(async (organizationId) => {
        try {
          const organization = await fetchLinkedInJson<LinkedInOrganizationResponse>(
            `https://api.linkedin.com/v2/organizations/${encodeURIComponent(organizationId)}`,
            accessToken,
          );
          if (!organization) {
            return null;
          }
          const name = organization.localizedName?.trim() || organization.name?.trim() || `Organization ${organizationId}`;
          return {
            id: organizationId,
            type: "organization" as const,
            name,
            urn: `urn:li:organization:${organizationId}`,
          };
        } catch {
          return null;
        }
      }),
    );

    return organizations.filter(Boolean) as LinkedInDestination[];
  } catch {
    return [];
  }
}

type LinkedInOrganizationAuthorizationResponse = {
  status?: Record<string, unknown>;
};

function buildMemberUrn(memberId: string) {
  return `urn:li:person:${memberId}`;
}

function buildOrganizationUrn(organizationId: string) {
  return `urn:li:organization:${organizationId}`;
}

function isLinkedInAuthorizationApproved(payload: LinkedInOrganizationAuthorizationResponse | null) {
  if (!payload?.status || typeof payload.status !== "object") {
    return false;
  }
  return Object.keys(payload.status).some((key) => key === "com.linkedin.organization.Approved");
}

async function memberCanCreateOrganicOrganizationPost(input: {
  accessToken: string;
  memberUrn: string;
  organizationUrn: string;
}) {
  const encodedImpersonator = encodeURIComponent(input.memberUrn);
  const encodedOrganization = encodeURIComponent(input.organizationUrn);
  const url =
    `https://api.linkedin.com/rest/organizationAuthorizations/` +
    `(impersonator:${encodedImpersonator},organization:${encodedOrganization},action:(organizationContentAuthorizationAction:(actionType:ORGANIC_SHARE_CREATE)))`;

  try {
    const payload = await fetchLinkedInJson<LinkedInOrganizationAuthorizationResponse>(url, input.accessToken);
    return isLinkedInAuthorizationApproved(payload);
  } catch {
    return false;
  }
}

async function listAuthorizedOrganizationDestinations(input: {
  accessToken: string;
  memberId: string;
}): Promise<LinkedInDestination[]> {
  const administeredOrganizations = await listManagedOrganizationDestinations(input.accessToken);
  if (administeredOrganizations.length === 0) {
    return [];
  }

  const memberUrn = buildMemberUrn(input.memberId);
  const authorizedOrganizations = await Promise.all(
    administeredOrganizations.map(async (organization) => {
      const organizationUrn = organization.urn ?? buildOrganizationUrn(organization.id);
      const approved = await memberCanCreateOrganicOrganizationPost({
        accessToken: input.accessToken,
        memberUrn,
        organizationUrn,
      });
      return approved
        ? {
            ...organization,
            urn: organizationUrn,
          }
        : null;
    }),
  );

  return authorizedOrganizations.filter(Boolean) as LinkedInDestination[];
}

function isLinkedInConfigured(settings: LinkedInAPISettings) {
  return Boolean(settings.clientId && settings.clientSecret && settings.redirectUri);
}

export async function getLinkedInAPISettings() {
  const stored = readSettings();
  const nangoCredentials = await getNangoOAuth2IntegrationCredentials(CINATRA_NANGO_PROVIDER_CONFIG_KEYS.linkedin);

  return {
    ...stored,
    clientId: nangoCredentials?.clientId || stored.clientId,
    clientSecret: nangoCredentials?.clientSecret || stored.clientSecret,
    redirectUri: stored.redirectUri || normalizeLinkedInRedirectUri(getNangoOAuthCallbackUrl()),
  };
}

export function getLinkedInLoggingSettings() {
  const settings = readSettings();
  return {
    enabled: settings.loggingEnabled !== false,
    directory: LINKEDIN_API_LOG_DIRECTORY,
  };
}

export async function listLinkedInAccounts() {
  return readSettings().accounts.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function readLinkedInAccountById(accountId: string) {
  return (await listLinkedInAccounts()).find((account) => account.id === accountId) ?? null;
}

export async function listLinkedInDestinations(options?: {
  scope?: "app" | "user";
  userId?: string;
}): Promise<LinkedInDestinationOption[]> {
  if (options?.scope === "user") {
    const connections = options.userId
      ? listSavedNangoConnections("linkedin", {
          scope: "user",
          userId: options.userId,
        })
      : listSavedNangoConnections("linkedin").filter((connection) => (connection.scope ?? "app") === "user");

    return connections.map((connection) => {
      const profileName =
        String(connection.displayName ?? "").trim() ||
        String(connection.email ?? "").trim() ||
        "LinkedIn profile";

      return {
        linkedinAccountId: connection.connectionId,
        linkedinAccountName: profileName,
        destinationType: "member" as const,
        destinationId: connection.connectionId,
        destinationName: profileName,
        authorUrn: "",
      };
    });
  }

  const accounts = await listLinkedInAccounts();
  return accounts.flatMap((account) =>
    account.destinations.map((destination) => ({
      linkedinAccountId: account.id,
      linkedinAccountName: account.name,
      destinationType: destination.type,
      destinationId: destination.id,
      destinationName: destination.name,
      authorUrn:
        destination.type === "organization"
          ? destination.urn ?? buildOrganizationUrn(destination.id)
          : destination.urn ?? buildMemberUrn(account.memberId),
    })),
  );
}

export async function getLinkedInAPIStatus() {
  const settings = await getLinkedInAPISettings();
  const nangoConnections = listSavedNangoConnections("linkedin");
  if (nangoConnections.length > 0) {
    return {
      status: "connected" as const,
      detail:
        nangoConnections.length === 1
          ? "1 LinkedIn connection is available."
          : `${nangoConnections.length} LinkedIn connections are available.`,
    };
  }
  if (settings.accounts.length > 0) {
    return {
      status: "connected" as const,
      detail:
        settings.accounts.length === 1
          ? "1 LinkedIn account is connected."
          : `${settings.accounts.length} LinkedIn accounts are connected.`,
    };
  }

  if (isLinkedInConfigured(settings)) {
    return {
      status: "connected" as const,
      detail: "LinkedIn OAuth is configured for Cinatra.",
    };
  }

  return {
    status: "not_connected" as const,
    detail: "Configure LinkedIn OAuth to connect profiles and managed company pages.",
  };
}

export async function saveLinkedInOAuthSettings(input: {
  clientId?: string;
  clientSecret?: string;
}) {
  const current = await getLinkedInAPISettings();
  const normalizedRedirectUri = normalizeLinkedInRedirectUri(getNangoOAuthCallbackUrl());
  const nextSettings: LinkedInAPISettings = {
    ...current,
    clientId: input.clientId?.trim() || current.clientId,
    clientSecret: input.clientSecret?.trim() || current.clientSecret,
    redirectUri: normalizedRedirectUri,
    accounts: current.accounts,
    loggingEnabled: current.loggingEnabled,
  };
  await ensureLinkedInIntegration(nextSettings);
  writeSettings({
    ...nextSettings,
  });
  return nextSettings;
}

async function ensureLinkedInIntegration(settings: LinkedInAPISettings) {
  if (!settings.clientId || !settings.clientSecret) {
    return;
  }

  await ensureNangoIntegration({
    provider: "linkedin",
    providerConfigKey: CINATRA_NANGO_PROVIDER_CONFIG_KEYS.linkedin,
    displayName: "Cinatra LinkedIn",
    credentials: {
      type: "OAUTH2",
      client_id: settings.clientId,
      client_secret: settings.clientSecret,
      scopes: LINKEDIN_OAUTH_SCOPES,
    },
  });
}

export async function saveLinkedInLoggingSettings(enabled: boolean) {
  const current = readSettings();
  writeSettings({
    ...current,
    loggingEnabled: enabled,
  });
}

export async function saveLinkedInAccountFromNangoConnection(input: {
  providerConfigKey: string;
  connectionId: string;
}) {
  const settings = readSettings();
  const connection = await getNangoConnection(input.providerConfigKey, input.connectionId, {
    forceRefresh: true,
    refreshToken: true,
  });
  const credentials = (connection as
    | {
        credentials?: {
          type?: string;
          access_token?: string;
          expires_at?: string | Date;
        };
        end_user?: {
          email?: string;
        };
      }
    | null)?.credentials;

  if (credentials?.type !== "OAUTH2" || typeof credentials.access_token !== "string" || !credentials.access_token.trim()) {
    throw new Error("Unable to load the LinkedIn access token from Nango.");
  }

  const userinfo = await fetchLinkedInJson<LinkedInUserInfoResponse>("https://api.linkedin.com/v2/userinfo", credentials.access_token);
  const memberId = String(userinfo?.sub ?? "").trim();
  const memberName =
    String(userinfo?.name ?? "").trim() ||
    [userinfo?.given_name, userinfo?.family_name].map((value) => String(value ?? "").trim()).filter(Boolean).join(" ");
  if (!memberId || !memberName) {
    throw new Error("Unable to load the LinkedIn member profile.");
  }

  const destinations: LinkedInDestination[] = [
    {
      id: memberId,
      type: "member",
      name: memberName,
    },
    ...(await listAuthorizedOrganizationDestinations({
      accessToken: credentials.access_token,
      memberId,
    })),
  ];

  const updatedAt = nowIso();
  const existing = settings.accounts.find((account) => account.id === input.connectionId || account.memberId === memberId);
  const accountRecord: LinkedInAccountConnection = {
    id: input.connectionId,
    memberId,
    name: memberName,
    email:
      typeof userinfo?.email === "string" && userinfo.email.trim()
        ? userinfo.email.trim()
        : typeof connection?.end_user?.email === "string" && connection.end_user.email.trim()
          ? connection.end_user.email.trim()
          : undefined,
    accessToken: undefined,
    tokenExpiresAt:
      typeof credentials.expires_at === "string"
        ? credentials.expires_at
        : credentials.expires_at instanceof Date
          ? credentials.expires_at.toISOString()
          : undefined,
    profileUrl: undefined,
    destinations,
    createdAt: existing?.createdAt ?? updatedAt,
    updatedAt,
  };

  writeSettings({
    ...settings,
    accounts: [accountRecord, ...settings.accounts.filter((account) => account.id !== input.connectionId && account.memberId !== memberId)],
  });

  return accountRecord;
}

export async function deleteLinkedInAccount(accountId: string) {
  const current = readSettings();
  await deleteNangoConnection(CINATRA_NANGO_PROVIDER_CONFIG_KEYS.linkedin, accountId);
  await removeNangoConnectionRecord("linkedin", accountId);
  writeSettings({
    ...current,
    accounts: current.accounts.filter((account) => account.id !== accountId),
  });
}

function inferLinkedInPostUrl(postUrn: string) {
  return `https://www.linkedin.com/feed/update/${encodeURIComponent(postUrn)}/`;
}

export async function publishLinkedInPost(input: {
  linkedinAccountId: string;
  destinationType: "member" | "organization";
  destinationId: string;
  content: string;
  userId?: string;
}) {
  const account = await readLinkedInAccountById(input.linkedinAccountId);
  let accessToken = "";
  let memberId = "";

  if (account) {
    accessToken = await resolveLinkedInAccessToken(account);
    memberId = account.memberId;
  } else if (input.userId) {
    const userConnection = await readLinkedInUserConnection({
      connectionId: input.linkedinAccountId,
      userId: input.userId,
    });
    if (!userConnection) {
      throw new Error("LinkedIn account not found.");
    }

    accessToken = userConnection.accessToken;
    const userinfo = await fetchLinkedInJson<LinkedInUserInfoResponse>("https://api.linkedin.com/v2/userinfo", accessToken);
    memberId = String(userinfo?.sub ?? "").trim();
    if (!memberId) {
      throw new Error("Unable to load the LinkedIn member profile.");
    }
  } else {
    throw new Error("LinkedIn account not found.");
  }

  const author =
    input.destinationType === "organization"
      ? buildOrganizationUrn(input.destinationId)
      : buildMemberUrn(memberId);

  const endpoint = "https://api.linkedin.com/v2/ugcPosts";
  const body = {
    author,
    lifecycleState: "PUBLISHED",
    specificContent: {
      "com.linkedin.ugc.ShareContent": {
        shareCommentary: {
          text: input.content,
        },
        shareMediaCategory: "NONE",
      },
    },
    visibility: {
      "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC",
    },
  };

  await writeLinkedInLogFile({
    label: "linkedin-publish-post",
    kind: "request",
    body: {
      endpoint,
      method: "POST",
      body,
    },
  });

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      ...buildLinkedInHeaders(accessToken),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });

  const text = await response.text();
  let payload: LinkedInPublishResponse | null = null;
  try {
    payload = text ? (JSON.parse(text) as LinkedInPublishResponse) : null;
  } catch {
    payload = null;
  }

  await writeLinkedInLogFile({
    label: "linkedin-publish-post",
    kind: "response",
    body: {
      status: response.status,
      headers: {
        "x-restli-id": response.headers.get("x-restli-id"),
      },
      body: payload ?? text,
    },
  });

  const postUrn = String(payload?.id ?? response.headers.get("x-restli-id") ?? "").trim();
  if (!response.ok || !postUrn) {
    throw new Error("Unable to publish the post on LinkedIn.");
  }

  return {
    postUrn,
    postUrl: inferLinkedInPostUrl(postUrn),
  };
}
