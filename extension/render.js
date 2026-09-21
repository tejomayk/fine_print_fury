// extension/render.js
//
// Phase 4 (spec §3.5): paint flagged verdicts onto the live page as
// <mark> highlights. No ESM import/export — classic script injected via
// chrome.scripting.executeScript, published on the shared globalThis.__FPF
// namespace exactly like domwalk.js/detect.js/hoverCard.js. content.js
// consumes NS.renderVerdicts/NS.clearHighlights at the
// ">>> PHASE 4 HOOK <<<" comment.
//
// --- The hard part -----------------------------------------------------
//
// `nodes[blockIndex]` is a block *element*; `spans[].start`/`end` are
// offsets into that element's COLLAPSED-WHITESPACE text, produced by
// domwalk.js as:
//
//     (el.textContent || '').replace(/\s+/g, ' ').trim()
//
// That collapse operates on the element's full subtree textContent as one
// string — it does not know or care about text-node boundaries — so a
// span offset does not directly index any single text node's data, nor
// does it directly index el.textContent (whitespace runs, including ones
// that straddle two sibling text nodes, become a single space; leading/
// trailing whitespace is trimmed). To turn a span into a DOM Range we walk
// the element's text nodes in document order (document order over SHOW_TEXT
// is exactly what textContent concatenates, so this reproduces the same
// raw string domwalk.js collapsed), build a position map from the
// collapsed string back to raw offsets by mirroring domwalk's
// replace+trim step by step, then locate the (textNode, offset) pair(s)
// a raw offset range touches.
//
// Two cases are handled honestly rather than assumed away:
//   - A clause spanning multiple text nodes inside one block (inline <a>/
//     <strong>/<em> are everywhere in legal text): each text node's
//     overlapping portion is wrapped with its own Range/<mark>, in a
//     single left-to-right sweep per block so wrapping one span doesn't
//     invalidate the raw-offset bookkeeping for a later span sharing the
//     same original text node (Range.surroundContents splits text nodes
//     as it goes).
//   - A clause with multiple spans (cross-block merges from segmentation):
//     each span is wrapped independently; every <mark> produced for a
//     given verdict shares that verdict's `data-fpf-id` and hover
//     behavior.
//   - A span that cannot be resolved is counted in `skipped` and logged —
//     never thrown, so one bad clause can't abort the whole render.

(function () {
  const NS = (globalThis.__FPF = globalThis.__FPF || {});

  const LOG_PREFIX = '[FPF]';

  // Literal class-name strings (not built by template-interpolating
  // `verdict.severity`) so the extension/highlight.css <-> render.js class
  // names can be verified to match by a plain text grep.
  const SEVERITY_CLASS = {
    low: 'ffp-low',
    medium: 'ffp-medium',
    high: 'ffp-high',
  };
  const BASE_CLASS = 'ffp-mark';
  const MARK_SELECTOR = `mark.${BASE_CLASS}[data-fpf-id]`;

  const WHITESPACE_RE = /\s/;

  // -------------------------------------------------------------------
  // Collapsed-text <-> raw-text offset mapping (mirrors domwalk.js exactly)
  // -------------------------------------------------------------------

  /**
   * Mirrors `raw.replace(/\s+/g, ' ')` character-for-character while
   * recording, for every position in the resulting (pre-trim) collapsed
   * string, the raw offset boundary it corresponds to.
   *
   * map[k] === raw offset aligned with collapsed-position k, for
   * k = 0..collapsed0.length (so map.length === collapsed0.length + 1).
   *
   * @param {string} raw
   * @returns {number[]}
   */
  function buildRawPositionMap(raw) {
    const map = [0];
    let i = 0;
    while (i < raw.length) {
      if (WHITESPACE_RE.test(raw[i])) {
        // A whole whitespace run collapses to exactly one space, no matter
        // how many raw characters (or text-node boundaries) it spans.
        while (i < raw.length && WHITESPACE_RE.test(raw[i])) i += 1;
      } else {
        i += 1;
      }
      map.push(i);
    }
    return map;
  }

  /**
   * Walks `el`'s text nodes in document order (== textContent's
   * concatenation order) and builds everything needed to map collapsed
   * offsets for this block back to (textNode, offset) pairs.
   *
   * @param {Element} el
   * @returns {{nodeList: Array<{node:Text,start:number,end:number}>,
   *            map:number[], leadingTrim:number, trimmedLen:number}}
   */
  function buildBlockInfo(el) {
    const nodeList = [];
    let rawText = '';

    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null);
    let n = walker.nextNode();
    while (n) {
      const data = n.data || '';
      if (data.length > 0) {
        const start = rawText.length;
        rawText += data;
        nodeList.push({ node: n, start, end: start + data.length });
      }
      n = walker.nextNode();
    }

    if (rawText.length === 0) {
      return { nodeList: [], map: [0], leadingTrim: 0, trimmedLen: 0 };
    }

    const map = buildRawPositionMap(rawText);
    const collapsed0 = rawText.replace(/\s+/g, ' ');
    const leadingTrim = collapsed0.length - collapsed0.replace(/^\s+/, '').length;
    const trailingTrim = collapsed0.length - collapsed0.replace(/\s+$/, '').length;
    const trimmedLen = Math.max(0, collapsed0.length - leadingTrim - trailingTrim);

    return { nodeList, map, leadingTrim, trimmedLen };
  }

  /**
   * Converts a position in the FINAL (trimmed, collapsed) block text —
   * i.e. a value a span's start/end can legally be — into a raw offset
   * into the block element's textContent. Returns null when `pos` is out
   * of range for this block, so callers can skip cleanly.
   *
   * @param {{map:number[], leadingTrim:number, trimmedLen:number}} blockInfo
   * @param {number} pos
   * @returns {number|null}
   */
  function collapsedToRaw(blockInfo, pos) {
    if (typeof pos !== 'number' || !Number.isFinite(pos)) return null;
    if (pos < 0 || pos > blockInfo.trimmedLen) return null;
    const prePos = pos + blockInfo.leadingTrim;
    if (prePos < 0 || prePos >= blockInfo.map.length) return null;
    return blockInfo.map[prePos];
  }

  // -------------------------------------------------------------------
  // Hover-card wiring (owned by a parallel agent's hoverCard.js). Guarded
  // so highlighting still works standalone if that file fails to load.
  // -------------------------------------------------------------------

  function attachHoverHandlers(mark, verdict) {
    const show = () => {
      if (typeof NS.showHoverCard === 'function') {
        try {
          NS.showHoverCard(mark, verdict);
        } catch (err) {
          console.error(`${LOG_PREFIX} render: NS.showHoverCard threw:`, err);
        }
      }
    };
    const hide = () => {
      if (typeof NS.hideHoverCard === 'function') {
        try {
          NS.hideHoverCard();
        } catch (err) {
          console.error(`${LOG_PREFIX} render: NS.hideHoverCard threw:`, err);
        }
      }
    };

    mark.addEventListener('mouseenter', show);
    mark.addEventListener('mouseleave', hide);
    // Keyboard-accessible equivalent of hover, since render gives every
    // mark tabIndex=0 and highlight.css gives it a visible focus style —
    // a focus ring with nothing to show on focus would be a half feature.
    mark.addEventListener('focus', show);
    mark.addEventListener('blur', hide);
  }

  // -------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------

  /**
   * @param {Array<{id,flagged,probability,category,categoryConfidence,severity,spans}>} verdicts
   * @param {Node[]} nodes    parallel to blocks; spans[].blockIndex indexes both
   * @param {string[]} blocks the exact text array sent to the worker
   * @returns {{highlighted:number, skipped:number}}
   */
  NS.renderVerdicts = function (verdicts, nodes, blocks) {
    let highlighted = 0;
    let skipped = 0;

    if (!Array.isArray(verdicts) || !Array.isArray(nodes) || !Array.isArray(blocks)) {
      console.error(`${LOG_PREFIX} render: renderVerdicts called with invalid arguments; nothing rendered.`);
      return { highlighted, skipped };
    }

    const flagged = verdicts.filter((v) => v && v.flagged === true);
    if (flagged.length === 0) {
      console.log(`${LOG_PREFIX} render: no flagged verdicts to render.`);
      return { highlighted, skipped };
    }

    // Group every (span, verdict) pair by the block it targets, so all
    // spans landing in the same element can be wrapped in a single
    // left-to-right sweep (required for correctness — see header comment).
    const byBlock = new Map();
    for (const verdict of flagged) {
      const spans = Array.isArray(verdict.spans) ? verdict.spans : [];
      if (spans.length === 0) {
        console.warn(`${LOG_PREFIX} render: verdict ${verdict.id} is flagged but has no spans; skipping.`);
        skipped += 1;
        continue;
      }
      for (const span of spans) {
        if (!span || typeof span.blockIndex !== 'number') {
          console.warn(`${LOG_PREFIX} render: verdict ${verdict.id} has a malformed span; skipping.`, span);
          skipped += 1;
          continue;
        }
        if (!byBlock.has(span.blockIndex)) byBlock.set(span.blockIndex, []);
        byBlock.get(span.blockIndex).push({ span, verdict });
      }
    }

    for (const [blockIndex, entries] of byBlock) {
      const el = nodes[blockIndex];
      if (!(el instanceof Node)) {
        console.warn(
          `${LOG_PREFIX} render: nodes[${blockIndex}] is not a live DOM node; skipping ${entries.length} span(s).`,
        );
        skipped += entries.length;
        continue;
      }

      const blockInfo = buildBlockInfo(el);
      if (blockInfo.nodeList.length === 0) {
        console.warn(
          `${LOG_PREFIX} render: block ${blockIndex} has no text nodes; skipping ${entries.length} span(s).`,
        );
        skipped += entries.length;
        continue;
      }

      // Resolve raw offsets up front and sort ascending — the sequential
      // cursor below assumes it never has to walk backwards over a text
      // node it has already split.
      const resolved = [];
      for (const { span, verdict } of entries) {
        const rawStart = collapsedToRaw(blockInfo, span.start);
        const rawEnd = collapsedToRaw(blockInfo, span.end);
        if (rawStart == null || rawEnd == null || !(rawStart < rawEnd)) {
          console.warn(
            `${LOG_PREFIX} render: span [${span.start},${span.end}) on block ${blockIndex} ` +
              `(verdict ${verdict.id}) could not be mapped to raw text offsets; skipping.`,
          );
          skipped += 1;
          continue;
        }
        resolved.push({ span, verdict, rawStart, rawEnd });
      }
      resolved.sort((a, b) => a.rawStart - b.rawStart);

      // Live cursor per original text node. Wrapping a portion of a text
      // node with Range.surroundContents splits it; `liveNode`/`liveStart`
      // track whatever unconsumed remainder is still live so the NEXT
      // span touching this same original node computes correct offsets
      // against the node as it now actually exists in the DOM.
      const liveState = blockInfo.nodeList.map((entry) => ({
        start: entry.start,
        end: entry.end,
        liveNode: entry.node,
        liveStart: entry.start,
        exhausted: false,
      }));

      for (const { span, verdict, rawStart, rawEnd } of resolved) {
        let wrappedAny = false;
        let attemptedAny = false;

        const severityClass = SEVERITY_CLASS[verdict.severity];
        if (!severityClass) {
          console.warn(
            `${LOG_PREFIX} render: verdict ${verdict.id} has unrecognized severity ` +
              `"${verdict.severity}"; falling back to low.`,
          );
        }

        for (const st of liveState) {
          if (st.exhausted) continue;

          const overlapStart = Math.max(st.start, rawStart);
          const overlapEnd = Math.min(st.end, rawEnd);
          if (overlapEnd <= overlapStart) continue;

          attemptedAny = true;

          const liveLen = st.liveNode && typeof st.liveNode.data === 'string' ? st.liveNode.data.length : -1;
          const liveOffsetStart = overlapStart - st.liveStart;
          const liveOffsetEnd = overlapEnd - st.liveStart;

          if (!st.liveNode || liveOffsetStart < 0 || liveOffsetEnd > liveLen || liveOffsetStart >= liveOffsetEnd) {
            console.warn(
              `${LOG_PREFIX} render: unexpected live-offset state for verdict ${verdict.id} ` +
                `on block ${blockIndex}; skipping this text-node segment.`,
            );
            continue;
          }

          try {
            const range = document.createRange();
            range.setStart(st.liveNode, liveOffsetStart);
            range.setEnd(st.liveNode, liveOffsetEnd);

            const mark = document.createElement('mark');
            mark.className = `${BASE_CLASS} ${severityClass || SEVERITY_CLASS.low}`;
            mark.setAttribute('data-fpf-id', String(verdict.id));
            mark.setAttribute('data-fpf-category', verdict.category == null ? '' : String(verdict.category));
            mark.setAttribute('data-fpf-probability', String(verdict.probability));
            mark.tabIndex = 0;

            attachHoverHandlers(mark, verdict);

            // No markup-string rewriting here: this is a Range over live
            // text nodes, so surroundContents preserves every event
            // handler and binding elsewhere on the page. The range's
            // boundary points are both
            // inside the SAME text node here (by construction — we only
            // ever set start/end on `st.liveNode`), so surroundContents
            // never encounters a range that partially selects a non-text
            // node and cannot throw the "partial node" error; it can still
            // throw for other reasons (e.g. a detached node), which is
            // caught below.
            range.surroundContents(mark);
            wrappedAny = true;

            const hasRemainder = liveOffsetEnd < liveLen;
            if (hasRemainder) {
              const after = mark.nextSibling;
              if (after && after.nodeType === Node.TEXT_NODE) {
                st.liveNode = after;
                st.liveStart = overlapEnd;
              } else {
                // Shouldn't happen, but don't silently compute wrong
                // offsets for a later span against this node.
                st.exhausted = true;
              }
            } else {
              st.exhausted = true;
            }
          } catch (err) {
            console.warn(
              `${LOG_PREFIX} render: surroundContents failed for verdict ${verdict.id} on block ${blockIndex}:`,
              err,
            );
          }
        }

        if (wrappedAny) {
          highlighted += 1;
        } else if (attemptedAny) {
          console.warn(
            `${LOG_PREFIX} render: span [${span.start},${span.end}) on block ${blockIndex} ` +
              `(verdict ${verdict.id}) overlapped text but every wrap attempt failed; skipping.`,
          );
          skipped += 1;
        } else {
          console.warn(
            `${LOG_PREFIX} render: span [${span.start},${span.end}) on block ${blockIndex} ` +
              `(verdict ${verdict.id}) overlapped no live text node; skipping.`,
          );
          skipped += 1;
        }
      }
    }

    console.log(`${LOG_PREFIX} render: highlighted=${highlighted} skipped=${skipped}`);
    return { highlighted, skipped };
  };

  /**
   * Removes every mark this module created and restores the original text
   * structure (adjacent text-node fragments created by splitText during
   * wrapping are merged back together via Node.normalize()).
   */
  NS.clearHighlights = function () {
    const marks = document.querySelectorAll(MARK_SELECTOR);
    const parents = new Set();

    marks.forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) return;
      while (mark.firstChild) {
        parent.insertBefore(mark.firstChild, mark);
      }
      parent.removeChild(mark);
      parents.add(parent);
    });

    parents.forEach((p) => p.normalize());

    console.log(`${LOG_PREFIX} render: cleared ${marks.length} highlight(s).`);
    return { removed: marks.length };
  };
})();
