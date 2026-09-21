// Fine Print Fury — popup controller.
//
// This file NEVER builds an authenticated request and NEVER reads or writes
// the API key to storage directly. Every key-touching operation is a message
// to the background worker, which is the only place `core/scoreChunk.js`
// (and its `validateApiKey`) is called (spec §2). The message contract below
// must match `extension/background.js` exactly:
//
//   { type:'GET_KEY_STATUS' }              -> { type:'KEY_STATUS', hasKey }
//   { type:'SET_API_KEY', apiKey }         -> { type:'SET_API_KEY_RESULT', ok, errorCode? }
//   { type:'TRIGGER_SCAN' }                -> { type:'TRIGGER_SCAN_RESULT', ok, errorCode?, message? }
//
// The key is never logged here, not even partially.

const $ = (selector) => document.querySelector(selector);

const views = {
  loading: $('#view-loading'),
  entry: $('#view-entry'),
  stored: $('#view-stored'),
};

function showView(name) {
  for (const [key, el] of Object.entries(views)) {
    el.hidden = key !== name;
  }
}

function setMessage(el, text, kind) {
  el.textContent = text || '';
  el.className = kind ? `message message--${kind}` : 'message';
  el.hidden = !text;
}

function setEntryMessage(text, kind) {
  setMessage($('#entry-message'), text, kind);
}

function setScanMessage(text, kind) {
  setMessage($('#scan-message'), text, kind);
}

function setEntryBusy(busy) {
  $('#save-btn').disabled = busy;
  $('#api-key-input').disabled = busy;
  $('#entry-spinner').hidden = !busy;
}

function setScanBusy(busy) {
  $('#scan-btn').disabled = busy;
  $('#scan-spinner').hidden = !busy;
}

async function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}

async function refreshStatus() {
  showView('loading');
  let response;
  try {
    response = await sendMessage({ type: 'GET_KEY_STATUS' });
  } catch {
    // Background worker unreachable; default to the entry view so the user
    // has something actionable rather than a stuck spinner.
    showView('entry');
    return;
  }
  showView(response && response.hasKey ? 'stored' : 'entry');
}

async function handleSaveKey() {
  const input = $('#api-key-input');
  const apiKey = input.value.trim();

  if (!apiKey) {
    setEntryMessage('Enter a key first.', 'error');
    return;
  }

  setEntryMessage('', null);
  setEntryBusy(true);

  try {
    const response = await sendMessage({ type: 'SET_API_KEY', apiKey });

    if (response && response.ok) {
      input.value = '';
      await refreshStatus();
      return;
    }

    const errorCode = response && response.errorCode;
    if (errorCode === 'UNAUTHORIZED') {
      setEntryMessage(
        'That key was rejected. Double-check it and try again.',
        'error',
      );
    } else if (errorCode === 'NETWORK') {
      setEntryMessage(
        "Couldn't reach the server to check the key. Check your connection and retry.",
        'error',
      );
    } else {
      setEntryMessage('Something went wrong saving the key. Try again.', 'error');
    }
  } catch {
    setEntryMessage(
      'Could not reach the extension background worker. Try again.',
      'error',
    );
  } finally {
    setEntryBusy(false);
  }
}

async function handleScan() {
  setScanMessage('', null);
  setScanBusy(true);

  try {
    const response = await sendMessage({ type: 'TRIGGER_SCAN' });

    if (response && response.ok) {
      setScanMessage(response.message || 'Scan started.', 'success');
    } else {
      setScanMessage(
        (response && response.message) || 'Scan failed. Try again.',
        'error',
      );
    }
  } catch {
    setScanMessage(
      'Could not reach the extension background worker.',
      'error',
    );
  } finally {
    setScanBusy(false);
  }
}

function handleReplaceKey(event) {
  event.preventDefault();
  setEntryMessage('', null);
  showView('entry');
  const input = $('#api-key-input');
  input.value = '';
  input.focus();
}

$('#save-btn').addEventListener('click', handleSaveKey);
$('#api-key-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    handleSaveKey();
  }
});
$('#scan-btn').addEventListener('click', handleScan);
$('#replace-key-link').addEventListener('click', handleReplaceKey);

refreshStatus();
