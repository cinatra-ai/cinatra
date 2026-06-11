export type QuarterAppearance = {
  quarterId: string;
  year: number;
  quarter: string;
  rank: number;
  repoId: string;
  repoName: string;
  repoUrl: string;
  repoLanguage: string;
  starsAtBeginning: number;
  starsAtEnd: number;
  starGrowth: number;
  dateBeginning: string;
  dateEnd: string;
};

export type PropertyValue = string | number | boolean | null;

export type PropertyMap = Record<string, PropertyValue>;

export type PropertyDefinition = {
  name: string;
  label: string;
  type: "string" | "number" | "date" | "datetime" | "enumeration" | "url" | "email" | "phone" | "currency";
};

export type FounderContact = {
  id?: string;
  name: string;
  title?: string;
  agentUrl?: string;
  email?: string;
  linkedinUrl?: string;
  twitterUrl?: string;
  githubUrl?: string;
  facebookUrl?: string;
  isManual?: boolean;
  notes?: string;
  apolloPerson?: Record<string, unknown>;
};

export type CompanyUpdate = {
  kind: "funding" | "acquisition" | "merger" | "product" | "other";
  title: string;
  url?: string;
  source?: string;
  snippet?: string;
  detectedAt?: string;
};

export type Startup = {
  id: string;
  slug: string;
  companyName: string;
  website: string;
  websiteHost: string;
  country?: string;
  city?: string;
  founded?: number;
  raisedMillions?: number | null;
  latestRaisedMillions?: number | null;
  latestGithubStars?: number | null;
  latestGithubFetchedAt?: string;
  latestGithubRepoUrl?: string;
  currentUpdates: CompanyUpdate[];
  summary: string;
  offeringSummary?: string;
  quarterlyReportDescriptions?: string[];
  founderContacts: FounderContact[];
  fallbackContactEmail?: string;
  preferredContactEmail?: string;
  apolloOrganization?: Record<string, unknown>;
  enrichmentNotes: string[];
  enrichmentStatus: "complete" | "partial" | "missing";
  agentUrls: string[];
  appearances: QuarterAppearance[];
  createdAt?: string;
  updatedAt?: string;
  previousVersions?: Array<{
    capturedAt: string;
    companyName: string;
    website: string;
    websiteHost: string;
    country?: string;
    city?: string;
    founded?: number;
    raisedMillions?: number | null;
    latestRaisedMillions?: number | null;
    latestGithubStars?: number | null;
    latestGithubFetchedAt?: string;
    latestGithubRepoUrl?: string;
    currentUpdates: CompanyUpdate[];
    summary: string;
    offeringSummary?: string;
    quarterlyReportDescriptions?: string[];
    founderContacts: FounderContact[];
    fallbackContactEmail?: string;
    preferredContactEmail?: string;
    apolloOrganization?: Record<string, unknown>;
    enrichmentNotes: string[];
    enrichmentStatus: "complete" | "partial" | "missing";
    agentUrls: string[];
    appearances: QuarterAppearance[];
  }>;
};

export type StartupDataset = {
  generatedAt: string;
  source: string;
  startupCount: number;
  startups: Startup[];
};

export type EmailDraft = {
  id: string;
  campaignId?: string;
  startupId: string;
  startupName: string;
  contactName?: string;
  contactEmail?: string;
  subject: string;
  body: string;
  status: "draft" | "approved";
};

export type FollowUpDraft = {
  id: string;
  initialDraftId: string;
  startupId: string;
  startupName: string;
  contactName?: string;
  contactEmail?: string;
  stepNumber: number;
  subject: string;
  body: string;
};

export type ContactNameStyle = "first_name" | "full_name";

export type CampaignTypeCategory = string;
export type OpenAIServiceTier = "default" | "flex" | "priority";

export type AnthropicConnection = {
  apiKey?: string;
  lastValidatedAt?: string;
};

// Generic email transport types live in the SDK
// (`@cinatra-ai/sdk-extensions`, the provider-neutral email contract — the
// email-connector facade re-exports the same types). Re-exported here as a
// back-compat shim so existing `@/lib/types` importers continue to work
// without churn — and so HOST code carries no type edge on the connector
// package (type imports count toward the required-extensions cover gate).
// `EmailConnectorId` is provider-neutral (`string`) in the contract.
// `EmailConnectorStatus` stays here (host-side enum used by
// `InstalledEmailConnectorStatus` UI).
export type {
  EmailConnectorId,
  EmailSystemMessage,
  EmailSendReceipt,
  EmailReplyMatch,
} from "@cinatra-ai/sdk-extensions";

export type EmailConnectorStatus = "connected" | "incomplete" | "not_connected";

export type EmailOutreachDeliveryStatus = "pending" | "sent" | "skipped" | "replied" | "failed";

export type EmailOutreachFollowUpDelivery = {
  draftId: string;
  stepNumber: number;
  subject: string;
  body: string;
  scheduledFor: string;
  sendTime: string;
  status: EmailOutreachDeliveryStatus;
  sentAt?: string;
  providerMessageId?: string;
  providerThreadId?: string;
  internetMessageId?: string;
  replyDetectedAt?: string;
  error?: string;
};

export type EmailOutreachRecipientDelivery = {
  draftId: string;
  startupId: string;
  startupName: string;
  contactName?: string;
  contactEmail: string;
  initial: {
    subject: string;
    body: string;
    status: EmailOutreachDeliveryStatus;
    sentAt?: string;
    providerMessageId?: string;
    providerThreadId?: string;
    internetMessageId?: string;
    error?: string;
  };
  followUps: EmailOutreachFollowUpDelivery[];
};

export type CampaignType = {
  id: string;
  name: string;
  slug: string;
  category: CampaignTypeCategory;
  description: string;
  prompt: string;
  generatedBlueprint?: string;
  builderModel?: string;
  createdAt: string;
  updatedAt: string;
  isSeeded?: boolean;
  defaultProperties: PropertyMap;
  customProperties: PropertyMap;
};

export type Campaign = {
  id: string;
  name: string;
  campaignTypeId: string;
  campaignTypeName?: string;
  kind: CampaignTypeCategory;
  description?: string;
  executionMode?: "workspace" | "drafts";
  workspacePath?: string;
  createdAt: string;
  senderName: string;
  senderEmail: string;
  offeringCompanyName: string;
  offeringCompanyWebsite: string;
  offeringCompanyContext?: string;
  callToAction: string;
  draftingInstructions?: string;
  draftIds: string[];
  defaultProperties: PropertyMap;
  customProperties: PropertyMap;
};

export type CampaignStore = {
  campaignTypes: CampaignType[];
  campaigns: Campaign[];
  drafts: EmailDraft[];
  agentCampaignOverrides?: Record<
    string,
    {
      archived?: boolean;
      defaultProperties?: PropertyMap;
      customProperties?: PropertyMap;
      draftingInstructions?: string;
      updatedAt?: string;
    }
  >;
  openAIConnection?: {
    apiKey?: string;
    projectId?: string;
    organizationId?: string;
    defaultModel?: string;
    serviceTier?: OpenAIServiceTier;
    loggingEnabled?: boolean;
    promptCachingEnabled?: boolean;
    lastValidatedAt?: string;
    availableModels?: string[];
  };
  anthropicConnection?: AnthropicConnection;
};

export type StartupOverride = {
  startupId: string;
  manualContacts: FounderContact[];
  contactOverrides?: Array<{
    id: string;
    name?: string;
    title?: string;
    email?: string;
    linkedinUrl?: string;
    twitterUrl?: string;
    githubUrl?: string;
    facebookUrl?: string;
    archived?: boolean;
    notes?: string;
  }>;
  accountOverride?: {
    companyName?: string;
    website?: string;
    companyEmail?: string;
    city?: string;
    country?: string;
    archived?: boolean;
    notes?: string;
  };
  notes?: string;
  updatedAt: string;
};

export type StartupOverrideStore = {
  overrides: StartupOverride[];
};

// CRM record types are not defined here. CRM records live in Twenty and are
// reached through the `crm_*` MCP facade — see
// `extensions/cinatra-ai/crm-connector/src/contract.ts` for the live
// `CrmAccount` / `CrmContact` / `CrmList` types.
