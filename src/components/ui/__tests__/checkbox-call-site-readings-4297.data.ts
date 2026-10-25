// The recorded reading of every checkbox call site in the application and the
// shared packages (cinatra#4297, Done-when 2 and 3).
//
// The rule read against each site is the components drawing's sentence
// (cinatra-ai/design `specs/app-components.html`, "Checkbox / Radio / Switch"):
//
//   "Single-select (radio), multi-select (checkbox), and instant-binary
//    (switch). Indigo for active state. Switches are reserved for
//    immediate-effect settings; checkboxes for confirmable form choices."
//
// Each site records whether its change takes effect at once (`immediate`), is
// held until a separate confirm applies it (`confirmed`), or changes nothing
// itself (`none`). A site that takes effect at once and is drawn as a checkbox
// carries the reason it stays (`staysBecause`); the test refuses one without.
//
// `checkbox-call-site-readings-4297.test.ts` holds this list to the live tree
// in both directions: a file that refers to a checkbox and is not read here
// fails, a reading whose site is gone fails, and a changed token count, anchor,
// handler or confirm control fails until the site is read again. When it
// fails, read the named site, decide its effect against the sentence above and
// update its entry here; a new immediate-effect setting is drawn with the
// switch (`@/components/ui/switch`).

import type { CallerReading, FileReading } from "./checkbox-call-site-scan.ts";

const PRIMITIVE =
  "the primitive's own definition: it changes nothing itself, and each place that renders it is read at its own file";

const FIXTURE =
  "a static drawing fixture of the checkbox primitive for the design conformance pages: it changes nothing and saves nothing";

export const CHECKBOX_CALL_SITE_READINGS: FileReading[] = [
  // ---- the row of #4297 itself --------------------------------------------------------------------------------------
  {
    file: "packages/sdk-ui/src/prompt-field.tsx",
    tokens: 3,
    sites: [
      {
        anchor: "onCheckedChange={(checked) => autosave.onToggle?.(checked === true)}",
        tag: "DropdownMenuCheckboxItem",
        drawn: "switch",
        effect: "immediate",
        reading:
          "the Skills autosave row of the prompt field's options menu: a change calls autosave.onToggle at once and the chat composer writes the setting there (patchChatCaptureConfig), so it is an immediate-effect setting and draws a switch",
        tagIncludes: [
          "onCheckedChange={(checked) => autosave.onToggle?.(checked === true)}",
          "onSelect={(e) => e.preventDefault()}",
        ],
        fileIncludes: ['<Switch checked={autosave.enabled} tabIndex={-1} aria-hidden="true" />'],
        evidence: [
          { file: "packages/chat/src/brokered-composer-inputs.tsx", text: "void patchChatCaptureConfig(enabled, transport);" },
        ],
      },
    ],
  },

  // ---- the primitives ------------------------------------------------------------------------------------------------
  {
    file: "src/components/ui/checkbox.tsx",
    tokens: 10,
    sites: [
      { anchor: "data-slot='checkbox'", tag: "CheckboxPrimitive.Root", drawn: "checkbox", effect: "none", reading: PRIMITIVE, tagIncludes: [], fileIncludes: [] },
      { anchor: "data-slot='checkbox-indicator'", tag: "CheckboxPrimitive.Indicator", drawn: "checkbox", effect: "none", reading: PRIMITIVE, tagIncludes: [], fileIncludes: [] },
    ],
  },
  {
    file: "packages/sdk-ui/src/ui/checkbox.tsx",
    tokens: 10,
    sites: [
      { anchor: "data-slot='checkbox'", tag: "CheckboxPrimitive.Root", drawn: "checkbox", effect: "none", reading: PRIMITIVE, tagIncludes: [], fileIncludes: [] },
      { anchor: "data-slot='checkbox-indicator'", tag: "CheckboxPrimitive.Indicator", drawn: "checkbox", effect: "none", reading: PRIMITIVE, tagIncludes: [], fileIncludes: [] },
    ],
  },
  {
    file: "src/components/ui/dropdown-menu.tsx",
    tokens: 5,
    sites: [
      { anchor: 'data-slot="dropdown-menu-checkbox-item"', tag: "DropdownMenuPrimitive.CheckboxItem", drawn: "checkbox", effect: "none", reading: PRIMITIVE, tagIncludes: [], fileIncludes: [] },
    ],
  },
  {
    file: "packages/sdk-ui/src/ui/dropdown-menu.tsx",
    tokens: 5,
    sites: [
      { anchor: 'data-slot="dropdown-menu-checkbox-item"', tag: "DropdownMenuPrimitive.CheckboxItem", drawn: "checkbox", effect: "none", reading: PRIMITIVE, tagIncludes: [], fileIncludes: [] },
    ],
  },

  // ---- the application -------------------------------------------------------------------------------------------------
  {
    file: "src/app/configuration/skills/skill-autosave-form.tsx",
    tokens: 5,
    sites: [
      {
        anchor: 'id="autosave-enabled"',
        tag: "Checkbox",
        drawn: "checkbox",
        effect: "confirmed",
        reading:
          "Enable autosave in the skills administration: a change only sets local state, and the form's Save button writes it (saveSkillAutosaveAction)",
        tagIncludes: ["onCheckedChange={(checked) => setEnabled(checked === true)}"],
        fileIncludes: ["<form action={handleSubmit}", '<Button type="submit" variant="outline">', "await saveSkillAutosaveAction(formData);"],
      },
      {
        anchor: 'id="autosave-user-can-configure"',
        tag: "Checkbox",
        drawn: "checkbox",
        effect: "confirmed",
        reading: "Users can toggle, in the same form: a change only sets local state, and the form's Save button writes it",
        tagIncludes: ["onCheckedChange={(checked) => {"],
        fileIncludes: ["<form action={handleSubmit}", '<Button type="submit" variant="outline">'],
      },
      {
        anchor: 'id="autosave-user-can-see-indicator"',
        tag: "Checkbox",
        drawn: "checkbox",
        effect: "confirmed",
        reading: "Show indicator to users, in the same form: a change only sets local state, and the form's Save button writes it",
        tagIncludes: ["onCheckedChange={handleSeeIndicatorChange}"],
        fileIncludes: ["<form action={handleSubmit}", '<Button type="submit" variant="outline">'],
      },
    ],
  },
  {
    file: "src/app/configuration/skills/recreate-library-section.tsx",
    tokens: 3,
    sites: [
      {
        anchor: 'id="recreate-push-empty"',
        tag: "Checkbox",
        drawn: "checkbox",
        effect: "confirmed",
        reading:
          "the force-push option of the recreate-library dialog: a change only sets local state, and the dialog's destructive action button applies it with the recreate",
        tagIncludes: ["onCheckedChange={(value) => setForcePush(value === true)}"],
        fileIncludes: ["handleConfirm();", "Yes, recreate library"],
      },
    ],
  },
  {
    file: "src/app/configuration/development/page.tsx",
    tokens: 3,
    sites: [
      {
        anchor: 'id="developmentModeEnabled"',
        tag: "Checkbox",
        drawn: "checkbox",
        effect: "confirmed",
        reading:
          "Override recipient email: an uncontrolled field of the email-safety form, written only when the form is submitted",
        tagIncludes: ['name="developmentModeEnabled"'],
        fileIncludes: ["<SaveEmailSafetyForm>", 'type="submit"'],
        evidence: [
          { file: "src/app/configuration/development/save-development-form.tsx", text: "await saveEmailSystemDevelopmentSettingsAction(formData);" },
        ],
      },
    ],
  },
  {
    file: "src/components/development-logging-settings-panel.tsx",
    tokens: 3,
    sites: [
      {
        anchor: "name={`${provider.id}LoggingEnabled`}",
        tag: "Checkbox",
        drawn: "checkbox",
        effect: "confirmed",
        reading: "one provider's API logging choice: an uncontrolled field of the logging form, written only by its Save button",
        tagIncludes: ["defaultChecked={provider.enabled}"],
        fileIncludes: ["<form action={action}", '<Button type="submit">Save logging administration</Button>'],
      },
    ],
  },
  {
    file: "src/app/configuration/environment/become-a-vendor-card.tsx",
    tokens: 3,
    sites: [
      {
        anchor: 'id="terms-accepted"',
        tag: "Checkbox",
        drawn: "checkbox",
        effect: "confirmed",
        reading: "the terms acceptance of the vendor application: a required form field, sent only with the application's submit",
        tagIncludes: ["onCheckedChange={(value) =>", "required"],
        fileIncludes: ["<form action={applyVendorApplicationAction}>", '<Button type="submit" disabled={!isValid}>'],
      },
    ],
  },
  {
    file: "src/app/configuration/environment/marketplace-terms-checkbox.tsx",
    tokens: 6,
    sites: [
      {
        anchor: 'name="termsAccepted"',
        tag: "Checkbox",
        drawn: "checkbox",
        effect: "confirmed",
        reading:
          "the terms acceptance of the marketplace publish request: a required field of the plain HTML form, sent only by that form's submit",
        tagIncludes: ["required"],
        fileIncludes: ["submitted to `requestMarketplacePublishAction`"],
        evidence: [
          { file: "src/app/configuration/environment/marketplace-publish-card.tsx", text: "<form action={requestMarketplacePublishAction}" },
        ],
      },
    ],
  },
  {
    file: "src/app/configuration/environment/marketplace-publish-card.tsx",
    tokens: 2,
    sites: [
      {
        anchor: "<MarketplaceTermsCheckbox",
        tag: "MarketplaceTermsCheckbox",
        drawn: "checkbox",
        effect: "confirmed",
        reading: "the one place the terms acceptance above is rendered, inside the publish request form with its own submit button",
        tagIncludes: [],
        fileIncludes: ["<form action={requestMarketplacePublishAction}", '<Button type="submit" variant="default">'],
      },
    ],
  },
  {
    file: "src/app/setup/model/anthropic-provider-step.tsx",
    tokens: 3,
    sites: [
      {
        anchor: 'data-testid="setup-anthropic-consent"',
        tag: "Checkbox",
        drawn: "checkbox",
        effect: "confirmed",
        reading:
          "the skills-upload consent of the setup model step: an uncontrolled form field, sent only by the step's single Continue",
        tagIncludes: ["name={ANTHROPIC_SETUP_CONSENT_FIELD}"],
        fileIncludes: ["single Continue (<SetupModelStepForm>) submits them"],
      },
    ],
  },
  {
    file: "src/app/design-fixtures/conformance/component-surface-fixtures.tsx",
    tokens: 4,
    sites: [
      { anchor: 'aria-label="Notify me when a run finishes"', tag: "Checkbox", drawn: "checkbox", effect: "none", reading: FIXTURE, tagIncludes: [], fileIncludes: [] },
    ],
  },
  {
    file: "src/app/design-fixtures/conformance/primitive-wave-fixtures.tsx",
    tokens: 6,
    sites: [
      { anchor: 'data-wave-state="off"', tag: "Checkbox", drawn: "checkbox", effect: "none", reading: FIXTURE, tagIncludes: [], fileIncludes: [] },
      { anchor: 'data-wave-state="on"', tag: "Checkbox", drawn: "checkbox", effect: "none", reading: FIXTURE, tagIncludes: [], fileIncludes: [] },
    ],
  },
  {
    file: "src/app/design-fixtures/fixtures-complex.tsx",
    tokens: 4,
    sites: [{ anchor: 'id="cb"', tag: "Checkbox", drawn: "checkbox", effect: "none", reading: FIXTURE, tagIncludes: [], fileIncludes: [] }],
  },

  // ---- the shared packages ---------------------------------------------------------------------------------------------
  {
    file: "packages/agents/src/run-recommendation-chip-row.tsx",
    tokens: 4,
    sites: [
      {
        anchor: 'data-skills-step-checkbox=""',
        tag: "Checkbox",
        drawn: "checkbox",
        effect: "confirmed",
        reading:
          "one skill of the run's skills step: a tick only marks the skill, and the step's one Continue sends the whole decision",
        tagIncludes: ["onCheckedChange: (next) => onCheckedChange(next === true)"],
        fileIncludes: ["const onContinue = () => {", "onClick={onContinue}"],
      },
    ],
  },
  {
    file: "packages/agents/src/context-selector-renderer.tsx",
    tokens: 3,
    sites: [
      {
        anchor: "onCheckedChange={() => handleToggle(ref)}",
        tag: "Checkbox",
        drawn: "checkbox",
        effect: "confirmed",
        reading:
          "one candidate of a context-selector gate: a tick hands the new selection to the gate as its buffered value, and the gate's Continue sends it. In override mode a tick replaces the selection, which is a single-select drawn with boxes: that is the drawing's radio rule, not the switch rule this list reads",
        tagIncludes: ["onCheckedChange={() => handleToggle(ref)}"],
        fileIncludes: ["onChange?.({", "nextSelected = [ref];"],
        evidence: [
          { file: "packages/agents/src/hitl-gate-submit.ts", text: "ContextSelectorRenderer only fires its" },
          { file: "packages/agents/src/agentic-run-panel.tsx", text: "const [bufferedHitlValue, setBufferedHitlValue]" },
        ],
      },
    ],
  },
  {
    file: "packages/agents/src/schema-field-renderer.tsx",
    tokens: 4,
    sites: [
      {
        anchor: "onCheckedChange={(next) => onChange(Boolean(next))}",
        tag: "Checkbox",
        drawn: "checkbox",
        effect: "immediate",
        reading:
          "the box of a boolean question in a schema-drawn form: inside a grouped setup form or a mid-run input step the form's own submit sends it, but on the per-field setup surfaces no Continue is drawn beneath it, so the tick sends the answer at once",
        staysBecause:
          "it answers a yes/no question of a form, which the drawing gives as a confirmable form choice (a checkbox); its immediate send on the per-field setup surfaces is the missing Continue that cinatra#4310 adds, so the cure is the confirm, not a switch",
        tagIncludes: ["onCheckedChange={(next) => onChange(Boolean(next))}"],
        fileIncludes: ['if (t === "boolean"'],
        evidence: [
          { file: "packages/agents/src/register-default-renderers.ts", text: "drawsOwnSubmit: true," },
          { file: "packages/agents/src/agentic-run-panel.tsx", text: "hitlRendererEntry.entry.drawsOwnSubmit !== true;" },
        ],
      },
    ],
  },
  {
    file: "packages/agents/src/upload-install-scope-panel.tsx",
    tokens: 3,
    sites: [
      {
        anchor: 'data-testid="supplied-upload-consent-checkbox"',
        tag: "Checkbox",
        drawn: "checkbox",
        effect: "confirmed",
        reading:
          "the skills-upload consent of an uploaded extension's install: a tick only sets local state, and the install call carries it (consentPayload)",
        tagIncludes: ["onCheckedChange={(next) => onCheckedChange(next === true)}"],
        fileIncludes: ["export function consentPayload("],
      },
    ],
  },
  {
    file: "packages/sdk-ui/src/access-combobox.tsx",
    tokens: 6,
    sites: [
      {
        anchor: 'className="pointer-events-none"',
        tag: "Checkbox",
        drawn: "checkbox",
        effect: "none",
        reading:
          "the mark of one option of the multi-select access picker: the box is aria-hidden and out of the tab order, the option row is the control and hands the new selection to its caller, so each caller is read in ACCESS_PICKER_CALLERS",
        tagIncludes: ['aria-hidden="true"', "tabIndex={-1}"],
        fileIncludes: ["onChange(toggle(itemValue, selection));"],
      },
    ],
  },

  // ---- files that refer to a checkbox and draw none ------------------------------------------------------------------------
  {
    file: "src/components/ui/field.tsx",
    tokens: 4,
    mentions: "layout selectors for a field that holds a checkbox group or a checkbox ([data-slot=checkbox-group], [role=checkbox])",
    sites: [],
  },
  {
    file: "src/components/ui/table.tsx",
    tokens: 2,
    mentions: "padding selectors for a table cell that holds a checkbox ([role=checkbox])",
    sites: [],
  },
  {
    file: "src/lib/artifacts/host-shared-primitives.ts",
    tokens: 4,
    mentions:
      "the Checkbox primitive handed to artifact extensions as a shared primitive; an extension's own call sites belong to its repository",
    sites: [],
  },
  {
    file: "packages/sdk-extensions/src/artifact-client-bundle.ts",
    tokens: 1,
    mentions: 'the name "Checkbox" in the list of shared primitives an artifact bundle may import',
    sites: [],
  },
  {
    file: "src/lib/scope-filter.ts",
    tokens: 1,
    mentions: "a comment on the box state of one scope-filter row; the row is drawn by the access picker",
    sites: [],
  },
];

const MULTI_SELECT =
  "it is one option of a multi-select scope filter: the drawing gives several options of one choice as a multi-select and draws it with checkboxes, while a switch is one on/off setting";

/** The callers of the multi-select access picker, whose option rows draw the box above. */
export const ACCESS_PICKER_CALLERS: CallerReading[] = [
  {
    file: "packages/extensions/src/screens/extension-access-control.tsx",
    effect: "confirmed",
    reading: "an extension's access: a change sets local state, and the Save button beneath it writes it",
    fileIncludes: ["const result = await save(value);", '{pending ? "Saving…" : "Save"}'],
  },
  {
    file: "packages/sdk-ui/src/permissions-panel.tsx",
    effect: "confirmed",
    reading: "the access field of the permissions form: a change sets the form value, and the form's submit writes it",
    fileIncludes: ["onSubmit={handleSubmit(onSubmit)}", '<Button type="submit" disabled={isSavingPolicy}>'],
  },
  {
    file: "src/components/permissions-form-draft.tsx",
    effect: "confirmed",
    reading: "the upload-time access draft: a change goes to the parent's draft value, and the upload's create action writes it",
    fileIncludes: ["onChange={setAccess}", "lets the parent submit them as part of a larger create action"],
  },
  {
    file: "packages/skills/src/skills-toolbar.tsx",
    effect: "immediate",
    reading: "the scope filter of the skills list: a change narrows the list at once by its URL",
    fileIncludes: ["onChange={selectScope}", "router.push(qs ? `${pathname}?${qs}` : pathname);"],
    staysBecause: MULTI_SELECT,
  },
  {
    file: "src/components/scope-filter-combobox.tsx",
    effect: "immediate",
    reading: "the shared scope filter of the list pages: a change narrows the list at once by its URL",
    fileIncludes: ["onChange={handleChange}", "router.push(query ? `${pathname}?${query}` : pathname);"],
    staysBecause: MULTI_SELECT,
  },
  {
    file: "src/app/design-fixtures/access-picker/access-picker-fixture.tsx",
    effect: "none",
    reading: "the access picker's design fixtures: local state only, nothing is saved",
    fileIncludes: [],
  },
];
