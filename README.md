# Nova Dummy Data Provider

The demo backend for Nova. Static JSON fixtures plus a browser-side module that
stands in for the dashboard's server APIs, so
[Nova HA Dashboard](https://github.com/antidamage/nova-ha-dashboard) can run on
static hosting with no Home Assistant behind it.

**[Live demo](https://antidamage.github.io/nova-ha-dashboard/config/)**

## Where it fits

| Component | Interface |
|---|---|
| The public dashboard demo on GitHub Pages | Loads `state.json` and `provider.mjs` from this project's Pages site |
| Dashboard developers | `npm run build:demo -- http://127.0.0.1:4174/` against a local provider |

## What it does

**Serves fixtures.** GitHub Pages-friendly JSON under `public/api`, covering Home
Assistant entities, power, computers, cameras, voice, agent, training and
household-person data — enough for nearly every dashboard surface to render.

**Simulates reads and writes.** `public/provider.mjs` intercepts the dashboard's
API calls in the browser, so demo actions such as switching a light or changing a
theme take effect and persist.

**Isolates visitors.** Demo state persists per-visitor in browser storage rather
than server-side.

Voice and agent routes are simulated UI data only. The demo has no microphone,
models, training host, household memory or acting agent, so those panels are
preview-only.

## Install

```powershell
npm install
npm test
npm run build
npm run preview
```

## Public contract

The dashboard demo loads:

```
https://<owner>.github.io/nova-dummy-data-provider/api/state.json
https://<owner>.github.io/nova-dummy-data-provider/provider.mjs
```

JSON fixtures live under `public/api`; the browser-side provider is
`public/provider.mjs`. See [`SPEC.md`](SPEC.md) for the full route and
persistence contract.
