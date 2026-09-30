// The maintained steps the end-to-end suites and the picture rounds drive the
// product through. See README.md beside this file for what each one guarantees.
//
// Plain ESM with JSDoc types, importing only Node's builtins and its own files:
// a Playwright suite imports it, and so can a plain Node process with the
// checkout's own `@playwright/test`.
export { FRAME_BOUND_MS, READING_BOUND_MS, StepRefusal } from "./step-kit.mjs";
export {
  SIGN_IN_ACTION_BOUND_MS,
  SIGN_IN_ALLOWANCE,
  SIGN_IN_ANSWER_BOUND_MS,
  SIGN_IN_BOUNDS,
  SIGN_IN_HYDRATION_BOUND_MS,
  SIGN_IN_HYDRATION_MARK,
  SIGN_IN_HYDRATION_POLL_MS,
  SIGN_IN_NAVIGATION_BOUND_MS,
  SIGN_IN_PAGE_PATH,
  SIGN_IN_REQUEST_BOUND_MS,
  SIGN_IN_REQUEST_PATHS,
  SIGN_IN_SELECTORS,
  createSignInBudget,
  signInThroughPage,
} from "./sign-in-through-page.mjs";
export {
  ISLAND_FRAME_SRC_PATH,
  ISLAND_POLL_MS,
  ISLAND_SELECTOR,
  ISLAND_SETTLED_STATE,
  ISLAND_STATE_ATTRIBUTE,
  ISLAND_WAIT_BOUND_MS,
  waitForIsland,
} from "./wait-for-island.mjs";
export {
  RUN_COMPLETION_SELECTOR,
  RUN_OUTPUT_PENDING,
  RUN_SETTLED_STATUSES,
  RUN_STATUS_SELECTOR,
  RUN_SURFACE_SELECTOR,
  RUN_WATCH_BOUND_MS,
  RUN_WATCH_POLL_MS,
  watchRun,
} from "./watch-run.mjs";
export { COUNT_BOUND_MS, COUNT_POLL_MS, COUNT_SETTLE_MS, readCount } from "./read-count.mjs";
export {
  FURTHER_PAGE_MODIFIER,
  NAVIGATE_ACTION_BOUND_MS,
  NAVIGATE_BOUNDS,
  NAVIGATE_LANDING_BOUND_MS,
  NAVIGATE_START_BOUND_MS,
  navigateTo,
} from "./navigate-to.mjs";
export {
  CONNECTIONS_KEPT_FREE,
  MULTIPLEXED_PROTOCOLS,
  ORIGIN_CONNECTIONS,
  STANDING_BOUNDS,
  STANDING_REQUEST_BOUND,
  readStandingRequests,
} from "./read-standing-requests.mjs";
// readRows, the landing of signInThroughPage, dispatchRun, press and selectFrom.
export { SIGN_IN_LANDING_BOUND_MS, SIGN_IN_READY_SELECTORS } from "./sign-in-through-page.mjs";
export { READ_ROWS_BOUNDS, READ_ROWS_BOUND_MS, READ_ROWS_LIMIT, readRows } from "./read-rows.mjs";
export { CONTROL_ACTION_BOUND_MS, CONTROL_MARK, CONTROL_NAMES_LISTED, CONTROL_POLL_MS } from "./page-controls.mjs";
export { PRESS_BOUNDS, PRESS_ROLES, PRESS_SETTLE_BOUND_MS, PRESS_START_BOUND_MS, press } from "./press.mjs";
export { SELECT_BOUNDS, SELECT_REFLECT_BOUND_MS, selectFrom } from "./select-from.mjs";
export {
  DISPATCH_RUN_BOUNDS,
  DISPATCH_RUN_BOUND_MS,
  DISPATCH_RUN_COMPOSER,
  DISPATCH_RUN_COMPOSER_BOUND_MS,
  DISPATCH_RUN_CONTROL,
  DISPATCH_RUN_ERROR_SELECTOR,
  DISPATCH_RUN_NOTIFICATION_SELECTOR,
  DISPATCH_RUN_SELECTOR,
  dispatchRun,
} from "./dispatch-run.mjs";
// readControlNames: every shown control of a page, by its role and its name.
export { READ_CONTROL_NAMES_BOUNDS, READ_CONTROL_NAMES_LIMIT, READ_CONTROL_NAME_LENGTH, readControlNames } from "./read-control-names.mjs";
// armPageTape and readPageTape: the document's time origin and the main frame's navigations.
export { PAGE_TAPE_BOUNDS, armPageTape, readPageTape } from "./page-tape.mjs";
// uploadFile, fillForm, switchTheme and decideGate: the steps that drive a
// page's own controls.
export {
  UPLOAD_ACTION_BOUND_MS,
  UPLOAD_BOUNDS,
  UPLOAD_CHOOSER_BOUND_MS,
  UPLOAD_CONTROL_BOUND_MS,
  UPLOAD_POLL_MS,
  UPLOAD_ROW_BOUND_MS,
  UPLOAD_ROW_SELECTOR,
  uploadFile,
} from "./upload-file.mjs";
export {
  FIELD_ERROR_SELECTOR,
  FORM_ACTION_BOUND_MS,
  FORM_BOUNDS,
  FORM_ERROR_BOUND_MS,
  FORM_FIELDS_BOUND_MS,
  FORM_POLL_MS,
  FORM_SCOPE_SELECTOR,
  fillForm,
} from "./fill-form.mjs";
export {
  ISLAND_THEME_ATTRIBUTE,
  ISLAND_THEME_SELECTOR,
  THEME_ACTION_BOUND_MS,
  THEME_APPLIED_BOUND_MS,
  THEME_BOUNDS,
  THEME_CONTROL_BOUND_MS,
  THEME_CONTROL_NAME,
  THEME_POLL_MS,
  THEME_ROOT_CLASSES,
  switchTheme,
} from "./switch-theme.mjs";
export {
  GATE_ACTION_BOUND_MS,
  GATE_BOUNDS,
  GATE_FIND_BOUND_MS,
  GATE_LEAVE_BOUND_MS,
  GATE_LEFT_STATES,
  GATE_POLL_MS,
  GATE_SELECTOR,
  GATE_STATE_ATTRIBUTE,
  GATE_WAITING_STATUS,
  decideGate,
} from "./decide-gate.mjs";
// typeInWindow, waitForTurn, reloadPage, sendInComposer and openAddress: a
// window's text box, a turn of its conversation, a reload, a composer's message
// answered with a card, and an address no link leads to.
export {
  RUN_WINDOW_ENTRY_ATTRIBUTE,
  RUN_WINDOW_FIELD,
  TYPE_IN_WINDOW_BOUNDS,
  WINDOW_FIELD_BOUND_MS,
  WINDOW_SENT_BOUND_MS,
  typeInWindow,
} from "./type-in-window.mjs";
export { TURN_BOUND_MS, TURN_CEILING_MS, TURN_POLL_MS, WAIT_FOR_TURN_BOUNDS, waitForTurn } from "./wait-for-turn.mjs";
export { RELOAD_BOUND_MS, RELOAD_PAGE_BOUNDS, reloadPage } from "./reload-page.mjs";
export {
  COMPOSER_CARD_BOUND_MS,
  COMPOSER_CARD_KIND_ATTRIBUTES,
  COMPOSER_CARD_SELECTOR,
  COMPOSER_ERROR_SELECTOR,
  SEND_IN_COMPOSER_BOUNDS,
  sendInComposer,
} from "./send-in-composer.mjs";
export { OPEN_ADDRESS_BOUNDS, OPEN_ADDRESS_BOUND_MS, openAddress } from "./open-address.mjs";
// pressByTestId and readTitle: an element without a role pressed by its test id
// and its text, and the page's title.
export { PRESS_BY_TEST_ID_BOUNDS, TEST_ID_ATTRIBUTE, pressByTestId } from "./press-by-test-id.mjs";
export { TITLE_BOUND_MS, TITLE_POLL_MS, TITLE_SETTLE_MS, readTitle } from "./read-title.mjs";
// openPageInOwnContext: a further page in a browser context of its own, signed
// in by the session the first page carries.
export { OWN_CONTEXT_BOUNDS, OWN_CONTEXT_LANDING_BOUND_MS, openPageInOwnContext } from "./open-page-in-own-context.mjs";
