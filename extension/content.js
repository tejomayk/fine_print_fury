// extension/content.js
//
// Entry point for a manual scan (spec §9 step 3). Injected as a classic
// script via chrome.scripting.executeScript alongside domwalk.js and
// detect.js — MV3 content scripts cannot use static ESM imports, so all
// three files share state through a single global namespace object,
// globalThis.__FPF, rather than importing one another. domwalk.js and
// detect.js publish walkBlocks()/detectLegalPage() onto it before this
// file runs; the expected injection order is
// [domwalk.js, detect.js, content.js].
//
// This file runs its logic immediately (an IIFE, not a message-triggered
// handler) because "click Scan" IS "inject these files into the tab" —
// see the double-injection guard immediately below.

(function () {
  const NS = (globalThis.__FPF = globalThis.__FPF || {});

  // --- Double-injection guard -----------------------------------------
  // The user can click Scan more than once (e.g. impatient re-click, or a
  // second scan after the page changed). chrome.scripting.executeScript
  // re-runs a classic script's top-level code on every injection, so
  // without this guard a second click would walk the DOM again, fire a
  // second SCAN_REQUEST with its own listener, and double-log everything.
  // domwalk.js/detect.js are pure function *definitions* and are already
  // idempotent to re-run (redefining a function is harmless), so only
  // this file — which has side effects (sending a message, logging,
  // registering a listener) — needs to early-return.
  if (NS.initialized) {
    console.log('[FPF] content script already initialized on this page; ignoring re-injection.');
    return;
  }
  NS.initialized = true;

  if (typeof NS.walkBlocks !== 'function' || typeof NS.detectLegalPage !== 'function') {
    console.error(
      '[FPF] domwalk.js / detect.js did not load before content.js — aborting scan.'
    );
    return;
  }

  // --- Walk the DOM -----------------------------------------------------
  const { blocks, nodes } = NS.walkBlocks(document.body);

  // Stash node references on the namespace object. The node array never
  // crosses the extension message boundary (chrome.runtime.sendMessage
  // structured-clones its payload and cannot carry live DOM nodes anyway)
  // — only the parallel text array (`blocks`) is sent to the background
  // worker. `nodes` stays here so that when verdicts come back with
  // block-indexed spans, we can map straight back to the element that
  // produced each piece of text.
  NS.nodes = nodes;
  NS.blocks = blocks;

  console.log(`[FPF] walked DOM: ${blocks.length} candidate block(s) found.`);

  // --- Advisory detection -------------------------------------------------
  // Per spec §3.2 / build order §9 step 5, detection is advisory-only in
  // this phase: logged, but a manual scan proceeds regardless of the
  // result. Auto-triggering off this signal is a later phase.
  const detection = NS.detectLegalPage(document, location.href);
  console.log('[FPF] legal-page detection (advisory only, does not gate this scan):', detection);

  if (blocks.length === 0) {
    console.warn('[FPF] no block-level text found on this page; sending an empty scan anyway.');
  }

  // --- Send to background worker ----------------------------------------
  function randomRequestId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    // Fallback for environments without crypto.randomUUID.
    return `fpf-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  const requestId = randomRequestId();

  const request = {
    type: 'SCAN_REQUEST',
    requestId,
    documentType: 'Terms of Service',
    source: location.hostname,
    blocks,
  };

  console.log(`[FPF] sending SCAN_REQUEST ${requestId} with ${blocks.length} block(s) to background worker.`);

  chrome.runtime.sendMessage(request, (response) => {
    if (chrome.runtime.lastError) {
      // No listener / background worker unreachable (e.g. it wasn't
      // ready, or the extension was reloaded mid-scan).
      console.error(
        `[FPF] SCAN_REQUEST ${requestId} failed to reach the background worker:`,
        chrome.runtime.lastError.message
      );
      return;
    }

    if (!response) {
      console.error(`[FPF] SCAN_REQUEST ${requestId} got no response from the background worker.`);
      return;
    }

    if (response.requestId && response.requestId !== requestId) {
      console.warn(
        `[FPF] received SCAN_RESULT for a different requestId (expected ${requestId}, got ${response.requestId}); ignoring.`
      );
      return;
    }

    handleScanResult(response);
  });

  // --- Handle the reply ---------------------------------------------------
  function truncate(text, n = 140) {
    if (text.length <= n) return text;
    return `${text.slice(0, n)}…`;
  }

  // Reconstruct a flagged verdict's clause text from its spans by slicing
  // the ORIGINAL blocks array (the same text we sent) at [start, end).
  // blockIndex indexes into `blocks` as sent — and therefore, by the
  // parallel-array invariant documented in domwalk.js, into `nodes` too.
  function textFromSpans(spans) {
    return spans
      .map((span) => {
        const block = blocks[span.blockIndex];
        if (typeof block !== 'string') return '';
        return block.slice(span.start, span.end);
      })
      .join(' ');
  }

  function handleScanResult(response) {
    if (response.ok === false) {
      console.error(
        `[FPF] scan failed — errorCode: ${response.errorCode}. ${response.message || ''}`
      );
      return;
    }

    if (response.ok !== true) {
      console.error('[FPF] SCAN_RESULT reply has neither ok:true nor ok:false — malformed response:', response);
      return;
    }

    const { pageScore, model, clauseCount, flaggedCount, verdicts = [] } = response;

    console.log(
      `[FPF] scan complete — model: ${model} · clauses: ${clauseCount} · flagged: ${flaggedCount} · page score: ${pageScore}`
    );

    const flagged = verdicts.filter((v) => v.flagged);

    if (flagged.length === 0) {
      console.log('[FPF] no clauses were flagged.');
    } else {
      console.log(`[FPF] flagged clause detail (${flagged.length}):`);
      for (const v of flagged) {
        const text = truncate(textFromSpans(v.spans || []));
        console.log(
          `[FPF]   id=${v.id} · probability=${v.probability} · category=${v.category} · severity=${v.severity} · text="${text}"`
        );
      }
    }

    // --- Worked example: prove the spans -> blocks -> nodes mapping ------
    // Phase 4 will turn each span into a Range over `nodes[span.blockIndex]`
    // to paint <mark> highlights directly on the live page (spec §3.5).
    // That depends entirely on the parallel-array invariant established in
    // domwalk.js (blocks[i] <-> nodes[i]) still holding after the message
    // round trip. We don't build a Range yet — that's Phase 4's job — but
    // we prove here, for the first flagged verdict, that the mapping is
    // sound: the node at blockIndex is a real element, and slicing its
    // captured block text by [start, end) reproduces exactly the clause
    // text logged above.
    //
    // >>> PHASE 4 HOOK: build Range(nodes[blockIndex], start, end) here <<<
    //
    // render.js (published on NS by this point per the injection order in
    // background.js) does exactly that: it maps every flagged verdict's
    // spans onto Ranges over `nodes`/`blocks` and wraps them in <mark>
    // elements. Guarded so a render.js load failure degrades to "no visible
    // highlights, scan still logged" instead of throwing and losing the
    // console diagnostics below.
    if (typeof NS.clearHighlights === 'function') {
      // A second scan on the same page (see content.js's double-injection
      // guard above for why that's currently rare, but don't rely on it)
      // must not stack a second set of marks on top of the first.
      NS.clearHighlights();
    }

    if (typeof NS.renderVerdicts === 'function') {
      const { highlighted, skipped } = NS.renderVerdicts(verdicts, nodes, blocks);
      console.log(
        `[FPF] render: highlighted ${highlighted} clause span(s) on the page, skipped ${skipped} unmappable span(s).`
      );
    } else {
      console.error('[FPF] render.js did not load (NS.renderVerdicts is missing) — no highlights were drawn.');
    }

    if (flagged.length > 0 && flagged[0].spans && flagged[0].spans.length > 0) {
      const span = flagged[0].spans[0];
      const node = nodes[span.blockIndex];
      const blockText = blocks[span.blockIndex];
      const sliced = typeof blockText === 'string' ? blockText.slice(span.start, span.end) : undefined;

      console.log('[FPF] worked example — mapping span back to its source node:');
      console.log('[FPF]   spans[0]:', span);
      console.log('[FPF]   nodes[blockIndex]:', node);
      console.log('[FPF]   blocks[blockIndex] (full block text):', blockText);
      console.log('[FPF]   blocks[blockIndex].slice(start, end):', sliced);
      console.log(
        '[FPF]   node is the right element:',
        node instanceof Node ? `<${node.nodeName.toLowerCase()}>` : node,
        '— its textContent contains the sliced clause:',
        !!(node && typeof node.textContent === 'string' && node.textContent.replace(/\s+/g, ' ').includes((sliced || '').trim()))
      );
    }
  }
})();
