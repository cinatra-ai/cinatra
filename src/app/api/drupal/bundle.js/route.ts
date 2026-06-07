// Cinatra Drupal widget bundle endpoint.
// Rev 4 — submit inside box, rectangular prompt (border-radius:16px), unified widget
//          container (panel+pill stacked), top-left corner drag to resize both at once.
//
// Logo paths sourced from src/lib/cinatra-brand.ts — the single source of truth.

import { CINATRA_LOGO, CINATRA_THEME } from "@/lib/cinatra-brand";

export async function GET() {
  const widgetIIFE = `(function () {
  // ---------------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------------
  var config = (window.drupalSettings && window.drupalSettings.cinatra) || {};
  if (!config.cinatraUrl || !config.apiKey) {
    console.warn('[cinatra] Missing drupalSettings.cinatra');
    return;
  }
  var rootEl = document.getElementById('cinatra-root');
  if (!rootEl) { console.warn('[cinatra] #cinatra-root not found'); return; }
  if (rootEl.dataset.cinatraMounted === 'true') return;
  rootEl.dataset.cinatraMounted = 'true';

  // ---------------------------------------------------------------------------
  // Shadow DOM
  // ---------------------------------------------------------------------------
  var shadow = rootEl.attachShadow({ mode: 'open' });

  // ---------------------------------------------------------------------------
  // CSS
  // Collapsed: single logo circle (position:fixed, bottom-right).
  // Expanded:  .cw-widget flex-column (panel on top, pill on bottom), same anchor.
  //            Drag the top-left corner (.cw-resize) to resize width + panel height.
  // ---------------------------------------------------------------------------
  var style = document.createElement('style');
  style.textContent = [
    ':host { all: initial; }',

    /* Collapsed logo circle — same size/position as the submit button inside the pill.
       Pill padding-bottom:10px → bottom: 56+10=66px.
       Pill padding-right:12px  → right: 24+12=36px.
       Submit button: 32×32px. */
    '.cw-circle {',
    '  position: fixed; bottom: 66px; right: 36px;',
    '  width: 32px; height: 32px; border-radius: 9999px;',
    '  background: ${CINATRA_THEME.accentSoft}; border: 1.5px solid ${CINATRA_THEME.logoColor}; cursor: pointer;',
    '  display: flex; align-items: center; justify-content: center;',
    '  box-shadow: 0 4px 16px rgba(0,0,0,0.18);',
    '  transition: background 0.15s; z-index: 10000000;',
    '  touch-action: none;',
    '}',
    '.cw-circle:hover { background: ${CINATRA_THEME.accentSoftHover}; }',

    /* Expanded widget: position:fixed container, panel+pill both absolutely placed.
       Pill is at bottom:0 and grows upward, overlapping the panel — panel stays put.
       JS sets: width, height = panelH + PILL_GAP + PILL_MIN_H */
    '.cw-widget {',
    '  position: fixed; bottom: 56px; right: 24px;',
    '  z-index: 10000000;',
    '}',

    /* Resize corner: top-left of widget, drag to resize width+height */
    '.cw-resize {',
    '  position: absolute; top: 0; left: 0;',
    '  width: 20px; height: 20px;',
    '  cursor: nwse-resize;',
    '  z-index: 3;',
    '}',

    /* Response panel: absolute top of widget, fixed height set by JS */
    '.cw-panel {',
    '  position: absolute; top: 0; left: 0; right: 0;',
    '  box-sizing: border-box;',
    '  background: ${CINATRA_THEME.surface}; color: ${CINATRA_THEME.foreground};',
    '  border: 1px solid ${CINATRA_THEME.line}; border-radius: 16px;',
    '  box-shadow: 0 16px 48px rgba(0,0,0,0.2);',
    '  display: flex; flex-direction: column; overflow: hidden;',
    '  z-index: 1;',
    '}',

    /* Panel header */
    '.cw-panel-header {',
    '  padding: 12px 16px; border-bottom: 1px solid ${CINATRA_THEME.line};',
    '  display: flex; align-items: center; justify-content: space-between;',
    '  background: ${CINATRA_THEME.sidebar}; flex-shrink: 0;',
    '}',
    '.cw-header-left { display: flex; align-items: center; gap: 8px; }',
    '.cw-wordmark { font: italic 800 14px ${CINATRA_THEME.fontFamily}; color: ${CINATRA_THEME.logoColor}; letter-spacing: -0.022em; }',
    '.cw-close {',
    '  background: none; border: none; cursor: pointer;',
    '  font-size: 20px; line-height: 1; color: ${CINATRA_THEME.muted};',
    '  padding: 2px 6px; border-radius: 6px;',
    '  display: flex; align-items: center; justify-content: center;',
    '}',
    '.cw-close:hover { background: ${CINATRA_THEME.surface}; color: ${CINATRA_THEME.foreground}; }',

    /* Messages */
    '.cw-messages {',
    '  flex: 1; overflow-y: auto; padding: 16px;',
    '  display: flex; flex-direction: column; gap: 12px;',
    '}',
    '.cw-msg { line-height: 1.6; max-width: 88%; }',
    '.cw-msg-user {',
    '  align-self: flex-end; background: ${CINATRA_THEME.foreground}; color: ${CINATRA_THEME.accentForeground};',
    '  padding: 8px 14px; border-radius: 18px;',
    '  font: 14px system-ui, sans-serif; white-space: pre-wrap;',
    '}',
    '.cw-msg-assistant {',
    '  align-self: flex-start; color: ${CINATRA_THEME.foreground};',
    '  font: 14px/1.6 system-ui, sans-serif;',
    '}',
    '.cw-msg-assistant p { margin: 4px 0; }',
    '.cw-msg-assistant p:first-child { margin-top: 0; }',
    '.cw-msg-assistant p:last-child { margin-bottom: 0; }',
    '.cw-msg-assistant h1,.cw-msg-assistant h2,.cw-msg-assistant h3 { font-weight:600; margin:12px 0 4px; line-height:1.3; }',
    '.cw-msg-assistant h1 { font-size:1.2em; }',
    '.cw-msg-assistant h2 { font-size:1.08em; }',
    '.cw-msg-assistant h3 { font-size:1em; }',
    '.cw-msg-assistant ul,.cw-msg-assistant ol { margin:6px 0; padding-left:20px; }',
    '.cw-msg-assistant li { margin:2px 0; }',
    '.cw-msg-assistant code { background:${CINATRA_THEME.surface}; padding:1px 5px; border-radius:4px; font-family:ui-monospace,monospace; font-size:0.88em; }',
    '.cw-msg-assistant pre { background:${CINATRA_THEME.surface}; padding:12px; border-radius:8px; overflow-x:auto; margin:8px 0; }',
    '.cw-msg-assistant pre code { background:none; padding:0; font-size:0.88em; }',
    '.cw-msg-assistant strong { font-weight:600; }',
    '.cw-msg-assistant em { font-style:italic; }',
    '.cw-msg-assistant a { color:${CINATRA_THEME.accent}; text-decoration:underline; }',
    '.cw-msg-assistant blockquote { border-left:3px solid ${CINATRA_THEME.line}; padding-left:12px; margin:6px 0; color:${CINATRA_THEME.muted}; }',
    '.cw-msg-assistant table { border-collapse:collapse; margin:8px 0; font-size:0.9em; }',
    '.cw-msg-assistant th,.cw-msg-assistant td { border:1px solid ${CINATRA_THEME.line}; padding:6px 10px; text-align:left; }',
    '.cw-msg-assistant th { background:${CINATRA_THEME.surface}; font-weight:600; }',
    '.cw-msg-assistant hr { border:none; border-top:1px solid ${CINATRA_THEME.line}; margin:8px 0; }',
    /* Thinking indicator: pulsating dot + 'Thinking...' label, mirroring ThinkingIndicator in packages/chat/src/chat-page.tsx (no shimmer in widget). */
    /* Spacer at the bottom of the panel — pushes the scrollable messages area to end above the pill,
       so the scrollbar track never extends into the pill overlap zone. Height set by setWidgetSize(). */
    '.cw-messages-spacer { flex-shrink: 0; pointer-events: none; }',

    '.cw-thinking { display:flex; align-items:center; gap:8px; color:${CINATRA_THEME.muted}; font-size:13px; }',
    '.cw-thinking-dot { position:relative; display:inline-flex; width:8px; height:8px; flex-shrink:0; }',
    '.cw-thinking-dot::before {',
    '  content:""; position:absolute; inset:0; border-radius:9999px;',
    '  background:${CINATRA_THEME.muted}; opacity:0.75;',
    '  animation: cw-ping 1s cubic-bezier(0,0,0.2,1) infinite;',
    '}',
    '.cw-thinking-dot::after {',
    '  content:""; position:relative; display:inline-block;',
    '  width:8px; height:8px; border-radius:9999px; background:${CINATRA_THEME.muted};',
    '}',
    '.cw-thinking-label { font-weight:500; color:${CINATRA_THEME.muted}; }',
    '@keyframes cw-ping {',
    '  75%, 100% { transform: scale(2); opacity: 0; }',
    '}',

    /* Prompt box: absolute bottom of widget, grows upward over the panel.
       align-items:flex-end keeps + and submit pinned to the bottom row.
       padding-bottom:14px gives the row a bit more lift from the bottom edge. */
    '.cw-pill {',
    '  position: absolute; bottom: 0; left: 0; right: 0;',
    '  background: ${CINATRA_THEME.surfaceStrong}; border: 1px solid ${CINATRA_THEME.line}; border-top: none;',
    '  border-radius: 0 0 16px 16px;',
    '  padding: 10px 12px;',
    '  display: flex; align-items: flex-end; gap: 10px;',
    '  box-sizing: border-box;',
    '  box-shadow: 0 4px 16px rgba(0,0,0,0.1);',
    '  z-index: 2;',
    '}',

    /* Flyout toggle (+): margin-bottom centers it with the 32px submit circle.
       + is ~20px tall → (32-20)/2 = 6px margin-bottom aligns centers. */
    '.cw-flyout-btn {',
    '  background: none; border: none; cursor: pointer; flex-shrink: 0;',
    '  color: ${CINATRA_THEME.muted}; font-size: 20px; line-height: 1;',
    '  font-family: system-ui, sans-serif; font-weight: 300;',
    '  padding: 0 2px; margin-bottom: 6px; display: flex; align-items: center;',
    '}',
    '.cw-flyout-btn:hover { color: ${CINATRA_THEME.accent}; }',
    '.cw-flyout-btn:active { color: ${CINATRA_THEME.accentHover}; }',

    /* Textarea: grows freely with no max-height; no scrollbar */
    '.cw-textarea {',
    '  flex: 1; border: none; outline: none; resize: none;',
    '  font: 15px/1.5 system-ui, -apple-system, sans-serif;',
    '  background: transparent; color: ${CINATRA_THEME.foreground};',
    '  min-height: 24px; overflow-y: hidden;',
    '  padding: 3px 0 0 0; margin: 0 0 4px;',
    '}',
    '.cw-textarea::placeholder { color: ${CINATRA_THEME.muted}; }',

    /* Submit circle inside the pill (bottom-right) */
    '.cw-submit {',
    '  width: 32px; height: 32px; border-radius: 9999px;',
    '  background: ${CINATRA_THEME.accent}; border: none; cursor: pointer;',
    '  display: flex; align-items: center; justify-content: center;',
    '  flex-shrink: 0; transition: background 0.15s;',
    '}',
    '.cw-submit:hover { background: ${CINATRA_THEME.accentHover}; }',
    '.cw-submit:disabled { opacity: 0.4; cursor: not-allowed; }',

    /* Flyout menu */
    '.cw-flyout-menu {',
    '  position: absolute; bottom: calc(100% + 10px); left: 0;',
    '  background: ${CINATRA_THEME.surfaceStrong}; border: 1px solid ${CINATRA_THEME.line};',
    '  border-radius: 12px; box-shadow: 0 8px 24px rgba(0,0,0,0.15);',
    '  padding: 6px; min-width: 180px; z-index: 10;',
    '}',
    '.cw-flyout-item {',
    '  display: block; width: 100%; box-sizing: border-box;',
    '  padding: 8px 12px; border: none; background: none;',
    '  text-align: left; font: 13px system-ui, sans-serif;',
    '  cursor: pointer; border-radius: 8px; color: ${CINATRA_THEME.foreground}; text-decoration: none;',
    '}',
    '.cw-flyout-item:hover { background: ${CINATRA_THEME.surfaceMuted}; }',

    /* Diff card — rendered inline in the message list after a content edit */
    '.cw-diff-card { align-self: flex-start; flex-shrink: 0; max-width: 88%; margin-top: 4px; margin-bottom: 4px; border: 1px solid ${CINATRA_THEME.line}; border-radius: 10px; overflow: hidden; font: 13px system-ui, sans-serif; }',
    '.cw-diff-card-header { padding: 6px 12px; background: ${CINATRA_THEME.surface}; border-bottom: 1px solid ${CINATRA_THEME.line}; font-weight: 600; color: ${CINATRA_THEME.muted}; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; }',
    '.cw-diff-row { display: flex; gap: 8px; padding: 6px 12px; align-items: baseline; min-width: 0; }',
    '.cw-diff-row + .cw-diff-row { border-top: 1px solid ${CINATRA_THEME.line}; }',
    '.cw-diff-field { font-weight: 600; color: ${CINATRA_THEME.foreground}; white-space: nowrap; flex-shrink: 0; }',
    '.cw-diff-values { display: flex; flex-direction: column; gap: 2px; min-width: 0; overflow: hidden; }',
    '.cw-diff-before { color: ${CINATRA_THEME.muted}; text-decoration: line-through; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.cw-diff-after { color: ${CINATRA_THEME.accent}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; }',
    '.cw-diff-footer { padding: 5px 12px; background: ${CINATRA_THEME.surfaceMuted}; color: ${CINATRA_THEME.muted}; font-size: 11px; border-top: 1px solid ${CINATRA_THEME.line}; }',
  ].join('\\n');
  shadow.appendChild(style);

  // Inject Archivo font into document head (fonts must be in document scope to work inside shadow DOM).
  // URL sourced from CINATRA_THEME.fontUrl in src/lib/cinatra-brand.ts.
  if (!document.querySelector('link[href="${CINATRA_THEME.fontUrl}"]')) {
    var fontLink = document.createElement('link');
    fontLink.rel = 'stylesheet';
    fontLink.href = '${CINATRA_THEME.fontUrl}';
    document.head.appendChild(fontLink);
  }

  // ---------------------------------------------------------------------------
  // SVG builders
  // ---------------------------------------------------------------------------
  var SVG_NS = 'http://www.w3.org/2000/svg';
  function mkEl(tag, attrs) {
    var el = document.createElementNS(SVG_NS, tag);
    for (var k in attrs) el.setAttribute(k, String(attrs[k]));
    return el;
  }
  function mkSvg(w, h, vb) { return mkEl('svg', { width: w, height: h, viewBox: vb, fill: 'none' }); }

  // Cinatra logo — logo-colored fedora on mint circle button
  // Paths and colors sourced from src/lib/cinatra-brand.ts (CINATRA_LOGO, CINATRA_THEME) at build time.
  function makeLogoSvg() {
    var svg = mkSvg(22, 14, '${CINATRA_LOGO.fullViewBox}');
    svg.setAttribute('fill', 'none');
    svg.appendChild(mkEl('path', { d: '${CINATRA_LOGO.brim}', fill: '${CINATRA_THEME.logoColor}' }));
    svg.appendChild(mkEl('path', { d: '${CINATRA_LOGO.crown}', fill: '${CINATRA_THEME.logoColor}' }));
    return svg;
  }

  // Cinatra logo — dark fedora on light panel header
  // Paths sourced from src/lib/cinatra-brand.ts (CINATRA_LOGO) at build time.
  function makeLogoDarkSvg() {
    // Spec §I rule 1: fedora height = wordmark font-size (14), width = 1.6×.
    var svg = mkSvg(22, 14, '${CINATRA_LOGO.fullViewBox}');
    svg.setAttribute('fill', 'none');
    svg.appendChild(mkEl('path', { d: '${CINATRA_LOGO.brim}', fill: '${CINATRA_THEME.logoColor}' }));
    svg.appendChild(mkEl('path', { d: '${CINATRA_LOGO.crown}', fill: '${CINATRA_THEME.logoColor}' }));
    return svg;
  }

  function makeArrowSvg() {
    var svg = mkSvg(14, 14, '0 0 24 24');
    svg.appendChild(mkEl('path', { d: 'M12 19V5', stroke: 'white', 'stroke-width': '2.5', 'stroke-linecap': 'round' }));
    svg.appendChild(mkEl('path', { d: 'M5 12l7-7 7 7', stroke: 'white', 'stroke-width': '2.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    return svg;
  }

  // ---------------------------------------------------------------------------
  // DOM: collapsed circle
  // ---------------------------------------------------------------------------
  var circle = document.createElement('button');
  circle.className = 'cw-circle';
  circle.type = 'button';
  circle.appendChild(makeLogoSvg());
  shadow.appendChild(circle);

  // ---------------------------------------------------------------------------
  // Circle drag-to-reposition: position helpers (session-only, no persistence)
  // ---------------------------------------------------------------------------
  function applyCirclePos(left, top) {
    circle.style.left = left + 'px';
    circle.style.top = top + 'px';
    circle.style.right = 'auto';
    circle.style.bottom = 'auto';
  }
  function clampCirclePos(left, top) {
    left = Math.max(0, Math.min(window.innerWidth - 32, left));
    top = Math.max(0, Math.min(window.innerHeight - 32, top));
    return { left: left, top: top };
  }

  // Circle drag state machine
  var circleDragging = false;
  var circleDragStartX = 0, circleDragStartY = 0;
  var circleDragStartLeft = 0, circleDragStartTop = 0;
  var circleDragMoved = false;
  var CIRCLE_DRAG_THRESHOLD = 4;

  circle.addEventListener('mousedown', function(e) {
    e.preventDefault();
    var rect = circle.getBoundingClientRect();
    circleDragStartX = e.clientX;
    circleDragStartY = e.clientY;
    circleDragStartLeft = rect.left;
    circleDragStartTop = rect.top;
    circleDragging = true;
    circleDragMoved = false;
  });

  // ---------------------------------------------------------------------------
  // DOM: expanded widget — panel + pill stacked
  // ---------------------------------------------------------------------------
  var currentWidth = 580;
  var currentPanelHeight = 440;
  // Min height of the pill (6+24+14 padding+textarea + 2px border) — used to
  // set the widget container height so absolute children have a reference.
  var PILL_MIN_H = 46;
  var PILL_GAP = 16;

  function setWidgetSize() {
    cwWidget.style.width = currentWidth + 'px';
    cwWidget.style.height = (currentPanelHeight + PILL_GAP + PILL_MIN_H) + 'px';
    panel.style.height = (currentPanelHeight + PILL_GAP + Math.floor(PILL_MIN_H / 2)) + 'px';
    spacerEl.style.height = (PILL_GAP + Math.floor(PILL_MIN_H / 2)) + 'px';
  }

  var cwWidget = document.createElement('div');
  cwWidget.className = 'cw-widget';
  cwWidget.style.display = 'none';
  shadow.appendChild(cwWidget);

  // Resize corner (top-left)
  var resizeEl = document.createElement('div');
  resizeEl.className = 'cw-resize';
  cwWidget.appendChild(resizeEl);

  // Response panel
  var panel = document.createElement('div');
  panel.className = 'cw-panel';
  cwWidget.appendChild(panel);

  var panelHeader = document.createElement('div');
  panelHeader.className = 'cw-panel-header';
  panel.appendChild(panelHeader);

  var headerLeft = document.createElement('div');
  headerLeft.className = 'cw-header-left';
  headerLeft.appendChild(makeLogoDarkSvg());
  var wordmark = document.createElement('span');
  wordmark.className = 'cw-wordmark';
  wordmark.textContent = 'Cinatra';
  headerLeft.appendChild(wordmark);
  panelHeader.appendChild(headerLeft);

  var closeBtn = document.createElement('button');
  closeBtn.className = 'cw-close';
  closeBtn.type = 'button';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.textContent = '×';
  panelHeader.appendChild(closeBtn);

  var messagesEl = document.createElement('div');
  messagesEl.className = 'cw-messages';
  messagesEl.setAttribute('role', 'log');
  messagesEl.setAttribute('aria-live', 'polite');
  panel.appendChild(messagesEl);

  var spacerEl = document.createElement('div');
  spacerEl.className = 'cw-messages-spacer';
  panel.appendChild(spacerEl);

  // Prompt box (pill)
  var pill = document.createElement('div');
  pill.className = 'cw-pill';
  cwWidget.appendChild(pill);

  // Flyout menu (absolute inside pill)
  var flyoutMenu = document.createElement('div');
  flyoutMenu.className = 'cw-flyout-menu';
  flyoutMenu.style.display = 'none';
  pill.appendChild(flyoutMenu);

  var clearItem = document.createElement('button');
  clearItem.className = 'cw-flyout-item';
  clearItem.type = 'button';
  clearItem.textContent = 'Clear conversation';
  flyoutMenu.appendChild(clearItem);

  var settingsItem = document.createElement('a');
  settingsItem.className = 'cw-flyout-item';
  settingsItem.href = (config.drupalAdminUrl || config.cinatraUrl || '') + '/admin/config/services/cinatra';
  settingsItem.textContent = 'Widget administration';
  settingsItem.target = '_blank';
  settingsItem.rel = 'noopener noreferrer';
  flyoutMenu.appendChild(settingsItem);

  var flyoutBtn = document.createElement('button');
  flyoutBtn.className = 'cw-flyout-btn';
  flyoutBtn.type = 'button';
  flyoutBtn.setAttribute('aria-label', 'Options');
  flyoutBtn.textContent = '+';
  pill.appendChild(flyoutBtn);

  var textarea = document.createElement('textarea');
  textarea.className = 'cw-textarea';
  textarea.placeholder = 'Ask Cinatra…';
  textarea.rows = 1;
  pill.appendChild(textarea);

  var submitBtn = document.createElement('button');
  submitBtn.className = 'cw-submit';
  submitBtn.type = 'button';
  submitBtn.disabled = true;
  submitBtn.appendChild(makeArrowSvg());
  pill.appendChild(submitBtn);

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  var isOpen = false;
  var isFlyoutOpen = false;
  var isStreaming = false;
  var hadChanges = false;
  var diffCardEl = null;
  var pendingDiff = null;

  // Truncate long before/after values so they fit on one line in the diff card.
  function trunc(s, n) { return s && s.length > n ? s.slice(0, n) + '\\u2026' : (s || ''); }

  function renderDiffCard(fields) {
    var card = document.createElement('div');
    card.className = 'cw-diff-card';
    var hdr = document.createElement('div');
    hdr.className = 'cw-diff-card-header';
    hdr.textContent = fields.length > 0 ? 'Changes applied' : 'Content updated';
    card.appendChild(hdr);
    if (fields.length === 0) {
      var note = document.createElement('div');
      note.className = 'cw-diff-row';
      note.style.cssText = 'color:${CINATRA_THEME.muted};font-size:12px;font-style:italic;';
      note.textContent = 'Field-level diff not available for rich content — reload will apply changes.';
      card.appendChild(note);
    }
    for (var fi = 0; fi < fields.length; fi++) {
      var f = fields[fi];
      var row = document.createElement('div');
      row.className = 'cw-diff-row';
      var fieldEl = document.createElement('span');
      fieldEl.className = 'cw-diff-field';
      fieldEl.textContent = (f.field || '') + ':';
      var vals = document.createElement('div');
      vals.className = 'cw-diff-values';
      if (f.before) {
        var bef = document.createElement('span');
        bef.className = 'cw-diff-before';
        bef.textContent = trunc(String(f.before), 80);
        vals.appendChild(bef);
      }
      var aft = document.createElement('span');
      aft.className = 'cw-diff-after';
      aft.textContent = trunc(String(f.after || '(removed)'), 80);
      vals.appendChild(aft);
      row.appendChild(fieldEl);
      row.appendChild(vals);
      card.appendChild(row);
    }
    return card;
  }

  // ---------------------------------------------------------------------------
  // History
  // ---------------------------------------------------------------------------
  var HISTORY_KEY = 'cinatra_history_' + (config.instanceId || 'default');
  var history = [];
  try { var raw = window.sessionStorage.getItem(HISTORY_KEY); if (raw) history = JSON.parse(raw) || []; } catch (_) {}
  function saveHistory() { try { window.sessionStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch (_) {} }

  // ---------------------------------------------------------------------------
  // Markdown — inline renderer (no CDN dependency; XSS-safe: all user text
  // goes through esc() before insertion, no raw innerHTML from LLM output)
  // ---------------------------------------------------------------------------
  function renderMd(text) {
    if (!text) return '';
    function esc(s) {
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
    function inlineRender(s) {
      s = esc(s);
      s = s.replace(/\`([^\`\\n]+)\`/g, '<code>$1</code>');
      s = s.replace(/\\*\\*([^*\\n]+)\\*\\*/g, '<strong>$1</strong>');
      s = s.replace(/\\*([^*\\n]+)\\*/g, '<em>$1</em>');
      s = s.replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^)]+)\\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
      return s;
    }
    var lines = text.split('\\n');
    var html = '';
    var inCode = false, codeLines = [];
    var listType = null, listItems = [];
    function flushList() {
      if (!listItems.length) return;
      var tag = listType === 'ol' ? 'ol' : 'ul';
      html += '<' + tag + '>' + listItems.map(function(li) { return '<li>' + inlineRender(li) + '</li>'; }).join('') + '</' + tag + '>';
      listItems = []; listType = null;
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!inCode && /^\`\`\`/.test(line)) { flushList(); inCode = true; codeLines = []; continue; }
      if (inCode) {
        if (/^\`\`\`/.test(line)) { html += '<pre><code>' + esc(codeLines.join('\\n')) + '</code></pre>'; inCode = false; codeLines = []; }
        else codeLines.push(line);
        continue;
      }
      var olM = line.match(/^(\\d+)\\.\\s+(.*)/);
      var ulM = !olM && line.match(/^[-*]\\s+(.*)/);
      if (olM) { if (listType !== 'ol') flushList(); listType = 'ol'; listItems.push(olM[2]); }
      else if (ulM) { if (listType !== 'ul') flushList(); listType = 'ul'; listItems.push(ulM[1]); }
      else {
        flushList();
        var hM = line.match(/^(#{1,3})\\s+(.*)/);
        if (hM) { var lvl = Math.min(hM[1].length + 1, 4); html += '<h' + lvl + '>' + inlineRender(hM[2]) + '</h' + lvl + '>'; }
        else if (line.trim() === '') html += '';
        else html += '<p>' + inlineRender(line) + '</p>';
      }
    }
    if (inCode) html += '<pre><code>' + esc(codeLines.join('\\n')) + '</code></pre>';
    flushList();
    return html;
  }

  // ---------------------------------------------------------------------------
  // Render message bubble
  // ---------------------------------------------------------------------------
  function renderMessage(role, content, asMarkdown) {
    var el = document.createElement('div');
    el.className = 'cw-msg cw-msg-' + role;
    if (asMarkdown) el.innerHTML = renderMd(content);
    else el.textContent = content;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return el;
  }

  for (var i = 0; i < history.length; i++) {
    var h = history[i];
    renderMessage(h.role, h.content, h.role === 'assistant');
    if (h.diff && Array.isArray(h.diff)) {
      messagesEl.appendChild(renderDiffCard(h.diff));
    }
  }

  // ---------------------------------------------------------------------------
  // Open / collapse — circle↔widget swap
  // ---------------------------------------------------------------------------
  function openWidget() {
    isOpen = true;
    // Keep circle visible but behind the widget panel while open.
    circle.style.zIndex = '9999990';
    setWidgetSize();
    cwWidget.style.display = 'block';
    textarea.focus();
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function collapseWidget() {
    isOpen = false;
    closeFlyout();
    cwWidget.style.display = 'none';
    // Restore circle z-index to CSS default (10000000) when panel is closed.
    circle.style.zIndex = '';
  }

  function closeFlyout() {
    isFlyoutOpen = false;
    flyoutMenu.style.display = 'none';
  }

  // ---------------------------------------------------------------------------
  // Auto-resize textarea
  // ---------------------------------------------------------------------------
  function resizeTextarea() {
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
    var pillH = pill.offsetHeight || PILL_MIN_H;
    var deltaH = Math.max(0, pillH - PILL_MIN_H);
    var spacerH = PILL_GAP + Math.floor(PILL_MIN_H / 2);
    panel.style.height = (currentPanelHeight + spacerH - deltaH) + 'px';
  }
  textarea.addEventListener('input', resizeTextarea);
  textarea.addEventListener('input', function () {
    if (!isStreaming) submitBtn.disabled = textarea.value.trim() === '';
  });

  // ---------------------------------------------------------------------------
  // Submit
  // ---------------------------------------------------------------------------
  function doSubmit() {
    var text = textarea.value.trim();
    if (text && !isStreaming) {
      textarea.value = '';
      resizeTextarea();
      sendMessage(text);
    }
  }

  circle.addEventListener('click', function(e) {
    if (circleDragMoved) { circleDragMoved = false; e.stopPropagation(); return; }
    if (isOpen) { collapseWidget(); } else { openWidget(); }
  });
  closeBtn.addEventListener('click', function() { collapseWidget(); });
  submitBtn.addEventListener('click', function() { doSubmit(); });

  textarea.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey && !isStreaming) {
      e.preventDefault();
      doSubmit();
    }
  });

  // ---------------------------------------------------------------------------
  // Click outside → collapse
  // ---------------------------------------------------------------------------
  document.addEventListener('click', function(e) {
    if (!isOpen) return;
    var path = e.composedPath ? e.composedPath() : [];
    for (var p = 0; p < path.length; p++) { if (path[p] === rootEl) return; }
    collapseWidget();
  });

  // ---------------------------------------------------------------------------
  // Flyout
  // ---------------------------------------------------------------------------
  flyoutBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    isFlyoutOpen = !isFlyoutOpen;
    flyoutMenu.style.display = isFlyoutOpen ? 'block' : 'none';
  });

  clearItem.addEventListener('click', function() {
    history = []; saveHistory(); messagesEl.innerHTML = ''; closeFlyout();
  });

  // ---------------------------------------------------------------------------
  // Resize: drag top-left corner to adjust width (left) and panel height (up)
  // ---------------------------------------------------------------------------
  var resizeDragging = false;
  var resizeStartX = 0, resizeStartY = 0;
  var resizeStartWidth = 0, resizeStartPanelH = 0;

  resizeEl.addEventListener('mousedown', function(e) {
    e.preventDefault();
    e.stopPropagation();
    resizeDragging = true;
    resizeStartX = e.clientX;
    resizeStartY = e.clientY;
    resizeStartWidth = currentWidth;
    resizeStartPanelH = currentPanelHeight;
  });

  document.addEventListener('mousemove', function(e) {
    if (circleDragging) {
      var dx = e.clientX - circleDragStartX;
      var dy = e.clientY - circleDragStartY;
      if (!circleDragMoved && (Math.abs(dx) >= CIRCLE_DRAG_THRESHOLD || Math.abs(dy) >= CIRCLE_DRAG_THRESHOLD)) {
        circleDragMoved = true;
        circle.style.cursor = 'grabbing';
      }
      if (circleDragMoved) {
        var newLeft = circleDragStartLeft + dx;
        var newTop = circleDragStartTop + dy;
        var clamped = clampCirclePos(newLeft, newTop);
        applyCirclePos(clamped.left, clamped.top);
      }
    }
    if (!resizeDragging) return;
    var dw = resizeStartX - e.clientX; // drag left = wider
    var dh = resizeStartY - e.clientY; // drag up = taller
    currentWidth = Math.max(320, Math.min(window.innerWidth - 48, resizeStartWidth + dw));
    currentPanelHeight = Math.max(200, Math.min(window.innerHeight - 200, resizeStartPanelH + dh));
    setWidgetSize();
  });

  document.addEventListener('mouseup', function() {
    if (circleDragging) {
      circleDragging = false;
      circle.style.cursor = '';
    }
    resizeDragging = false;
  });

  // ---------------------------------------------------------------------------
  // Drupal context
  // ---------------------------------------------------------------------------
  function buildDrupalContext() {
    return {
      href: typeof window.location !== 'undefined' ? window.location.href : '',
      nodeId: config.nodeId || '',
      nodeBundle: config.nodeBundle || '',
      nodeStatus: config.nodeStatus || '',
      instanceId: config.instanceId || '',
    };
  }

  // ---------------------------------------------------------------------------
  // SSE streaming chat
  // ---------------------------------------------------------------------------
  async function sendMessage(userText) {
    hadChanges = false;
    diffCardEl = null;
    pendingDiff = null;
    history.push({ role: 'user', content: userText });
    renderMessage('user', userText, false);
    saveHistory();

    var assistantEl = document.createElement('div');
    assistantEl.className = 'cw-msg cw-msg-assistant cw-thinking';
    assistantEl.innerHTML = '<span class="cw-thinking-dot"></span><span class="cw-thinking-label">Thinking…</span>';
    messagesEl.appendChild(assistantEl);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    var assistantText = '';
    isStreaming = true;
    submitBtn.disabled = true;

    try {
      var response = await fetch(config.cinatraUrl + '/api/agents/drupal-content-editor/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + config.apiKey },
        body: JSON.stringify({ contractVersion: config.contractVersion || 'v1', messages: history.map(function(m) { return { role: m.role, content: m.content }; }), context: buildDrupalContext() }),
      });

      if (!response.ok || !response.body) {
        var errText = 'Error ' + response.status;
        try {
          var raw = await response.text();
          var parsed = null;
          try { parsed = JSON.parse(raw); } catch (_) {}
          // Structured contract/admin error: { error: { message, code } }.
          if (parsed && parsed.error && parsed.error.message) { errText = parsed.error.message; }
          else { errText += ': ' + raw.slice(0, 200); }
        } catch (_) {}
        assistantEl.classList.remove('cw-thinking');
        assistantEl.textContent = errText;
        return;
      }

      var reader = response.body.getReader();
      var decoder = new TextDecoder();
      var buffer = '';
      var streamingStarted = false;

      while (true) {
        var chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        var records = buffer.split('\\n\\n');
        buffer = records.pop() || '';
        for (var r = 0; r < records.length; r++) {
          var lines = records[r].split('\\n');
          var eventName = '', dataStr = '';
          for (var j = 0; j < lines.length; j++) {
            if (lines[j].indexOf('event: ') === 0) eventName = lines[j].slice(7).trim();
            else if (lines[j].indexOf('data: ') === 0) dataStr = lines[j].slice(6);
          }
          if (!eventName || !dataStr) continue;
          var data; try { data = JSON.parse(dataStr); } catch (_) { continue; }
          if (eventName === 'text' && data && typeof data.content === 'string') {
            if (!streamingStarted) { streamingStarted = true; assistantEl.classList.remove('cw-thinking'); }
            assistantText += data.content;
            assistantEl.innerHTML = renderMd(assistantText);
            messagesEl.scrollTop = messagesEl.scrollHeight;
          } else if (eventName === 'changes' && data && Array.isArray(data.fields)) {
            hadChanges = true;
            pendingDiff = data.fields;
            try {
              var nodeKey = 'cinatra-drupal-diff-' + (data.nodeId || '');
              window.sessionStorage.setItem(nodeKey, JSON.stringify(data.fields));
            } catch (_) {}
            diffCardEl = renderDiffCard(data.fields);
            messagesEl.appendChild(diffCardEl);
            messagesEl.scrollTop = messagesEl.scrollHeight;
          } else if (eventName === 'error' && data && data.message) {
            assistantEl.classList.remove('cw-thinking');
            assistantEl.textContent = 'Error: ' + data.message;
          } else if (eventName === 'done') {
            if (assistantText) assistantEl.innerHTML = renderMd(assistantText);
            if (data && data.fallback) { assistantText = ''; }
            if (hadChanges && !(data && data.fallback)) {
              if (diffCardEl) {
                var footer = document.createElement('div');
                footer.className = 'cw-diff-footer';
                footer.textContent = 'Reloading to apply changes…';
                diffCardEl.appendChild(footer);
                messagesEl.scrollTop = messagesEl.scrollHeight;
              }
              try { window.sessionStorage.setItem('cinatra-reopen', '1'); } catch (_) {}
              setTimeout(function() { window.location.reload(); }, 1500);
            }
          }
        }
      }

      if (assistantText) { history.push({ role: 'assistant', content: assistantText, diff: pendingDiff || undefined }); saveHistory(); }
      else if (!streamingStarted) { assistantEl.classList.remove('cw-thinking'); assistantEl.textContent = '(no response)'; }
    } catch (err) {
      assistantEl.classList.remove('cw-thinking');
      assistantEl.textContent = 'Network error: ' + (err && err.message ? err.message : 'unknown');
    } finally {
      isStreaming = false;
      submitBtn.disabled = textarea.value.trim() === '';
    }
  }

  // Reopen widget after an auto-reload triggered by a content edit.
  try {
    if (window.sessionStorage.getItem('cinatra-reopen') === '1') {
      window.sessionStorage.removeItem('cinatra-reopen');
      openWidget();
    }
  } catch (_) {}

})();
`;
  return new Response(widgetIIFE, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
