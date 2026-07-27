# Nova Dummy Data Provider

Static dummy data and a browser-side fake Home Automation service for the public Nova HA Dashboard demo.

## What It Provides

- GitHub Pages friendly JSON fixtures under `public/api`.
- `public/provider.mjs`, which simulates dashboard API reads and writes in the browser.
- Per-visitor demo persistence in browser storage.
- Rich Home Assistant, power, computer, camera, voice, agent, training, and
  household-person fixtures for exploring the current dashboard.

Voice and agent routes are simulated UI data only. The public demo has no
microphone, models, training host, household memory, or acting agent.

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
