# FPF CORS Spike

Proves (or disproves) that an MV3 service worker can call `https://api.typesafe.ai`
directly with an `Authorization` header, relying only on `host_permissions`, without
being blocked by CORS preflight the way a page-context `fetch` would be. The whole
project's architecture depends on this being true (see `fine-print-fury-spec.md` §2, §9 step 0).

## Steps

1. Copy the example key file and fill in a real key:

   ```
   cp key.local.example.js key.local.js
   ```

   Then edit `key.local.js` and replace `"paste-your-key-here"` with your real
   `TYPESAFE_API_KEY` value. **Never commit this file with a real key in it** —
   it's already gitignored, but double-check `git status` before committing anything.

2. Open `chrome://extensions` in Chrome.

3. Enable "Developer mode" using the toggle in the top-right corner.

4. Click "Load unpacked" and select this `spike/` directory.

5. Find the "FPF CORS Spike" card and click the "service worker" link
   (Chrome shows this once the worker has run). This opens a DevTools
   inspector attached to the service worker.

6. Read the Console tab. The probe runs automatically on load/install.

## What PASS looks like

Console shows lines prefixed `[FPF SPIKE]` including:

```
[FPF SPIKE] response status: 200
[FPF SPIKE] threw: false
[FPF SPIKE] parsed JSON body: {...}
[FPF SPIKE] PASS — request completed without CORS/network error, status 200
```

A `PASS` line appears, a numeric HTTP status is logged, and `threw: false`.
Even a non-200 status (e.g. 401 for a bad key) still counts as a PASS for the
*CORS* question specifically, since the fetch reached the network and got a
real HTTP response rather than being blocked — the spike output says so
explicitly in that case.

## What FAIL looks like

```
[FPF SPIKE] threw: true
[FPF SPIKE] full error: TypeError: Failed to fetch
[FPF SPIKE] FAIL — the fetch threw, which is consistent with a CORS/network block.
```

The fetch throws (typically `TypeError: Failed to fetch`), no HTTP status is
logged, and a `FAIL` line appears. If you see this, the architecture in
`fine-print-fury-spec.md` needs to change before any further work proceeds.
