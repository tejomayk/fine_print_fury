// cli/extract.js
//
// Parse saved HTML into ordered block text, ready for segmentBlocks()
// (spec §3.3, step 1). This is CLI build tooling, not shipped extension
// code (spec §8: the extension's content script walks a *live* DOM and
// has no need of an HTML parser), so pulling in linkedom here — rather
// than reimplementing an HTML parser by hand — is the pragmatic choice.

import { parseHTML } from 'linkedom';

const BLOCK_TAGS = new Set(['P', 'LI', 'TD', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);
const SKIP_TAGS = new Set(['NAV', 'HEADER', 'FOOTER', 'SCRIPT', 'STYLE', 'NOSCRIPT', 'ASIDE', 'SVG']);

// Approximation of spec §3.3 step 1's "zero-height nodes" skip (see also
// the risk table, §10: "Hidden page text steering the model"). The live
// content script uses actual layout — getBoundingClientRect / offsetParent
// — to find zero-height/invisible nodes; Node has no rendering engine, so
// there is nothing to measure. This is a **textual stand-in, not an
// equivalent check**: it catches the common, deliberate ways a page marks
// something hidden (an explicit `hidden` attribute, `aria-hidden="true"`,
// or an inline `display:none`/`visibility:hidden` style) but will miss
// anything hidden via an external stylesheet, a CSS class, or JS toggling
// a property at runtime — none of which a saved static HTML file can
// resolve without a layout engine anyway.
function isHiddenApprox(el) {
  if (el.hasAttribute('hidden')) return true;
  if ((el.getAttribute('aria-hidden') || '').toLowerCase() === 'true') return true;
  const style = el.getAttribute('style') || '';
  if (/display\s*:\s*none/i.test(style)) return true;
  if (/visibility\s*:\s*hidden/i.test(style)) return true;
  return false;
}

// Spec §3.3 step 1: "div elements with no element children" — a plain text
// wrapper, not a layout div that merely contains other blocks. Checking
// `.children.length` (element children only, no text nodes) is what keeps
// a `<div><p>...</p></div>` wrapper from being treated as its own block on
// top of the `<p>` inside it.
function isChildlessDiv(el) {
  return el.tagName === 'DIV' && el.children.length === 0;
}

function isBlockCandidate(el) {
  return BLOCK_TAGS.has(el.tagName) || isChildlessDiv(el);
}

/**
 * Parse saved HTML into ordered block text.
 * @param {string} html
 * @returns {string[]}   ordered block text, ready for segmentBlocks()
 */
export function extractBlocks(html) {
  const { document } = parseHTML(html);
  const root = document.body || document.documentElement;
  const blocks = [];

  function walk(container) {
    for (const el of container.children) {
      if (SKIP_TAGS.has(el.tagName)) continue;
      if (isHiddenApprox(el)) continue;

      if (isBlockCandidate(el)) {
        // Whole subtree's text, whitespace collapsed — captures inline
        // markup (e.g. <strong>, <a>) inside the block. We deliberately do
        // NOT recurse further once a block is matched: descending into,
        // say, a <p> nested inside an <li> would emit the same text twice.
        const collapsed = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (collapsed.length > 0) blocks.push(collapsed);
        continue;
      }

      walk(el);
    }
  }

  if (root) walk(root);
  return blocks;
}
