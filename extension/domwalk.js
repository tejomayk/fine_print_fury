// extension/domwalk.js
//
// Live-DOM equivalent of cli/extract.js (spec §3.3 step 1). The CLI walks
// parsed static HTML with linkedom and has no layout engine, so it falls
// back to attribute-sniffing (`hidden`, `aria-hidden`, inline `style`) to
// approximate "hidden or zero-height". This file runs inside a real browser
// tab, so it uses the actual layout engine — getBoundingClientRect,
// offsetParent, getComputedStyle — which is strictly more accurate than
// cli/extract.js's textual approximation: it also catches elements hidden
// by an external stylesheet, a CSS class, or a runtime style toggle, none
// of which a saved static HTML file could ever resolve.
//
// No ESM import/export here — this file is injected as a classic script by
// chrome.scripting.executeScript (MV3 content scripts cannot use static
// ESM imports). It publishes its API on a shared global namespace instead;
// see content.js for how the three files share globalThis.__FPF.

(function () {
  const BLOCK_TAGS = new Set(['P', 'LI', 'TD', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
  const SKIP_TAGS = new Set(['NAV', 'HEADER', 'FOOTER', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'ASIDE', 'SVG']);

  // Spec §3.3 step 1 / §10 risk table: "Skip visibility:hidden and
  // zero-height nodes at extraction" so hidden page text can't steer the
  // model. Three independent checks, any one of which disqualifies the
  // element:
  //   - offsetParent === null: the standard cheap proxy for "not rendered"
  //     (display:none, or the element or an ancestor is display:none).
  //     Note offsetParent is also null for position:fixed elements even
  //     when visible, so we don't rely on it alone.
  //   - getBoundingClientRect().height === 0 (and width === 0): catches
  //     collapsed/empty-box elements that offsetParent misses, including
  //     position:fixed ones.
  //   - getComputedStyle: catches visibility:hidden (does not affect
  //     offsetParent) and belt-and-suspenders display:none.
  function isRenderedHidden(el) {
    if (el.offsetParent === null) {
      // offsetParent is legitimately null for position:fixed/sticky-root
      // elements and for <body>/<html>. Only trust it as a hidden signal
      // when computed style agrees the element is actually display:none,
      // otherwise fall through to the rect check.
      const cs = getComputedStyle(el);
      if (cs.display === 'none') return true;
      if (cs.position !== 'fixed') {
        // Not fixed and no offsetParent (and not display:none itself) —
        // almost certainly an invisible ancestor chain. Treat as hidden.
        return true;
      }
    }

    const cs = getComputedStyle(el);
    if (cs.display === 'none') return true;
    if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return true;

    const rect = el.getBoundingClientRect();
    if (rect.height === 0 && rect.width === 0) return true;

    return false;
  }

  // Spec §3.3 step 1: "div elements with no element children" — a plain
  // text wrapper, not a layout div that merely contains other blocks.
  // Element children only (no text nodes), matching cli/extract.js exactly
  // so the CLI and the extension select the same blocks.
  function isChildlessDiv(el) {
    return el.tagName === 'DIV' && el.children.length === 0;
  }

  function isBlockCandidate(el) {
    return BLOCK_TAGS.has(el.tagName) || isChildlessDiv(el);
  }

  /**
   * Walk block-level text containers under `root`, live DOM version of
   * cli/extract.js's extractBlocks(). Returns parallel arrays:
   *
   *   { blocks: string[], nodes: Node[] }
   *
   * INVARIANT: blocks[i] corresponds to nodes[i] for every i — same
   * length, same order. This is what makes highlighting possible later:
   * a verdict's span carries a `blockIndex` that indexes into `blocks` as
   * sent to the background worker, and that same index must retrieve the
   * originating element here so Phase 4 can build a Range over it. Never
   * push to one array without pushing to the other in the same step.
   *
   * @param {Element} root
   * @returns {{blocks: string[], nodes: Node[]}}
   */
  function walkBlocks(root) {
    const blocks = [];
    const nodes = [];

    function walk(container) {
      for (const el of container.children) {
        if (SKIP_TAGS.has(el.tagName)) continue;
        if (isRenderedHidden(el)) continue;

        if (isBlockCandidate(el)) {
          // Whole subtree's text, whitespace collapsed — same rule as
          // cli/extract.js. Do NOT recurse further once a block is
          // matched: descending into, say, a <p> nested inside an <li>
          // would emit the same text twice.
          const collapsed = (el.textContent || '').replace(/\s+/g, ' ').trim();
          if (collapsed.length > 0) {
            blocks.push(collapsed);
            nodes.push(el);
          }
          continue;
        }

        walk(el);
      }
    }

    if (root) walk(root);
    return { blocks, nodes };
  }

  globalThis.__FPF = globalThis.__FPF || {};
  globalThis.__FPF.walkBlocks = walkBlocks;
})();
