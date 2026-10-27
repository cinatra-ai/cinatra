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

import type { ComponentCallers, FileReading } from "./checkbox-call-site-scan.ts";

const PRIMITIVE =
  "the primitive's own definition: it changes nothing itself, and each place that renders it is read at its own file";

const RHF_FIELD =
  "an Input that spreads a react-hook-form field (name, value, onChange, onBlur, ref), which carries no type, so it is a text field and no checkbox";

const PASS_THROUGH =
  "an input primitive or wrapper that hands its caller's props through; a caller that passes a checkbox type is a site of its own (an element whose type is checkbox), so this definition draws no checkbox itself";

const ROLE_PASS_THROUGH =
  "a primitive wrapper that sets a role of its own and then spreads its caller's props (its function's rest props), so a caller could set another role; a caller that passes a checkbox role is a site of its own (an element whose role is checkbox), so this definition draws no checkbox itself";

const RHF_REGISTER =
  "a hidden Input that spreads react-hook-form's register(), which returns name, onChange, onBlur and ref and no type, so its literal type hidden stands and it is no checkbox";

const FIXTURE =
  "a static drawing fixture of the checkbox primitive for the design conformance pages: it changes nothing and saves nothing";

const SERVER_MODULE =
  "a server-side library's module object (no React component in it) handed on whole to a helper that calls its functions by name: it draws nothing";

const EXTENSION_LOADS =
  "each load hands the host an installed extension's module, from outside src/ and packages/; whatever the host draws from it is the extension's own code, whose call sites belong to its repository (as for the shared primitives)";

const PATH_SEGMENTS =
  "a segment of the page's URL path (a string the router hands back), compared to a word to build the document title: it draws nothing";

const LIBRARY_LOADS =
  "a lazy load of a library module outside the tree whose functions this file then calls by name: it draws no checkbox";

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
      { anchor: "data-slot='checkbox'", tag: "CheckboxPrimitive.Root", drawn: "checkbox", effect: "none", reading: PRIMITIVE, tagIncludes: ["{...props}"], fileIncludes: [] },
      { anchor: "data-slot='checkbox-indicator'", tag: "CheckboxPrimitive.Indicator", drawn: "checkbox", effect: "none", reading: PRIMITIVE, tagIncludes: [], fileIncludes: [] },
    ],
  },
  {
    file: "packages/sdk-ui/src/ui/checkbox.tsx",
    tokens: 10,
    sites: [
      { anchor: "data-slot='checkbox'", tag: "CheckboxPrimitive.Root", drawn: "checkbox", effect: "none", reading: PRIMITIVE, tagIncludes: ["{...props}"], fileIncludes: [] },
      { anchor: "data-slot='checkbox-indicator'", tag: "CheckboxPrimitive.Indicator", drawn: "checkbox", effect: "none", reading: PRIMITIVE, tagIncludes: [], fileIncludes: [] },
    ],
  },
  {
    file: "src/components/ui/dropdown-menu.tsx",
    tokens: 5,
    sites: [
      { anchor: 'data-slot="dropdown-menu-checkbox-item"', tag: "DropdownMenuPrimitive.CheckboxItem", drawn: "checkbox", effect: "none", reading: PRIMITIVE, tagIncludes: ["{...props}"], fileIncludes: [] },
    ],
  },
  {
    file: "packages/sdk-ui/src/ui/dropdown-menu.tsx",
    tokens: 5,
    sites: [
      { anchor: 'data-slot="dropdown-menu-checkbox-item"', tag: "DropdownMenuPrimitive.CheckboxItem", drawn: "checkbox", effect: "none", reading: PRIMITIVE, tagIncludes: ["{...props}"], fileIncludes: [] },
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
        fileIncludes: ["handleConfirm();", 'pending ? "Recreating…" : "Yes, recreate library"'],
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
        fileIncludes: [],
        evidence: [
          { file: "src/app/configuration/environment/marketplace-publish-card.tsx", text: "<form action={requestMarketplacePublishAction}" },
          { file: "src/app/configuration/environment/marketplace-publish-actions.ts", text: 'if (formData.get("termsAccepted") !== "on") {' },
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
        fileIncludes: [],
        evidence: [
          { file: "src/app/setup/model/page.tsx", text: "<SetupAnthropicProviderStep keyReopened={keyReopened} />" },
          { file: "src/app/setup/model/page.tsx", text: "action={continueSetupModelStepAction}" },
          { file: "src/app/setup/model/model-step-form.tsx", text: '<Button type="submit" disabled={pending} data-testid="setup-ai-continue">' },
          { file: "src/app/setup/model/actions.ts", text: 'const consentGiven = formString(formData, ANTHROPIC_SETUP_CONSENT_FIELD) === "on";' },
        ],
      },
    ],
  },
  {
    file: "src/app/design-fixtures/conformance/component-surface-fixtures.tsx",
    tokens: 4,
    sites: [
      {
        anchor: "<Input {...field} />",
        tag: "Input",
        drawn: "no checkbox",
        effect: "none",
        reading: RHF_FIELD,
        tagIncludes: ["{...field}"],
        fileIncludes: ["render={({ field }) => ("],
      },
      {
        anchor: 'data-surface-id="checkbox"',
        tag: '"checkbox"',
        drawn: "no checkbox",
        effect: "none",
        reading: "the data attribute that names the checkbox surface of the conformance fixtures on its wrapper: a name, it draws nothing",
        tagIncludes: [],
        fileIncludes: [],
      },
      { anchor: 'aria-label="Notify me when a run finishes"', tag: "Checkbox", drawn: "checkbox", effect: "none", reading: FIXTURE, tagIncludes: [], fileIncludes: [] },
    ],
  },
  {
    file: "src/app/design-fixtures/conformance/primitive-wave-fixtures.tsx",
    tokens: 6,
    sites: [
      {
        anchor: 'data-wave-seam="checkbox"',
        tag: '"checkbox"',
        drawn: "no checkbox",
        effect: "none",
        reading: "the data attribute that names the checkbox seam of the primitive-wave fixtures on its wrapper: a name, it draws nothing",
        tagIncludes: [],
        fileIncludes: [],
      },
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
    tokens: 5,
    sites: [
      {
        anchor: 'data-skills-step-checkbox=""',
        tag: "Checkbox",
        drawn: "checkbox",
        effect: "confirmed",
        reading:
          "one skill of the run's skills step: a tick only marks the skill, and the step's one Continue sends the whole decision",
        tagIncludes: ["{...(onCheckedChange ? { onCheckedChange: (next) => onCheckedChange(next === true) } : {})}"],
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
          { file: "packages/agents/src/agentic-run-panel.tsx", text: "buffered: bufferedHitlValueRef.current," },
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
          "the skills-upload consent of an uploaded extension's install (UploadConsentBlock): a tick hands the value to the caller's state, and the caller's install action sends it, so each caller is read in COMPONENT_CALLERS",
        tagIncludes: ["onCheckedChange={(next) => onCheckedChange(next === true)}"],
        fileIncludes: ["export function UploadConsentBlock({"],
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
          "the mark of one option of the multi-select access picker: the box is aria-hidden and out of the tab order, the option row is the control and hands the new selection to its caller, so each caller is read in COMPONENT_CALLERS",
        tagIncludes: ['aria-hidden="true"', "tabIndex={-1}"],
        fileIncludes: ["onChange(toggle(itemValue, selection));"],
      },
    ],
  },

  // ---- files that refer to a checkbox and draw none ------------------------------------------------------------------------
  {
    file: "src/components/ui/field.tsx",
    tokens: 4,
    // Its four tokens are layout selectors for a field that holds a checkbox group or a checkbox
    // ([data-slot=checkbox-group], [role=checkbox]); its two sites are role wrappers.
    sites: [
      { anchor: 'data-slot="field"', tag: "div", drawn: "no checkbox", effect: "none", reading: ROLE_PASS_THROUGH, tagIncludes: ["{...props}"], fileIncludes: [] },
      { anchor: 'data-slot="field-error"', tag: "div", drawn: "no checkbox", effect: "none", reading: ROLE_PASS_THROUGH, tagIncludes: ["{...props}"], fileIncludes: [] },
    ],
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
    sites: [
      {
        anchor: "Checkbox",
        tag: "Checkbox",
        drawn: "no checkbox",
        effect: "none",
        reading:
          "the Checkbox primitive put, as a value, into the frozen shared-primitives object handed to artifact extensions: it draws nothing here, and an extension's own call sites belong to its repository",
        tagIncludes: [],
        fileIncludes: ["export const HOST_DESIGN_PRIMITIVES = Object.freeze({"],
      },
    ],
  },
  {
    file: "packages/sdk-extensions/src/artifact-client-bundle.ts",
    tokens: 1,
    sites: [
      {
        anchor: '"Checkbox"',
        tag: '"Checkbox"',
        drawn: "no checkbox",
        effect: "none",
        reading: 'the name "Checkbox" in the list of shared primitives an artifact bundle may import: a name in a list, it draws nothing',
        tagIncludes: [],
        fileIncludes: [],
      },
    ],
  },
  {
    file: "src/lib/scope-filter.ts",
    tokens: 1,
    mentions: "a comment on the box state of one scope-filter row; the row is drawn by the access picker",
    sites: [],
  },

  // ---- inputs whose type the scan cannot read (rule 3: unresolved), read by hand -------------------------------------
  {
    file: "src/components/ui/input.tsx",
    tokens: 0,
    sites: [{ anchor: 'data-slot="input"', tag: "input", drawn: "no checkbox", effect: "none", reading: PASS_THROUGH, tagIncludes: ["{...props}"], fileIncludes: [] }],
  },
  {
    file: "packages/sdk-ui/src/ui/input.tsx",
    tokens: 0,
    sites: [{ anchor: 'data-slot="input"', tag: "input", drawn: "no checkbox", effect: "none", reading: PASS_THROUGH, tagIncludes: ["{...props}"], fileIncludes: [] }],
  },
  {
    file: "src/components/ui/input-group.tsx",
    tokens: 0,
    sites: [
      { anchor: 'data-slot="input-group"', tag: "div", drawn: "no checkbox", effect: "none", reading: ROLE_PASS_THROUGH, tagIncludes: ["{...props}"], fileIncludes: [] },
      {
        anchor: 'data-slot="input-group-addon"',
        tag: "div",
        drawn: "no checkbox",
        effect: "none",
        reading: ROLE_PASS_THROUGH,
        tagIncludes: ["onClick={(e) => {", "{...props}"],
        fileIncludes: [],
      },
      { anchor: 'data-slot="input-group-control"', tag: "Input", drawn: "no checkbox", effect: "none", reading: PASS_THROUGH, tagIncludes: ["{...props}"], fileIncludes: [] },
    ],
  },
  {
    file: "src/components/ui/sidebar.tsx",
    tokens: 0,
    sites: [{ anchor: 'data-slot="sidebar-input"', tag: "Input", drawn: "no checkbox", effect: "none", reading: PASS_THROUGH, tagIncludes: ["{...props}"], fileIncludes: [] }],
  },
  {
    file: "src/components/ui/command.tsx",
    tokens: 0,
    sites: [
      {
        anchor: '"w-full bg-transparent text-sm outline-hidden placeholder:text-muted-foreground',
        tag: "CommandPrimitive.Input",
        drawn: "no checkbox",
        effect: "none",
        reading: "the search field of the command menu: cmdk's Command.Input, which renders a text input",
        tagIncludes: ["{...props}"],
        fileIncludes: ['import { Command as CommandPrimitive } from "cmdk"'],
      },
      {
        anchor: '"w-full text-sm outline-hidden disabled:cursor-not-allowed',
        tag: "CommandPrimitive.Input",
        drawn: "no checkbox",
        effect: "none",
        reading: "the second search-field variant of the command menu: cmdk's Command.Input, which renders a text input",
        tagIncludes: ["{...props}"],
        fileIncludes: ['import { Command as CommandPrimitive } from "cmdk"'],
      },
    ],
  },
  {
    file: "src/components/ui/input-otp.tsx",
    tokens: 0,
    sites: [
      {
        anchor: "data-slot='input-otp'",
        tag: "OTPInput",
        drawn: "no checkbox",
        effect: "none",
        reading: "the one-time-code field: input-otp's OTPInput, which renders one text input for the code",
        tagIncludes: ["{...props}"],
        fileIncludes: ["import { OTPInput, OTPInputContext } from 'input-otp'"],
      },
      {
        anchor: "inputOTPContext?.slots[index] ?? {}",
        tag: "inputOTPContext?.slots[index]",
        drawn: "no checkbox",
        effect: "none",
        reading: "the state of one slot of the code field from input-otp's context (its character, caret and focus), which the slot draws as text",
        tagIncludes: [],
        fileIncludes: ["const { char, hasFakeCaret, isActive } = inputOTPContext?.slots[index] ?? {}"],
      },
      { anchor: "data-slot='input-otp-separator'", tag: "div", drawn: "no checkbox", effect: "none", reading: ROLE_PASS_THROUGH, tagIncludes: ["{...props}"], fileIncludes: [] },
    ],
  },
  {
    file: "src/app/api/admin/operations/jobs/[...trpc]/route.ts",
    tokens: 0,
    sites: [
      {
        anchor: "[procedurePath]",
        tag: "(\n    appRouter._def.procedures as Record<string, { _def?: { type?: string } }>\n  )[procedurePath]",
        drawn: "no checkbox",
        effect: "none",
        reading: "a procedure of the queue dashboard's tRPC router, looked up by its path on the server to read its type (query or mutation): it draws nothing",
        tagIncludes: [],
        fileIncludes: ['import { appRouter } from "@queuedash/api";', "const type = proc?._def?.type;"],
      },
    ],
  },
  {
    file: "src/components/app-shell.tsx",
    tokens: 0,
    sites: [
      { anchor: '=== "edit"', tag: "segments[segments.length - 1]", drawn: "no checkbox", effect: "none", reading: PATH_SEGMENTS, tagIncludes: [], fileIncludes: ['const segments = pathname.split("/").filter(Boolean);'] },
      { anchor: '=== "new"', tag: "segments[segments.length - 1]", drawn: "no checkbox", effect: "none", reading: PATH_SEGMENTS, tagIncludes: [], fileIncludes: [] },
      { anchor: '=== "review"', tag: "segments[segments.length - 1]", drawn: "no checkbox", effect: "none", reading: PATH_SEGMENTS, tagIncludes: [], fileIncludes: [] },
      { anchor: '=== "send"', tag: "segments[segments.length - 1]", drawn: "no checkbox", effect: "none", reading: PATH_SEGMENTS, tagIncludes: [], fileIncludes: [] },
      { anchor: ": segments[segments.length - 1]", tag: "segments[segments.length - 1]", drawn: "no checkbox", effect: "none", reading: PATH_SEGMENTS, tagIncludes: [], fileIncludes: ["return `${humanizePathSegment(preferredSegment)} | Cinatra`;"] },
    ],
  },
  {
    file: "src/app/artifacts/[id]/dynamic-renderer-loader.tsx",
    tokens: 0,
    sites: [],
    loads: { count: 1, modules: "import\\(descriptor\\.digestPinnedUrl\\)", reading: EXTENSION_LOADS },
  },
  {
    file: "src/lib/extension-runtime-activate.ts",
    tokens: 0,
    sites: [],
    loads: { count: 1, modules: "import\\(pathToFileURL\\(realAbs\\)\\.href\\)", reading: EXTENSION_LOADS },
  },
  {
    file: "src/lib/runtime-package-loader.ts",
    tokens: 0,
    sites: [],
    loads: { count: 1, modules: "import\\(pathToFileURL\\(realAbs\\)\\.href\\)", reading: EXTENSION_LOADS },
  },
  {
    file: "src/lib/widget-stream-agents.server.ts",
    tokens: 0,
    sites: [],
    loads: { count: 1, modules: "import\\(pathToFileURL\\(realAbs\\)\\.href\\)", reading: EXTENSION_LOADS },
  },
  {
    file: "src/components/ui/dropzone.tsx",
    tokens: 0,
    sites: [
      {
        anchor: "{...context.getInputProps({",
        tag: "input",
        drawn: "no checkbox",
        effect: "none",
        reading: "the hidden file input of the dropzone: react-dropzone's getInputProps sets its type to file",
        tagIncludes: ["{...context.getInputProps({"],
        fileIncludes: ['} from "react-dropzone";'],
      },
      { anchor: 'role="progressbar"', tag: "div", drawn: "no checkbox", effect: "none", reading: ROLE_PASS_THROUGH, tagIncludes: ["{...props}"], fileIncludes: [] },
    ],
  },
  {
    file: "src/app/projects/new/new-project-form.tsx",
    tokens: 0,
    sites: [
      {
        anchor: 'placeholder="e.g. Q3 outbound campaign"',
        tag: "Input",
        drawn: "no checkbox",
        effect: "none",
        reading: RHF_FIELD,
        tagIncludes: ["{...field}"],
        fileIncludes: ["render={({ field }) => ("],
      },
    ],
  },
  {
    file: "packages/agents/src/trigger-screen-client.tsx",
    tokens: 0,
    sites: [
      { anchor: '{...register("scheduledAt" as never)}', tag: "Input", drawn: "no checkbox", effect: "none", reading: RHF_REGISTER, tagIncludes: ['{...register("scheduledAt" as never)}'], fileIncludes: [] },
      { anchor: '{...register("cronExpression" as never)}', tag: "Input", drawn: "no checkbox", effect: "none", reading: RHF_REGISTER, tagIncludes: ['{...register("cronExpression" as never)}'], fileIncludes: [] },
    ],
  },
  {
    file: "src/components/ui/toolbar.tsx",
    tokens: 0,
    sites: [
      { anchor: 'data-slot="toolbar"', tag: "div", drawn: "no checkbox", effect: "none", reading: ROLE_PASS_THROUGH, tagIncludes: ["{...props}"], fileIncludes: [] },
      { anchor: 'data-slot="toolbar-child"', tag: "div", drawn: "no checkbox", effect: "none", reading: ROLE_PASS_THROUGH, tagIncludes: ["{...props}"], fileIncludes: [] },
      { anchor: 'data-slot="toolbar-search-input"', tag: "input", drawn: "no checkbox", effect: "none", reading: PASS_THROUGH, tagIncludes: ["{...props}"], fileIncludes: [] },
    ],
  },

  // ---- elements with a role of their own and a spread after it (rule 4: unresolved), read by hand ----------------------
  {
    file: "src/components/reui/stepper.tsx",
    tokens: 0,
    sites: [
      { anchor: 'data-slot="stepper"', tag: "div", drawn: "no checkbox", effect: "none", reading: ROLE_PASS_THROUGH, tagIncludes: ["{...props}"], fileIncludes: [] },
      {
        anchor: 'role="tab"',
        tag: "Button",
        drawn: "no checkbox",
        effect: "none",
        reading: ROLE_PASS_THROUGH,
        tagIncludes: ["onClick={() => setActiveStep(step)}", "onKeyDown={handleKeyDown}", "{...props}"],
        fileIncludes: [],
      },
    ],
  },
  {
    file: "src/components/ui/alert.tsx",
    tokens: 0,
    sites: [{ anchor: "data-slot='alert'", tag: "div", drawn: "no checkbox", effect: "none", reading: ROLE_PASS_THROUGH, tagIncludes: ["{...props}"], fileIncludes: [] }],
  },
  {
    file: "src/components/ui/breadcrumb.tsx",
    tokens: 0,
    sites: [
      { anchor: 'data-slot="breadcrumb-page"', tag: "span", drawn: "no checkbox", effect: "none", reading: ROLE_PASS_THROUGH, tagIncludes: ["{...props}"], fileIncludes: [] },
      { anchor: 'data-slot="breadcrumb-separator"', tag: "li", drawn: "no checkbox", effect: "none", reading: ROLE_PASS_THROUGH, tagIncludes: ["{...props}"], fileIncludes: [] },
      { anchor: 'data-slot="breadcrumb-ellipsis"', tag: "span", drawn: "no checkbox", effect: "none", reading: ROLE_PASS_THROUGH, tagIncludes: ["{...props}"], fileIncludes: [] },
    ],
  },
  {
    file: "src/components/ui/button.tsx",
    tokens: 0,
    sites: [{ anchor: 'role="status"', tag: "Loader2Icon", drawn: "no checkbox", effect: "none", reading: ROLE_PASS_THROUGH, tagIncludes: ["{...props}"], fileIncludes: [] }],
  },
  {
    file: "src/components/ui/pagination.tsx",
    tokens: 0,
    sites: [{ anchor: 'data-slot="pagination"', tag: "nav", drawn: "no checkbox", effect: "none", reading: ROLE_PASS_THROUGH, tagIncludes: ["{...props}"], fileIncludes: [] }],
  },
  // ---- G1: module objects handed on whole, and loads of modules outside the tree ----------------------------------
  {
    file: "packages/agents/src/cli/extract-agent-package-cli.ts",
    tokens: 0,
    sites: [{ anchor: "createRedactingPacote(pacoteImpl)", tag: "pacoteImpl", drawn: "no checkbox", effect: "none", reading: SERVER_MODULE, tagIncludes: [], fileIncludes: ['import * as pacoteImpl from "pacote";'] }],
  },
  {
    file: "packages/agents/src/trigger-service.ts",
    tokens: 0,
    sites: [
      {
        anchor: "resolveCronParser(mod)",
        tag: "mod",
        drawn: "no checkbox",
        effect: "none",
        reading: SERVER_MODULE,
        tagIncludes: [],
        fileIncludes: ['const mod = (await import("cron-parser")) as unknown as CronParserModule;', "const candidates = [mod.CronExpressionParser, mod.default?.CronExpressionParser, mod.default];"],
      },
    ],
  },
  {
    file: "packages/agents/src/verdaccio/client.ts",
    tokens: 0,
    sites: [{ anchor: "createRedactingPacote(pacoteImpl)", tag: "pacoteImpl", drawn: "no checkbox", effect: "none", reading: SERVER_MODULE, tagIncludes: [], fileIncludes: ['import * as pacoteImpl from "pacote";'] }],
  },
  {
    file: "packages/registries/src/verdaccio/client.ts",
    tokens: 0,
    sites: [{ anchor: "createRedactingPacote(pacoteImpl)", tag: "pacoteImpl", drawn: "no checkbox", effect: "none", reading: SERVER_MODULE, tagIncludes: [], fileIncludes: ['import * as pacoteImpl from "pacote";'] }],
  },
  {
    file: "packages/cli/src/prod-extension-acquisition.mjs",
    tokens: 0,
    sites: [
      { anchor: "inspectTarball(tarBuffer, { tar })", tag: "tar", drawn: "no checkbox", effect: "none", reading: SERVER_MODULE, tagIncludes: [], fileIncludes: ['const tar = await import("tar");', "export async function inspectTarball(tarBuffer, { tar }) {"] },
      { anchor: "extractVerifiedTarball(tarBuffer, tmpDir, { tar })", tag: "tar", drawn: "no checkbox", effect: "none", reading: SERVER_MODULE, tagIncludes: [], fileIncludes: ["export async function extractVerifiedTarball(tarBuffer, destDir, { tar }) {"] },
    ],
  },
  { file: "packages/chat/src/mermaid-block.tsx", tokens: 0, sites: [], loads: { count: 1, modules: "mermaid", reading: LIBRARY_LOADS } },
  { file: "packages/chat/src/syntax-highlight.ts", tokens: 0, sites: [], loads: { count: 1, modules: "shiki", reading: LIBRARY_LOADS } },
  {
    file: "packages/dashboards/src/components/bar-chart-legend-clearance-plugin.ts",
    tokens: 0,
    sites: [],
    loads: { count: 2, modules: "drizzle-cube/client(?:/charts)?", reading: "the chart library's two modules loaded together for their chart config and plugin registry, read by name: they draw no checkbox" },
  },
  { file: "packages/errors/src/server.ts", tokens: 0, sites: [], loads: { count: 1, modules: "@sentry/nextjs", reading: "the error-reporting library's namespace loaded on the server to report errors: it draws nothing" } },
  { file: "src/instrumentation.ts", tokens: 0, sites: [], loads: { count: 1, modules: "@sentry/nextjs", reading: "the error-reporting library loaded for its request-error capture, read by name in the then callback: it draws nothing" } },
  { file: "src/lib/better-auth-org-hooks.ts", tokens: 0, sites: [], loads: { count: 1, modules: "drizzle-orm", reading: "the database query library loaded beside the auth database for its eq operator, read by name: it draws nothing" } },
  { file: "src/lib/organization-archive-guard.ts", tokens: 0, sites: [], loads: { count: 1, modules: "drizzle-orm", reading: "the database query library loaded beside the auth database for its eq operator, read by name: it draws nothing" } },
  { file: "src/lib/organization-dispatch-policy.ts", tokens: 0, sites: [], loads: { count: 3, modules: "drizzle-orm", reading: "the database query library loaded beside the auth database for its sql template tag, read by name in three queries: it draws nothing" } },
  { file: "src/lib/generated/artifact-renderers.ts", tokens: 0, sites: [], loads: { count: 36, modules: "@cinatra-ai/[a-z0-9-]+-artifacts?/src/renderers/[a-z-]+", reading: EXTENSION_LOADS } },
  { file: "src/lib/generated/chat-views.ts", tokens: 0, sites: [], loads: { count: 1, modules: "@cinatra-ai/[a-z0-9-]+-artifact/src/views/[a-z-]+", reading: EXTENSION_LOADS } },
  { file: "src/lib/generated/connector-setup-pages.ts", tokens: 0, sites: [], loads: { count: 23, modules: "@cinatra-ai/[a-z0-9-]+-connector/(?:setup|settings)-page", reading: EXTENSION_LOADS } },
  { file: "src/lib/generated/extensions.server.ts", tokens: 0, sites: [], loads: { count: 89, modules: "@cinatra-ai/[a-z0-9-]+(?:/[a-z0-9-]+)*", reading: EXTENSION_LOADS } },
  {
    file: "src/lib/generated/field-renderer-components.ts",
    tokens: 0,
    sites: [],
    loads: { count: 14, modules: "@cinatra-ai/[a-z0-9-]+-agents?/src/[a-z0-9/-]+|@cinatra-ai/email-artifacts/src/renderers/[a-z-]+", reading: EXTENSION_LOADS },
  },
  { file: "src/lib/generated/webhooks.server.ts", tokens: 0, sites: [], loads: { count: 2, modules: "@cinatra-ai/[a-z0-9-]+-connector/src/webhooks/[a-z-]+", reading: EXTENSION_LOADS } },
];

const MULTI_SELECT =
  "it is one option of a multi-select scope filter: the drawing gives several options of one choice as a multi-select and draws it with checkboxes, while a switch is one on/off setting";

/**
 * The shared components whose box is read at their callers: the multi-select
 * access picker (its option rows draw the box), the upload consent block (it
 * hands the tick to its caller's install) and the upload-time permissions draft
 * (a caller of the picker). Each call site (one JSX element) is found under
 * every name the component goes by and has its own reading.
 */
export const COMPONENT_CALLERS: ComponentCallers[] = [
  {
    component: "AccessCombobox",
    callerWhen: {
      attribute: "selectionMode",
      values: ["multiple"],
      absent: { file: "packages/sdk-ui/src/access-combobox.tsx", text: 'if (props.selectionMode === "multiple") {' },
    },
    why: "an element that sets selectionMode to multiple, sets it by an expression the syntax cannot settle or spreads props that may set it is a call site of the multi-select picker; the default mode is single (packages/sdk-ui/src/access-combobox.tsx)",
    callers: [
      {
        file: "packages/extensions/src/screens/extension-access-control.tsx",
        anchor: 'id="extension-access-picker"',
        effect: "confirmed",
        reading: "an extension's access: a change sets local state, and the Save button beneath it writes it",
        tagIncludes: ["onChange={(next) => {\n          setValue(next);\n          setStatus(null);\n        }}"],
        fileIncludes: ["const result = await save(value);", '{pending ? "Saving…" : "Save"}'],
      },
      {
        file: "packages/sdk-ui/src/permissions-panel.tsx",
        anchor: "value={f.value}",
        effect: "confirmed",
        reading: "the access field of the permissions form: a change sets the form value, and the form's submit writes it",
        tagIncludes: ["onChange={f.onChange}"],
        fileIncludes: ["onSubmit={handleSubmit(onSubmit)}", '<Button type="submit" disabled={isSavingPolicy}>'],
      },
      {
        file: "src/components/permissions-form-draft.tsx",
        anchor: "onChange={setAccess}",
        effect: "none",
        reading:
          "the upload-time access draft's picker: PermissionsFormDraft is rendered by no file of the tree (its caller list below is empty), so its picker applies nothing today",
        tagIncludes: ["onChange={setAccess}"],
        fileIncludes: ["onChange={setAccess}"],
      },
      {
        file: "packages/skills/src/skills-toolbar.tsx",
        anchor: 'id="skills-scope-filter"',
        effect: "immediate",
        reading: "the scope filter of the skills list: a change narrows the list at once by its URL",
        tagIncludes: ["onChange={selectScope}"],
        fileIncludes: ["onChange={selectScope}", "router.push(qs ? `${pathname}?${qs}` : pathname);"],
        staysBecause: MULTI_SELECT,
      },
      {
        file: "src/components/scope-filter-combobox.tsx",
        anchor: "onChange={handleChange}",
        effect: "immediate",
        reading: "the shared scope filter of the list pages: a change narrows the list at once by its URL",
        tagIncludes: ["onChange={handleChange}"],
        fileIncludes: ["onChange={handleChange}", "router.push(query ? `${pathname}?${query}` : pathname);"],
        staysBecause: MULTI_SELECT,
      },
      ...[
        ["value={live}", "the interactive multi-select fixture: a change only sets the fixture's local state, nothing is saved", "onChange={setLive}"],
        ['value={["owner"]} onChange={() => {}} scopes={SEED_SCOPES} />', "the closed Personal trigger fixture: its change handler does nothing, nothing is saved", "onChange={() => {}}"],
        ['value={["team:team-rev"]}', "the closed single-team trigger fixture: its change handler does nothing, nothing is saved", "onChange={() => {}}"],
        ['value={["team:team-rev", "org:org-beta", "project:proj-atlas"]}', "the closed multi-scope trigger fixture: its change handler does nothing, nothing is saved", "onChange={() => {}}"],
        ['value={["workspace"]}', "the closed Workspace trigger fixture: its change handler does nothing, nothing is saved", "onChange={() => {}}"],
        ['parentScope={{ kind: "org", id: "org-acme" }}', "the parent-scope fixture: its change handler does nothing, nothing is saved", "onChange={() => {}}"],
      ].map(([anchor, reading, handler]) => ({
        file: "src/app/design-fixtures/access-picker/access-picker-fixture.tsx",
        anchor,
        effect: "none" as const,
        reading,
        tagIncludes: [handler],
        fileIncludes: [],
      })),
    ],
  },
  {
    component: "UploadConsentBlock",
    why: "every use of the upload consent block is a call site: the block's box only hands the tick to the caller's state",
    callers: [
      {
        file: "packages/agents/src/import-form.tsx",
        anchor: "onCheckedChange={setConsentChecked}",
        effect: "confirmed",
        reading: "the archive upload's consent: a tick sets the form's state, and the install action sends it with the install the panel's Install button starts",
        tagIncludes: ["onCheckedChange={setConsentChecked}"],
        fileIncludes: [
          "onCheckedChange={setConsentChecked}",
          "const consent = consentPayload(consentPrompt, consentChecked);",
          "...(consent ? { anthropicUploadConsent: consent } : {}),",
          "installAction={installAction}",
        ],
        evidence: [
          { file: "packages/agents/src/upload-install-scope-panel.tsx", text: "<InstallPanelScopeProvider value={{ ...scope, installAction }}>" },
          { file: "packages/extensions/src/screens/extension-install-scope-panel.tsx", text: "const result = await installAction({" },
        ],
      },
      {
        file: "packages/agents/src/upload-repository-link-form.tsx",
        anchor: "onCheckedChange={setConsentChecked}",
        effect: "confirmed",
        reading: "the repository-link upload's consent: a tick sets the form's state, and the install action sends it with the install the panel's Install button starts",
        tagIncludes: ["onCheckedChange={setConsentChecked}"],
        fileIncludes: [
          "onCheckedChange={setConsentChecked}",
          "const consent = consentPayload(consentPrompt, consentChecked);",
          "...(consent ? { anthropicUploadConsent: consent } : {}),",
          "installAction={installAction}",
        ],
        evidence: [
          { file: "packages/agents/src/upload-install-scope-panel.tsx", text: "<InstallPanelScopeProvider value={{ ...scope, installAction }}>" },
          { file: "packages/extensions/src/screens/extension-install-scope-panel.tsx", text: "const result = await installAction({" },
        ],
      },
    ],
  },
  {
    component: "PermissionsFormDraft",
    why: "every use of the upload-time permissions draft would be a call site of its access picker, and the tree has none today",
    callers: [],
  },
];
