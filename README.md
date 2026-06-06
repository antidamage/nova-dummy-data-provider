# Nova Dummy Data Provider

Static dummy data and a browser-side fake Home Automation service for the public Nova HA Dashboard demo.

## What It Provides

- GitHub Pages friendly JSON fixtures under `public/api`.
- `public/provider.mjs`, which simulates dashboard API reads and writes in the browser.
- Per-visitor demo persistence with a daily reset keyed to `Pacific/Auckland`.

## Local Commands

```powershell
npm install
npm test
npm run build
npm run preview
```

## Public Contract

The dashboard demo loads:

- `https://<owner>.github.io/nova-dummy-data-provider/api/state.json`
- `https://<owner>.github.io/nova-dummy-data-provider/provider.mjs`

See `SPEC.md` for the full route and persistence contract.
