// FPF CORS Spike — service worker
//
// Purpose: prove that an MV3 service worker can call https://api.typesafe.ai
// directly with an Authorization header, using only host_permissions, and
// without hitting the CORS preflight behavior that would block a page-context
// fetch. See fine-print-fury-spec.md §2 and §9 step 0.

import { API_KEY } from './key.local.js';

async function runProbe(trigger) {
  console.log(`[FPF SPIKE] --- probe start (trigger: ${trigger}) ---`);

  try {
    const response = await fetch('https://api.typesafe.ai/v1/models', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
      },
    });

    console.log(`[FPF SPIKE] response status: ${response.status}`);
    console.log(`[FPF SPIKE] threw: false`);

    if (response.ok) {
      const body = await response.json();
      console.log('[FPF SPIKE] parsed JSON body:', body);
      console.log('[FPF SPIKE] PASS — request completed without CORS/network error, status', response.status);
    } else {
      const text = await response.text().catch(() => '<unreadable body>');
      console.log('[FPF SPIKE] non-OK response body:', text);
      console.log(
        `[FPF SPIKE] PASS (fetch itself was not blocked by CORS) but response status ${response.status} — check API key / endpoint. If status is 401, the key is invalid; the network call still went through, which is what this spike verifies.`
      );
    }
  } catch (err) {
    console.log('[FPF SPIKE] threw: true');
    console.log('[FPF SPIKE] full error:', err);
    console.log('[FPF SPIKE] FAIL — the fetch threw, which is consistent with a CORS/network block. See error above.');
  }

  console.log('[FPF SPIKE] --- probe end ---');
}

chrome.runtime.onInstalled.addListener(() => {
  runProbe('onInstalled');
});

// Also run unconditionally at service-worker startup (covers the case where
// the worker wakes up without an install/update event, e.g. after being
// evicted and restarted by an unrelated event).
runProbe('service-worker-startup');
