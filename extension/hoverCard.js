// extension/hoverCard.js
//
// The hover card that appears over a highlighted (flagged) clause
// (spec §3.5 "Hover card", §4.2 "what a verdict means"). Injected as a
// classic script alongside domwalk.js / detect.js / content.js / render.js
// — MV3 content scripts cannot use static ESM import/export, so, like
// domwalk.js, this file publishes its API onto the shared
// globalThis.__FPF namespace instead of importing or exporting anything.
//
// OWNERSHIP: this file only. render.js, highlight.css, content.js and
// background.js belong to a parallel change and are not touched here.
// That other change is responsible for wiring mouseenter/mouseleave and
// focus/blur on the <mark class="ffp-mark ffp-{severity}"> elements it
// creates, and for calling NS.showHoverCard(anchorEl, verdict) /
// NS.hideHoverCard() at the right moments — including from keyboard focus
// handlers, since both entry points below are trigger-agnostic and don't
// care whether a mouse or a focus event caused the call. That is what
// lets this file support keyboard users without coupling to how marks are
// made focusable elsewhere.
//
// Contract:
//   NS.showHoverCard(anchorEl, verdict)
//   NS.hideHoverCard()
// where verdict is { id, flagged, probability, category,
// categoryConfidence, severity, spans } per background.js's decision
// logic (spec §4.2).

(function () {
  const NS = (globalThis.__FPF = globalThis.__FPF || {});

  // ---------------------------------------------------------------------
  // Category -> plain-English headline.
  //
  // DUPLICATED from extension/core/questions.js's CATEGORIES map. This
  // file cannot `import` that module (no ESM in an injected classic
  // script — see header), so the 15 category keys are copied here as a
  // literal object. If a category key is ever added, removed, or renamed
  // in extension/core/questions.js, this map must be updated to match, or
  // the hover card will silently fall back to showing the raw machine key
  // for the newly out-of-sync category.
  //
  // These are NOT the rubric descriptions from questions.js (those are
  // instructions to Jev, written for a model). These are written for a
  // person glancing at a tooltip: short, plain, and read like a warning
  // rather than a taxonomy label.
  const CATEGORY_LABELS = {
    forced_arbitration: 'Forces arbitration instead of court',
    class_action_waiver: "Blocks you from joining a class action",
    jury_trial_waiver: 'Waives your right to a jury trial',
    // Rubric: "Lets the company change the terms without notice or
    // consent." Was "...on you anytime" — "anytime" asserts a frequency
    // the rubric never states; the rubric is about notice/consent, not
    // timing.
    unilateral_changes: 'Can change the terms without notice or your consent',
    // Rubric: "Permits sharing personal data with third parties,
    // affiliates, or advertisers." Was "Shares your data..." — the rubric
    // is a permission ("permits"), not a report that it happens; "May
    // share" carries only what's actually claimed.
    broad_data_sharing: 'May share your data with third parties',
    // Rubric: "Permits tracking the reader on other sites, apps, or
    // services." Same permission-vs-practice fix as broad_data_sharing.
    tracking_offsite: 'May track you across other sites and apps',
    content_license_grab: 'Broad license to your content',
    // Rubric: "Automatically renews or charges, OR makes cancellation
    // difficult." Was "...and makes canceling hard" — conjoined two
    // things the rubric only requires one of.
    auto_renewal_trap: 'Auto-renews, or makes canceling hard',
    // Rubric: "Denies refunds or makes fees non-refundable." Was
    // "Money's non-refundable, even if you cancel" — "even if you
    // cancel" asserts a specific condition (cancellation) the clause may
    // never mention.
    no_refunds: 'Fees are non-refundable',
    liability_dodge: "Limits what you can hold them liable for",
    fee_shifting: 'You may pay their legal costs',
    // Rubric: "Forces disputes into a venue or governing law inconvenient
    // to the reader." Was "...on their home turf" — asserts a specific
    // fact (that it's literally the company's home venue) the rubric
    // doesn't require; a chosen venue can be inconvenient without being
    // theirs.
    hostile_jurisdiction: "Forces disputes into a venue that's inconvenient for you",
    termination_without_cause: 'They can cut you off without cause or notice',
    // Rubric: "Allows keeping the reader's data after deletion or account
    // closure." Was "Keeps your data..." stated as certain fact — the
    // rubric is a permission ("allows"), not a claim it happens.
    data_retained_after_deletion: 'May keep your data after you delete it',
    // Included for completeness / defensiveness. In practice a clause
    // whose Choice resolves to `benign` never reaches this label: per
    // spec §4.2 a `benign` Choice on a flagged (Noul-passed) clause is
    // rewritten to `unclear` in code regardless of the Choice's own
    // confidence, and it's the `unclear` branch below that renders.
    benign: 'No specific concern identified',
  };

  // Spec §4.2: `unclear` is not an error state or a missing label — it's
  // the Noul (harm check) and the Choice (category check) genuinely
  // disagreeing, or the Choice being too unsure to trust. Wording it as a
  // disagreement between two checks, not a system failure, per spec's
  // framing ("a real disagreement between two questions, not an error").
  const UNCLEAR_HEADLINE = "Looks harmful, but doesn't fit a clean category";
  const UNCLEAR_BODY =
    "Two separate checks ran on this clause: one thinks it takes something " +
    "from you, the other couldn't confidently say what kind. That's a real " +
    "disagreement, not a bug — worth reading yourself.";

  const VALID_SEVERITIES = new Set(['low', 'medium', 'high']);
  const DEFAULT_SEVERITY = 'medium';

  const SHOW_DELAY_MS = 120; // spec: small delay so sweeping across marks doesn't strobe
  const HIDE_GRACE_MS = 150; // lets the cursor travel from anchor onto the card itself
  const VIEWPORT_MARGIN = 8; // px kept clear of the viewport edge when flipping/clamping

  // Guard against a host page already using the max signed 32-bit z-index
  // itself: we can't out-number 2147483647 (it's the ceiling), so the
  // second line of defense is DOM order — appending as the last child of
  // <body> wins ties in the same stacking context against anything else
  // also sitting at the max value and not otherwise stacked above <body>.
  const Z_INDEX = 2147483647;

  // ---------------------------------------------------------------------
  // Module state. The container is created lazily on first show and
  // reused for every subsequent show/hide — never rebuilt.
  let host = null; // element appended to document.body; the shadow host
  let shadow = null; // the closed ShadowRoot
  let cardEl = null;
  let headlineEl = null;
  let subEl = null;
  let probValueEl = null;
  let confRowEl = null;
  let confValueEl = null;
  let clauseEl = null;

  let showTimer = null;
  let hideTimer = null;
  let cardHovered = false;
  let visible = false;

  function formatPct(value) {
    if (typeof value !== 'number' || !isFinite(value)) return '—'; // em dash for "unknown"
    const pct = Math.round(value * 100);
    return `${Math.max(0, Math.min(100, pct))}%`;
  }

  function normalizeSeverity(severity) {
    return VALID_SEVERITIES.has(severity) ? severity : DEFAULT_SEVERITY;
  }

  // ---------------------------------------------------------------------
  // Shadow DOM construction (closed mode — spec §3.5 "Shadow DOM for the
  // hover card so host CSS can't break it"). Everything the card looks
  // like lives in this stylesheet, scoped to the shadow tree; nothing is
  // ever added to page-level CSS.
  const STYLE = `
    :host {
      all: initial;
      position: fixed;
      top: 0;
      left: 0;
      z-index: ${Z_INDEX};
      margin: 0;
      padding: 0;
      border: 0;
      /* Click-through by default; .fpf-card re-enables pointer-events for
         itself only (see below), so the host never traps the cursor over
         the parts of its (shrink-to-fit) box that aren't the card. */
      pointer-events: none;
      opacity: 0;
      transition: opacity 120ms ease-out;
      color-scheme: light dark;
    }
    :host([data-fpf-visible="true"]) {
      opacity: 1;
    }
    @media (prefers-reduced-motion: reduce) {
      :host { transition: none; }
    }

    * { box-sizing: border-box; }
    [hidden] { display: none !important; }

    .fpf-card {
      --fpf-bg: #ffffff;
      --fpf-fg: #1a1a1a;
      --fpf-fg-muted: #5a5a5a;
      --fpf-border: #d8d8d8;
      --fpf-shadow: rgba(0, 0, 0, 0.18);
      --fpf-accent-low: #b45309;
      --fpf-accent-medium: #d97706;
      --fpf-accent-high: #dc2626;

      pointer-events: auto; /* clause text is selectable; see header comment */
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 13px;
      line-height: 1.45;
      color: var(--fpf-fg);
      background: var(--fpf-bg);
      border: 1px solid var(--fpf-border);
      border-left: 4px solid var(--fpf-accent-medium);
      border-radius: 8px;
      box-shadow: 0 6px 20px var(--fpf-shadow);
      padding: 10px 12px;
      width: max-content;
      max-width: 320px;
    }

    @media (prefers-color-scheme: dark) {
      .fpf-card {
        --fpf-bg: #22242a;
        --fpf-fg: #f0f0f0;
        --fpf-fg-muted: #a7a7ad;
        --fpf-border: #3c3f47;
        --fpf-shadow: rgba(0, 0, 0, 0.5);
        --fpf-accent-low: #fbbf24;
        --fpf-accent-medium: #f59e0b;
        --fpf-accent-high: #f87171;
      }
    }

    .fpf-card[data-severity="low"] { border-left-color: var(--fpf-accent-low); }
    .fpf-card[data-severity="medium"] { border-left-color: var(--fpf-accent-medium); }
    .fpf-card[data-severity="high"] { border-left-color: var(--fpf-accent-high); }

    .fpf-head {
      display: flex;
      align-items: baseline;
      gap: 6px;
      margin-bottom: 4px;
    }

    .fpf-dot {
      flex: none;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--fpf-accent-medium);
      transform: translateY(-1px);
    }
    .fpf-card[data-severity="low"] .fpf-dot { background: var(--fpf-accent-low); }
    .fpf-card[data-severity="medium"] .fpf-dot { background: var(--fpf-accent-medium); }
    .fpf-card[data-severity="high"] .fpf-dot { background: var(--fpf-accent-high); }

    .fpf-headline {
      margin: 0;
      font-size: 13px;
      font-weight: 600;
      color: var(--fpf-fg);
    }

    .fpf-sub {
      margin: 0 0 8px 0;
      color: var(--fpf-fg-muted);
      font-size: 12px;
    }

    .fpf-metrics {
      display: flex;
      flex-direction: column;
      gap: 2px;
      margin: 6px 0 8px 0;
    }

    .fpf-metric {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
    }

    .fpf-metric-primary .fpf-metric-label {
      color: var(--fpf-fg);
      font-size: 12px;
    }
    .fpf-metric-primary .fpf-metric-value {
      font-size: 15px;
      font-weight: 700;
      color: var(--fpf-fg);
    }

    /* Category confidence is a different, more technical quantity than the
       probability, and visually secondary on purpose — conflating the two
       misleads about what each one means (spec: "it's a different and
       more technical quantity"). */
    .fpf-metric-secondary .fpf-metric-label,
    .fpf-metric-secondary .fpf-metric-value {
      font-size: 11px;
      color: var(--fpf-fg-muted);
      font-weight: 400;
    }

    .fpf-clause {
      margin: 0 0 8px 0;
      padding: 6px 8px;
      border-left: 2px solid var(--fpf-border);
      background: transparent;
      color: var(--fpf-fg-muted);
      font-style: italic;
      font-size: 12px;
      max-height: 6.5em;
      overflow-y: auto;
      user-select: text;
      -webkit-user-select: text;
      cursor: text;
    }

    .fpf-footer {
      margin: 0;
      padding-top: 6px;
      border-top: 1px solid var(--fpf-border);
      color: var(--fpf-fg-muted);
      font-size: 10.5px;
    }
  `;

  const TEMPLATE = `
    <div class="fpf-card" role="tooltip" aria-live="polite" data-severity="medium">
      <div class="fpf-head">
        <span class="fpf-dot" aria-hidden="true"></span>
        <h2 class="fpf-headline"></h2>
      </div>
      <p class="fpf-sub" hidden></p>
      <div class="fpf-metrics">
        <div class="fpf-metric fpf-metric-primary">
          <span class="fpf-metric-label">Chance this is harmful</span>
          <span class="fpf-metric-value fpf-prob-value">—</span>
        </div>
        <div class="fpf-metric fpf-metric-secondary fpf-conf-row">
          <span class="fpf-metric-label">Category confidence</span>
          <span class="fpf-metric-value fpf-conf-value">—</span>
        </div>
      </div>
      <blockquote class="fpf-clause" hidden></blockquote>
      <p class="fpf-footer">Not legal advice — an automated flag for a closer read.</p>
    </div>
  `;

  function ensureCard() {
    if (host) return;

    host = document.createElement('div');
    host.setAttribute('data-fpf-hover-host', '');
    host.setAttribute('aria-hidden', 'false');

    // Belt-and-suspenders on top of the :host rules in STYLE: inline
    // !important styles on the host itself beat any author stylesheet on
    // the page, including one that (unusually) targets elements with
    // !important on a broad selector. The shadow-scoped :host{} rules
    // above are the primary styling; this is defense against a page that
    // is hostile at the light-DOM level, which is exactly the kind of
    // page this extension runs on (spec: "legal sites have aggressive
    // CSS").
    const hostStyle = host.style;
    hostStyle.setProperty('position', 'fixed', 'important');
    hostStyle.setProperty('top', '0px', 'important');
    hostStyle.setProperty('left', '0px', 'important');
    hostStyle.setProperty('right', 'auto', 'important');
    hostStyle.setProperty('bottom', 'auto', 'important');
    hostStyle.setProperty('z-index', String(Z_INDEX), 'important');
    hostStyle.setProperty('margin', '0', 'important');
    hostStyle.setProperty('padding', '0', 'important');
    hostStyle.setProperty('border', '0', 'important');
    hostStyle.setProperty('pointer-events', 'none', 'important');
    hostStyle.setProperty('display', 'block', 'important');

    shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>${STYLE}</style>${TEMPLATE}`;

    cardEl = shadow.querySelector('.fpf-card');
    headlineEl = shadow.querySelector('.fpf-headline');
    subEl = shadow.querySelector('.fpf-sub');
    probValueEl = shadow.querySelector('.fpf-prob-value');
    confRowEl = shadow.querySelector('.fpf-conf-row');
    confValueEl = shadow.querySelector('.fpf-conf-value');
    clauseEl = shadow.querySelector('.fpf-clause');

    // Lets the cursor travel from the <mark> onto the card (e.g. to select
    // the clause text) without the card dismissing itself. hideHoverCard()
    // only starts a grace-period timer (see scheduleHide); if the pointer
    // has actually landed on the card by the time that timer fires, the
    // hide is skipped.
    cardEl.addEventListener('mouseenter', () => {
      cardHovered = true;
      clearTimeout(hideTimer);
    });
    cardEl.addEventListener('mouseleave', () => {
      cardHovered = false;
      scheduleHide();
    });

    document.body.appendChild(host);
  }

  function populate(anchorEl, verdict) {
    const isUnclear = verdict.category === 'unclear';
    const label = isUnclear
      ? UNCLEAR_HEADLINE
      : CATEGORY_LABELS[verdict.category] || String(verdict.category || 'Flagged clause');

    headlineEl.textContent = label;

    if (isUnclear) {
      subEl.textContent = UNCLEAR_BODY;
      subEl.hidden = false;
    } else {
      subEl.textContent = '';
      subEl.hidden = true;
    }

    probValueEl.textContent = formatPct(verdict.probability);

    if (typeof verdict.categoryConfidence === 'number') {
      confValueEl.textContent = formatPct(verdict.categoryConfidence);
      confRowEl.hidden = false;
    } else {
      confRowEl.hidden = true;
    }

    // The verdict object carries no clause text (spec: Jev returns no
    // generated string, only a probability and a category — and the
    // contract's verdict shape has no text field either). The anchor
    // element IS the <mark> wrapping exactly the flagged clause, so its
    // rendered text doubles as "the raw clause" spec §3.5 calls for,
    // without inventing anything: this is literal page content, not a
    // generated explanation.
    const clauseText = anchorEl && typeof anchorEl.textContent === 'string' ? anchorEl.textContent.trim() : '';
    if (clauseText) {
      clauseEl.textContent = clauseText;
      clauseEl.hidden = false;
    } else {
      clauseEl.textContent = '';
      clauseEl.hidden = true;
    }

    cardEl.setAttribute('data-severity', normalizeSeverity(verdict.severity));
  }

  // Measures the card (via getBoundingClientRect, so the DOM must already
  // reflect `populate`'s content) and positions it near the anchor,
  // flipping above/right-aligned when it would overflow the viewport.
  // Runs while the host is still invisible (opacity: 0), so there is no
  // flash at the wrong position.
  function position(anchorEl) {
    const anchorRect = anchorEl.getBoundingClientRect();
    const cardRect = cardEl.getBoundingClientRect();
    const cardWidth = cardRect.width;
    const cardHeight = cardRect.height;

    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Vertical: prefer below the anchor; flip above if it would overflow
    // the bottom edge and there's room above.
    let top = anchorRect.bottom + VIEWPORT_MARGIN;
    if (top + cardHeight > vh - VIEWPORT_MARGIN) {
      const aboveTop = anchorRect.top - VIEWPORT_MARGIN - cardHeight;
      top = aboveTop >= VIEWPORT_MARGIN ? aboveTop : Math.max(VIEWPORT_MARGIN, vh - cardHeight - VIEWPORT_MARGIN);
    }
    top = Math.max(VIEWPORT_MARGIN, Math.min(top, Math.max(VIEWPORT_MARGIN, vh - cardHeight - VIEWPORT_MARGIN)));

    // Horizontal: prefer left-aligned with the anchor; right-align to the
    // anchor's right edge if left-aligned would overflow the right edge.
    // Legal text runs to the page edge, so this triggers constantly on
    // narrow columns and end-of-line clauses.
    let left = anchorRect.left;
    if (left + cardWidth > vw - VIEWPORT_MARGIN) {
      left = anchorRect.right - cardWidth;
    }
    left = Math.max(VIEWPORT_MARGIN, Math.min(left, Math.max(VIEWPORT_MARGIN, vw - cardWidth - VIEWPORT_MARGIN)));

    host.style.setProperty('top', `${Math.round(top)}px`, 'important');
    host.style.setProperty('left', `${Math.round(left)}px`, 'important');
  }

  function showNow() {
    visible = true;
    host.setAttribute('data-fpf-visible', 'true');
  }

  function actuallyHide() {
    if (!visible) return;
    visible = false;
    host.removeAttribute('data-fpf-visible');
  }

  function scheduleHide() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!cardHovered) actuallyHide();
    }, HIDE_GRACE_MS);
  }

  /**
   * @param {Element} anchorEl  the <mark> being hovered or focused
   * @param {{id, flagged, probability, category, categoryConfidence, severity, spans}} verdict
   */
  NS.showHoverCard = function (anchorEl, verdict) {
    if (!anchorEl || !verdict) return;

    ensureCard();
    clearTimeout(hideTimer);
    clearTimeout(showTimer);

    showTimer = setTimeout(() => {
      populate(anchorEl, verdict);
      position(anchorEl);
      showNow();
    }, SHOW_DELAY_MS);
  };

  NS.hideHoverCard = function () {
    clearTimeout(showTimer);
    if (!host) return;
    scheduleHide();
  };
})();
