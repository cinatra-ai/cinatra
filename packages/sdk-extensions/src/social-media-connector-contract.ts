// Shared cross-extension SOCIAL-MEDIA provider contract.
//
// Lives in the SDK (not in `@cinatra-ai/social-media-connector`) so a concrete
// provider — `linkedin-connector`, a future twitter/threads connector — depends
// ONLY on the SDK for these types and never imports the facade package. The
// facade (`publishThroughSocialMediaSystem`, the registry) stays in
// `@cinatra-ai/social-media-connector`; this module is the provider-neutral,
// types-only capability contract behind the `social-post` capability.

/** Provider/connector metadata descriptor — the non-behavioural half. */
export type SocialMediaConnectorDefinition = {
  connectorId: string;
  name: string;
  slug: string;
  description: string;
  settingsHref: string;
  supportsOrganizationPosts?: boolean;
  supportsMemberPosts?: boolean;
};

/** Discriminator for which provider actually published a post. */
export type SocialMediaConnectorId = string;

/** Provider-agnostic outbound post payload. */
export type SocialMediaPost = {
  accountId: string;
  destinationType: "member" | "organization";
  destinationId: string;
  content: string;
};

/** Provider-agnostic publish receipt. */
export type SocialMediaPublishReceipt = {
  providerId: SocialMediaConnectorId;
  providerPostId: string;
  providerPostUrl?: string;
  publishedAt: string;
};

/** Provider-agnostic connection status. */
export type SocialMediaConnectorStatusResult = {
  status: "connected" | "incomplete" | "not_connected";
  accountId?: string;
  detail?: string;
};

/**
 * The capability contract every transport-social-media connector implements.
 * Providers expose a singleton conforming to this shape; the facade registers
 * them, and dependents resolve via the `social-post` capability — without
 * importing the provider package.
 */
export interface SocialMediaConnector {
  readonly definition: SocialMediaConnectorDefinition;
  publish(post: SocialMediaPost, opts?: { userId?: string }): Promise<SocialMediaPublishReceipt>;
  getStatus(opts?: { userId?: string }): Promise<SocialMediaConnectorStatusResult>;
}
