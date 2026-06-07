export const CAMPAIGN_TYPE_OPTIONS = [
  { value: "brand_awareness", label: "Brand Awareness Campaign" },
  { value: "demand_generation", label: "Demand Generation Campaign" },
  { value: "lead_generation", label: "Lead Generation Campaign" },
  { value: "acquisition", label: "Acquisition Campaign" },
  { value: "outbound", label: "Outbound Campaign" },
  { value: "cold_email", label: "Email Outreach" },
  { value: "email", label: "Email Campaign" },
  { value: "drip", label: "Drip Campaign" },
  { value: "nurture", label: "Nurture Campaign" },
  { value: "prospecting", label: "Prospecting Campaign" },
  { value: "account_based_marketing", label: "Account-Based Marketing Campaign" },
  { value: "product_launch", label: "Product Launch Campaign" },
  { value: "go_to_market", label: "Go-to-Market Campaign" },
  { value: "pipeline_acceleration", label: "Pipeline Acceleration Campaign" },
  { value: "conversion", label: "Conversion Campaign" },
  { value: "retargeting", label: "Retargeting Campaign" },
  { value: "engagement", label: "Engagement Campaign" },
  { value: "activation", label: "Activation Campaign" },
  { value: "onboarding", label: "Onboarding Campaign" },
  { value: "adoption", label: "Adoption Campaign" },
  { value: "expansion", label: "Expansion Campaign" },
  { value: "retention", label: "Retention Campaign" },
  { value: "re_engagement", label: "Re-Engagement Campaign" },
  { value: "customer_advocacy", label: "Customer Advocacy Campaign" },
  { value: "event", label: "Event Campaign" },
  { value: "content", label: "Content Campaign" },
  { value: "social_media", label: "Social Media Campaign" },
  { value: "paid_media", label: "Paid Media Campaign" },
  { value: "performance_marketing", label: "Performance Marketing Campaign" },
] as const;

export const CAMPAIGN_TYPE_VALUES = CAMPAIGN_TYPE_OPTIONS.map((option) => option.value);
export const CAMPAIGN_STATUS_OPTIONS = [
  { value: "planned", label: "Planned" },
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
  { value: "completed", label: "Completed" },
] as const;

const campaignTypeLabelMap = new Map<string, string>(
  CAMPAIGN_TYPE_OPTIONS.map((option) => [option.value, option.label] as const),
);

export function formatCampaignTypeCategory(category: string) {
  return campaignTypeLabelMap.get(category) ?? category.replaceAll("_", " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export function isProspectingCategory(category: string) {
  return category === "prospecting" || category === "account_based_marketing";
}

export function isOutreachCategory(category: string) {
  return ["cold_email", "outbound", "email", "drip", "nurture"].includes(category);
}

export function inferCampaignTypeHeuristically(prompt: string) {
  const normalized = prompt.toLowerCase();
  const keywordRules: Array<{ value: string; keywords: string[] }> = [
    { value: "account_based_marketing", keywords: ["abm", "account-based", "target accounts", "named accounts"] },
    { value: "cold_email", keywords: ["cold email", "cold outbound"] },
    { value: "outbound", keywords: ["outbound", "sdr", "bdr", "prospect outreach", "sales outreach"] },
    { value: "email", keywords: ["email campaign", "newsletter", "email sequence"] },
    { value: "drip", keywords: ["drip", "sequence", "automated series"] },
    { value: "nurture", keywords: ["nurture", "lead nurture"] },
    { value: "lead_generation", keywords: ["lead generation", "capture leads", "gated content", "form fill"] },
    { value: "demand_generation", keywords: ["demand generation", "generate demand", "create demand"] },
    { value: "brand_awareness", keywords: ["brand awareness", "brand recognition", "visibility"] },
    { value: "prospecting", keywords: ["prospecting", "qualify accounts", "identify prospects", "enrich leads"] },
    { value: "product_launch", keywords: ["product launch", "launch campaign", "new feature launch"] },
    { value: "go_to_market", keywords: ["go-to-market", "gtm", "launch motion", "positioning and messaging"] },
    { value: "pipeline_acceleration", keywords: ["pipeline acceleration", "move opportunities", "accelerate pipeline"] },
    { value: "conversion", keywords: ["conversion", "book demos", "request a quote", "drive signups", "purchase"] },
    { value: "retargeting", keywords: ["retargeting", "remarketing"] },
    { value: "engagement", keywords: ["engagement", "community interaction", "increase interaction"] },
    { value: "activation", keywords: ["activation", "first action", "activate users"] },
    { value: "onboarding", keywords: ["onboarding", "get started", "first-time user"] },
    { value: "adoption", keywords: ["adoption", "feature usage", "product adoption"] },
    { value: "expansion", keywords: ["upsell", "cross-sell", "expansion", "expand revenue"] },
    { value: "retention", keywords: ["retention", "reduce churn", "keep customers"] },
    { value: "re_engagement", keywords: ["re-engagement", "reactivate", "inactive users"] },
    { value: "customer_advocacy", keywords: ["testimonial", "referral", "customer advocacy", "case study"] },
    { value: "event", keywords: ["event", "webinar", "conference", "roundtable", "workshop"] },
    { value: "content", keywords: ["content campaign", "content asset", "content series"] },
    { value: "social_media", keywords: ["social media", "linkedin posts", "social campaign"] },
    { value: "paid_media", keywords: ["paid media", "ads", "display", "paid search", "paid social"] },
    { value: "performance_marketing", keywords: ["performance marketing", "cac", "roas", "paid conversions"] },
    { value: "acquisition", keywords: ["acquisition", "win new customers", "new customer acquisition"] },
  ];

  const match = keywordRules.find((rule) => rule.keywords.some((keyword) => normalized.includes(keyword)));
  return match?.value ?? "go_to_market";
}

export function deriveCampaignTypeDescription(prompt: string, category: string) {
  const compact = prompt.replace(/\s+/g, " ").trim();
  if (compact.length === 0) {
    return `A ${formatCampaignTypeCategory(category).toLowerCase()} defined inside Cinatra.`;
  }

  const firstSentence = compact.split(/(?<=[.!?])\s+/)[0] ?? compact;
  return firstSentence.length > 220 ? `${firstSentence.slice(0, 217)}...` : firstSentence;
}
