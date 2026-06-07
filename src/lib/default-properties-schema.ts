import type { PropertyDefinition, PropertyMap } from "@/lib/types";

export const ACCOUNT_DEFAULT_PROPERTIES: PropertyDefinition[] = [
  { name: "hs_object_id", label: "Record ID", type: "string" },
  { name: "name", label: "Company name", type: "string" },
  { name: "domain", label: "Company domain name", type: "string" },
  { name: "hs_additional_domains", label: "Additional domains", type: "string" },
  { name: "phone", label: "Phone number", type: "phone" },
  { name: "website", label: "Website URL", type: "url" },
  { name: "hubspot_owner_id", label: "Record owner", type: "string" },
  { name: "city", label: "City", type: "string" },
  { name: "state", label: "State/Region", type: "string" },
  { name: "zip", label: "Postal code", type: "string" },
  { name: "country", label: "Country/Region", type: "string" },
  { name: "address", label: "Street address", type: "string" },
  { name: "industry", label: "Industry", type: "string" },
  { name: "annualrevenue", label: "Annual revenue", type: "currency" },
  { name: "numberofemployees", label: "Number of employees", type: "number" },
  { name: "lifecyclestage", label: "Lifecycle stage", type: "enumeration" },
  { name: "description", label: "Description", type: "string" },
  { name: "createdate", label: "Create date", type: "datetime" },
  { name: "hs_lastmodifieddate", label: "Last modified date", type: "datetime" },
];

export const CONTACT_DEFAULT_PROPERTIES: PropertyDefinition[] = [
  { name: "hs_object_id", label: "Record ID", type: "string" },
  { name: "email", label: "Email", type: "email" },
  { name: "firstname", label: "First name", type: "string" },
  { name: "lastname", label: "Last name", type: "string" },
  { name: "hubspot_owner_id", label: "Record owner", type: "string" },
  { name: "phone", label: "Phone number", type: "phone" },
  { name: "mobilephone", label: "Mobile phone number", type: "phone" },
  { name: "company", label: "Company name", type: "string" },
  { name: "website", label: "Website URL", type: "url" },
  { name: "jobtitle", label: "Job title", type: "string" },
  { name: "lifecyclestage", label: "Lifecycle stage", type: "enumeration" },
  { name: "city", label: "City", type: "string" },
  { name: "state", label: "State/Region", type: "string" },
  { name: "zip", label: "Postal code", type: "string" },
  { name: "country", label: "Country/Region", type: "string" },
  { name: "address", label: "Street address", type: "string" },
  { name: "hs_linkedin_url", label: "Profile URL", type: "url" },
  { name: "hubspotscore", label: "Engagement score", type: "number" },
  { name: "createdate", label: "Create date", type: "datetime" },
  { name: "lastmodifieddate", label: "Last modified date", type: "datetime" },
];

export const CAMPAIGN_DEFAULT_PROPERTIES: PropertyDefinition[] = [
  { name: "hs_object_id", label: "Record ID", type: "string" },
  { name: "hs_name", label: "Campaign name", type: "string" },
  { name: "hs_start_date", label: "Start date", type: "date" },
  { name: "hs_end_date", label: "End date", type: "date" },
  { name: "hs_notes", label: "Notes", type: "string" },
  { name: "hs_audience", label: "Audience", type: "string" },
  { name: "hs_currency_code", label: "Currency code", type: "string" },
  { name: "hs_campaign_status", label: "Campaign status", type: "enumeration" },
  { name: "hs_utm", label: "UTM", type: "string" },
  { name: "hs_owner", label: "Owner", type: "string" },
  { name: "hs_created_by_user_id", label: "Created by user ID", type: "string" },
  { name: "hs_budget_items_sum_amount", label: "Budget sum", type: "currency" },
  { name: "hs_spend_items_sum_amount", label: "Spend sum", type: "currency" },
  { name: "createdate", label: "Create date", type: "datetime" },
  { name: "hs_lastmodifieddate", label: "Last modified date", type: "datetime" },
];

const propertyLabels = new Map<string, string>(
  [...ACCOUNT_DEFAULT_PROPERTIES, ...CONTACT_DEFAULT_PROPERTIES, ...CAMPAIGN_DEFAULT_PROPERTIES].map(
    (property) => [property.name, property.label],
  ),
);

function titleCasePropertyName(name: string) {
  return name
    .replace(/^hs_/, "")
    .replace(/^cinatra_/, "")
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function buildPropertyMap(properties: PropertyMap) {
  return { ...properties };
}

export function filterFilledProperties(properties: PropertyMap) {
  return Object.fromEntries(
    Object.entries(properties).filter(([, value]) => value !== null && value !== "" && value !== undefined),
  );
}

export function formatPropertyLabel(name: string) {
  return propertyLabels.get(name) ?? titleCasePropertyName(name);
}

export function formatPropertyValue(value: PropertyMap[string]) {
  if (value === null || value === undefined || value === "") {
    return "Empty";
  }

  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }

  return String(value);
}

export function getFilledPropertyEntries(properties: PropertyMap, limit = Number.POSITIVE_INFINITY) {
  return Object.entries(properties)
    .filter(([, value]) => value !== null && value !== "" && value !== undefined)
    .slice(0, limit)
    .map(([name, value]) => ({
      name,
      label: formatPropertyLabel(name),
      value: formatPropertyValue(value),
    }));
}
