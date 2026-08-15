import { describe, it, expect } from "vitest";
import {
  chooseConnectorUiRender,
  collectDeclaredActionIds,
  isInstalledButNotActive,
} from "@/lib/connector-ui-render";

const VALID_SCHEMA = {
  title: "Test",
  fields: [{ kind: "text", key: "host", label: "Host" }],
};

describe("chooseConnectorUiRender", () => {
  it("renders schema-config from a valid declared configSchema (no React import)", () => {
    const d = chooseConnectorUiRender({ uiSurface: "schema-config", configSchema: VALID_SCHEMA });
    expect(d.kind).toBe("schema-config");
    if (d.kind === "schema-config") {
      expect(d.surface.fields).toHaveLength(1);
      expect(d.surface.fields[0]).toMatchObject({ kind: "text", key: "host" });
    }
  });

  it("fails closed (invalid-schema-config) when configSchema is missing — never falls back to bundled-react", () => {
    const d = chooseConnectorUiRender({ uiSurface: "schema-config", configSchema: null });
    expect(d.kind).toBe("invalid-schema-config");
    if (d.kind === "invalid-schema-config") expect(d.errors.length).toBeGreaterThan(0);
  });

  it("fails closed (invalid-schema-config) when configSchema is malformed", () => {
    const d = chooseConnectorUiRender({ uiSurface: "schema-config", configSchema: { fields: [] } });
    expect(d.kind).toBe("invalid-schema-config");
    if (d.kind === "invalid-schema-config") expect(d.errors.length).toBeGreaterThan(0);
  });

  it("keeps the legacy bundled-react dispatch path for declared bundled-react", () => {
    expect(chooseConnectorUiRender({ uiSurface: "bundled-react" }).kind).toBe("bundled-react");
  });

  it("keeps bundled-react for a legacy null/absent uiSurface", () => {
    expect(chooseConnectorUiRender({ uiSurface: null }).kind).toBe("bundled-react");
    expect(chooseConnectorUiRender(null).kind).toBe("bundled-react");
    expect(chooseConnectorUiRender(undefined).kind).toBe("bundled-react");
    expect(chooseConnectorUiRender({}).kind).toBe("bundled-react");
  });
});

// ---------------------------------------------------------------------------
// cinatra#2762. An install that committed but never activated in this process
// must be VISIBLE as that state, not left as bare 404s in the setup form.
//
// The scenario: a marketplace install commits while the runtime loader refuses
// its anchor, so the package registers nothing. The setup page is still
// addressable (a live row exists), every action POST 404s, and nothing on the
// page says why. These tests pin the signal the banner is derived from.
// ---------------------------------------------------------------------------

/**
 * The REAL declared surface of the connector in the report, copied from the
 * generated manifest so the fixture cannot drift from the shape the parser
 * accepts: a record list, a dynamic option loader, a named action, and an
 * advisory probe on a second tab.
 */
const ACTION_SURFACE = {
    "title": "Google Appointment Schedules",
    "description": "Manage the Google Calendar appointment-schedule booking links the assistant can share, each tied to the Google Calendar that owns its availability.",
    "fields": [
      {
        "kind": "banner",
        "label": "Result",
        "variants": [
          {
            "name": "saved",
            "tone": "success",
            "message": "Appointment schedule added."
          },
          {
            "name": "deleted",
            "tone": "success",
            "message": "Appointment schedule removed."
          },
          {
            "name": "error",
            "tone": "destructive",
            "message": "Couldn't add the appointment schedule."
          }
        ]
      },
      {
        "kind": "record-list",
        "label": "Appointment schedules",
        "listActionId": "listAppointmentSchedules",
        "deleteActionId": "deleteAppointmentSchedule",
        "emptyState": "No appointment schedules yet. Paste a booking page link below to add one.",
        "itemTitleKey": "title",
        "itemBadges": [
          {
            "key": "calendarSummary",
            "label": "Calendar",
            "variant": "outline"
          }
        ],
        "description": "Booking-page links the assistant can share, each tied to the calendar that owns its availability. Deleting a row is host-authorized."
      },
      {
        "kind": "text",
        "key": "bookingPageUrl",
        "label": "Booking page URL",
        "placeholder": "https://calendar.app.google/...",
        "required": true,
        "description": "A public Google Calendar appointment-schedule link (calendar.app.google/\u2026) \u2014 a share link, not a calendar sync. See the Help tab for how to get one."
      },
      {
        "kind": "dynamic-select-options",
        "key": "calendarId",
        "label": "Calendar",
        "optionsAction": "listCalendars",
        "placeholder": "No connected calendars yet \u2014 connect Google Calendar at /connectors/cinatra-ai/google-calendar-connector/setup to see your calendars here.",
        "description": "The Google Calendar this schedule's availability comes from. Leave unset to use your primary calendar."
      },
      {
        "kind": "named-action",
        "label": "Add schedule",
        "actionId": "addSchedule"
      }
    ],
    "tabs": [
      {
        "id": "help",
        "label": "Help",
        "fields": [
          {
            "kind": "advisory",
            "label": "About booking pages",
            "tone": "info",
            "probeActionId": "bookingPageGuideReady",
            "whenReady": "A public Google Calendar appointment-schedule link (calendar.app.google/\u2026) the assistant shares so people can book time with you \u2014 a share link, not a calendar sync. Get one in Google Calendar: Create \u2192 Appointment schedule, then paste its public link here.",
            "whenNotReady": "A public Google Calendar appointment-schedule link (calendar.app.google/\u2026) the assistant shares so people can book time with you \u2014 a share link, not a calendar sync. Get one in Google Calendar: Create \u2192 Appointment schedule, then paste its public link here.",
            "description": "Read-only setup guidance \u2014 nothing on this tab is saved."
          }
        ]
      }
    ]
  };

function surfaceOf(schema: Record<string, unknown>) {
  const decision = chooseConnectorUiRender({
    uiSurface: "schema-config",
    configSchema: schema,
  });
  if (decision.kind !== "schema-config") {
    throw new Error(`expected a schema-config surface, got ${decision.kind}`);
  }
  return decision.surface;
}

describe("collectDeclaredActionIds", () => {
  it("collects every dispatchable id across flat fields AND tab panels", () => {
    const ids = collectDeclaredActionIds(surfaceOf(ACTION_SURFACE));
    expect(new Set(ids)).toEqual(
      new Set([
        "listAppointmentSchedules",
        "deleteAppointmentSchedule",
        "listCalendars",
        "addSchedule",
        "bookingPageGuideReady",
      ]),
    );
  });

  it("returns nothing for a surface that declares no actions", () => {
    const ids = collectDeclaredActionIds(
      surfaceOf({ title: "Plain", fields: [{ kind: "text", key: "host", label: "Host" }] }),
    );
    expect(ids).toEqual([]);
  });
});

describe("isInstalledButNotActive", () => {
  const declaredActionIds = ["listCalendars", "addSchedule"];
  const base = { packageName: "@cinatra-ai/appt", declaredActionIds };

  it("flags the state: a live install row whose package registered NOTHING here", () => {
    expect(
      isInstalledButNotActive({ ...base, installId: "iext_1", resolveAction: () => null }),
    ).toBe(true);
  });

  it("does NOT flag an activated package", () => {
    expect(
      isInstalledButNotActive({
        ...base,
        installId: "iext_1",
        resolveAction: () => ({ handler: () => undefined }),
      }),
    ).toBe(false);
  });

  it("does NOT flag when only SOME actions are missing: that is a surface mismatch, not an inactive package", () => {
    expect(
      isInstalledButNotActive({
        ...base,
        installId: "iext_1",
        resolveAction: (_pkg, id) => (id === "addSchedule" ? { handler: () => undefined } : null),
      }),
    ).toBe(false);
  });

  it("does NOT flag when there is no install row: the route already shows its Install CTA", () => {
    expect(
      isInstalledButNotActive({ ...base, installId: null, resolveAction: () => null }),
    ).toBe(false);
  });

  it("does NOT flag a connector that declares no actions at all", () => {
    expect(
      isInstalledButNotActive({
        packageName: "@cinatra-ai/plain",
        declaredActionIds: [],
        installId: "iext_1",
        resolveAction: () => null,
      }),
    ).toBe(false);
  });

  it("reads the SAME resolver the action route reads, so the banner cannot disagree with the 404s", () => {
    const seen: string[] = [];
    isInstalledButNotActive({
      ...base,
      installId: "iext_1",
      resolveAction: (pkg, id) => {
        seen.push(`${pkg}:${id}`);
        return null;
      },
    });
    expect(seen).toEqual(["@cinatra-ai/appt:listCalendars", "@cinatra-ai/appt:addSchedule"]);
  });
});
