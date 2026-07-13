import type { ReactNode } from "react";
import { PlugZap } from "lucide-react";
import SiGmail from "@icons-pack/react-simple-icons/icons/SiGmail.mjs";
import SiGooglecalendar from "@icons-pack/react-simple-icons/icons/SiGooglecalendar.mjs";
import SiGoogle from "@icons-pack/react-simple-icons/icons/SiGoogle.mjs";
import SiWordpress from "@icons-pack/react-simple-icons/icons/SiWordpress.mjs";
import SiDrupal from "@icons-pack/react-simple-icons/icons/SiDrupal.mjs";
import SiYoutube from "@icons-pack/react-simple-icons/icons/SiYoutube.mjs";
import SiGooglegemini from "@icons-pack/react-simple-icons/icons/SiGooglegemini.mjs";
import SiAnthropic from "@icons-pack/react-simple-icons/icons/SiAnthropic.mjs";
import SiGithub from "@icons-pack/react-simple-icons/icons/SiGithub.mjs";
import SiPlane from "@icons-pack/react-simple-icons/icons/SiPlane.mjs";
import { FaLinkedin } from "react-icons/fa6";
import { McpIcon } from "@/components/domain-icons";
import { TailscaleLogo } from "@/components/tailscale-logo";

// ---------------------------------------------------------------------------
// Host connector brand-icon map — the SINGLE source of truth (cinatra#1325).
//
// Extracted out of `connectors-client.tsx` into this leaf, React-only module so
// BOTH the `/connectors` grid AND the marketplace extension card resolve a
// connector's brand mark from the SAME map — the root cause of #1325 was the
// two surfaces reading DIFFERENT sources. `/connectors` consumes `iconForSlug`
// (brand mark, else a neutral plug); the marketplace card consumes
// `connectorBrandIcon` (brand mark, else null → the card's own catalog/emblem
// tiers). No React state / hooks here, so it is a plain shared leaf.
//
// Keyed by the connector slug = the scoped npm name minus its scope
// (`@cinatra-ai/youtube-connector` → `youtube-connector`), matching the
// `/connectors` registry slug and `marketplace-card-model.deriveIconSlug`.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Inline icons (vendored — brands without a react-simple-icons / react-icons
// glyph, or an official vendored mark).
// ---------------------------------------------------------------------------

function OpenAIIcon() {
  return (
    <svg width={20} height={20} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d={"M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052" + "v" + "5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855-5.843-3.368L15.116 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.104v-5.678a.79.79 0 0 0-.407-.666zm2.01-3.023-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08-4.778 2.758a.795.795 0 0 0-.393.681zm1.097-2.365 2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z"}/>
    </svg>
  );
}

function ApolloIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
      <circle cx="12" cy="12" r="10" fill="#1B1F3A" />
      <path d="M12 4.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15Zm0 2.5a5 5 0 1 1 0 10A5 5 0 0 1 12 7Z" fill="#6366F1" />
      <circle cx="12" cy="12" r="2.5" fill="#818CF8" />
    </svg>
  );
}

function ApifyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5" aria-hidden="true">
      <path d="M12 3L4 7v5c0 4.4 3.4 8.5 8 9.5 4.6-1 8-5.1 8-9.5V7l-8-4z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function A2AIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5" aria-hidden="true">
      <circle cx="5" cy="12" r="2.5" />
      <circle cx="19" cy="12" r="2.5" />
      <path d="M7.5 12h9M14 9l3 3-3 3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function TwentyIcon() {
  // Official Twenty logo (twentyhq/twenty). Vendored locally — black rounded
  // tile with the white "twenty" mark — rather than hot-linking the GitHub SVG.
  return (
    <svg viewBox="0 0 136 136" className="h-5 w-5" aria-hidden="true">
      <g clipPath="url(#twenty-logo-clip)">
        <path d="M136 2.28882e-05H0L0.000144482 136H136V2.28882e-05ZM27.27 50.6401C27.27 43.2101 33.3 37.1801 40.73 37.1801H66.64C67.02 37.1801 67.37 37.4101 67.53 37.7601C67.69 38.1101 67.62 38.5201 67.36 38.8101L61.68 44.9801C60.69 46.0501 59.3 46.6701 57.84 46.6701H40.8C38.57 46.6701 36.76 48.4801 36.76 50.7101V60.8901C36.76 62.2001 35.7 63.2601 34.39 63.2601H29.65C28.34 63.2601 27.28 62.2001 27.28 60.8901V50.6401H27.27ZM107.88 85.3601C107.88 92.7901 101.85 98.82 94.42 98.82H83.41C75.98 98.82 69.95 92.7901 69.95 85.3601V66.0901C69.95 64.7801 70.44 63.5201 71.33 62.5501L77.75 55.5801C78.02 55.2901 78.44 55.1901 78.82 55.3301C79.19 55.4801 79.44 55.83 79.44 56.23V85.3001C79.44 87.5301 81.25 89.3401 83.48 89.3401H94.36C96.59 89.3401 98.4 87.5301 98.4 85.3001V50.7101C98.4 48.4801 96.59 46.6701 94.36 46.6701H81.71C80.26 46.6701 78.88 47.2801 77.89 48.3401L40.16 89.3401H62.83C64.14 89.3401 65.2 90.4001 65.2 91.7101V96.4501C65.2 97.7601 64.14 98.82 62.83 98.82H32.28C29.51 98.82 27.26 96.5701 27.26 93.8001V91.29C27.26 90.03 27.73 88.8201 28.59 87.8901L70.89 41.9401C73.69 38.9001 77.62 37.1801 81.75 37.1801H94.41C101.84 37.1801 107.87 43.2101 107.87 50.6401V85.3601H107.88Z" fill="black" />
        <path d="M27.27 50.6401C27.27 43.2101 33.3 37.1801 40.73 37.1801H66.64C67.02 37.1801 67.37 37.4101 67.53 37.7601C67.69 38.1101 67.62 38.5201 67.36 38.8101L61.68 44.9801C60.69 46.0501 59.3 46.6701 57.84 46.6701H40.8C38.57 46.6701 36.76 48.4801 36.76 50.7101V60.8901C36.76 62.2001 35.7 63.2601 34.39 63.2601H29.65C28.34 63.2601 27.28 62.2001 27.28 60.8901V50.6401H27.27Z" fill="white" />
        <path d="M107.88 85.3601C107.88 92.7901 101.85 98.82 94.42 98.82H83.41C75.98 98.82 69.95 92.7901 69.95 85.3601V66.0901C69.95 64.7801 70.44 63.5201 71.33 62.5501L77.75 55.5801C78.02 55.2901 78.44 55.1901 78.82 55.3301C79.19 55.4801 79.44 55.83 79.44 56.23V85.3001C79.44 87.5301 81.25 89.3401 83.48 89.3401H94.36C96.59 89.3401 98.4 87.5301 98.4 85.3001V50.7101C98.4 48.4801 96.59 46.6701 94.36 46.6701H81.71C80.26 46.6701 78.88 47.2801 77.89 48.3401L40.16 89.3401H62.83C64.14 89.3401 65.2 90.4001 65.2 91.7101V96.4501C65.2 97.7601 64.14 98.82 62.83 98.82H32.28C29.51 98.82 27.26 96.5701 27.26 93.8001V91.29C27.26 90.03 27.73 88.8201 28.59 87.8901L70.89 41.9401C73.69 38.9001 77.62 37.1801 81.75 37.1801H94.41C101.84 37.1801 107.87 43.2101 107.87 50.6401V85.3601H107.88Z" fill="white" />
      </g>
      <defs>
        <clipPath id="twenty-logo-clip">
          <rect width="136" height="136" rx="16" fill="white" />
        </clipPath>
      </defs>
    </svg>
  );
}

const ICON_BY_SLUG = new Map<string, ReactNode>([
  ["openai-connector", <OpenAIIcon key="openai" />],
  ["anthropic-connector", <SiAnthropic key="anthropic" size={20} color="default" aria-hidden="true" />],
  ["gemini-connector", <SiGooglegemini key="gemini" size={20} color="default" aria-hidden="true" />],
  ["mcp-client-connector", <McpIcon key="mcp-client" className="h-5 w-5" aria-hidden="true" />],
  ["gmail-connector", <SiGmail key="gmail" size={20} color="default" aria-hidden="true" />],
  ["google-calendar-connector", <SiGooglecalendar key="google-calendar" size={20} color="default" aria-hidden="true" />],
  ["apollo-connector", <ApolloIcon key="apollo" />],
  ["apify-connector", <ApifyIcon key="apify" />],
  ["linkedin-connector", <FaLinkedin key="linkedin" size={20} color="#0A66C2" aria-hidden="true" />],
  ["youtube-connector", <SiYoutube key="youtube" size={20} color="default" aria-hidden="true" />],
  ["wordpress-mcp-connector", <SiWordpress key="wordpress" size={20} color="default" aria-hidden="true" />],
  ["drupal-mcp-connector", <SiDrupal key="drupal" size={20} color="default" aria-hidden="true" />],
  ["tailscale-connector", <TailscaleLogo key="tailscale" />],
  ["github-connector", <SiGithub key="github" size={20} color="default" aria-hidden="true" />],
  ["a2a-server-connector", <A2AIcon key="a2a" />],
  ["google-oauth-connector", <SiGoogle key="google-oauth" size={20} color="default" aria-hidden="true" />],
  ["twenty-connector", <TwentyIcon key="twenty" />],
  ["linkedin-oauth-connector", <FaLinkedin key="linkedin-oauth" size={20} color="#0A66C2" aria-hidden="true" />],
  ["mcp-server-connector", <McpIcon key="mcp-server" className="h-5 w-5" aria-hidden="true" />],
  ["plane-connector", <SiPlane key="plane" size={20} color="default" aria-hidden="true" />],
]);

/**
 * The host brand mark for a connector slug, or `null` when the slug has no
 * mapped mark. The marketplace extension card's CLIENT-ICON-MAP tier
 * (cinatra#1325): a null result falls through to the card's own catalog-icon /
 * vendor-logo / kind-emblem tiers rather than a neutral plug (the card owns its
 * own terminal emblem — `/connectors` owns the plug).
 */
export function connectorBrandIcon(slug: string): ReactNode | null {
  return ICON_BY_SLUG.get(slug) ?? null;
}

/**
 * The `/connectors` grid icon for a slug: the mapped brand mark, else a neutral
 * connector plug so a newly-added connector still reads AS a connector until its
 * mark is mapped. (The marketplace card uses `connectorBrandIcon` instead — it
 * has its own emblem tail.)
 */
export function iconForSlug(slug: string): ReactNode {
  return (
    connectorBrandIcon(slug) ?? (
      <PlugZap className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
    )
  );
}
