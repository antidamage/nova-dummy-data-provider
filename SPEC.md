# Nova Dummy Data Provider Spec

## Purpose

`nova-dummy-data-provider` is the fake Home Automation backend for the public Nova HA Dashboard demo. It is designed for GitHub Pages, so it must run entirely as static files plus browser-side JavaScript.

The provider must never contain Home Assistant tokens, live Nova URLs, personal data, or any other secret. It exists only to make the dashboard demo look and behave like a real installation.

## GitHub Pages Constraints

GitHub Pages can serve files, but it cannot run server-side API routes or accept real POST handlers. For that reason:

- Boot data is published as static JSON under `public/api`.
- Runtime writes are handled by `public/provider.mjs` inside the visitor's browser.
- Writes persist per visitor in browser storage only.
- There is no cross-user shared state for v1.

## Public Static Fixtures

The Pages site exposes these static files:

- `/api/state.json`
- `/api/config-client.json`
- `/api/tasks.json`
- `/api/theme.json`
- `/api/watchface.json`
- `/api/power.json`
- `/api/router.json`
- `/api/nova-load.json`
- `/api/version.json`

These fixtures are the reset/default state for each demo day.

## Provider Module API

`/provider.mjs` exports:

- `createNovaDummyProvider(options?)`
- `provider.handleRequest(path, init?)`
- `provider.reset()`
- `provider.snapshot()`

`handleRequest` accepts dashboard-style paths such as `/api/state`, `/api/theme`, `/api/zone`, and `/api/entity`, then returns a `Response`.

## Browser Persistence And NZ Reset

The provider stores mutable demo state in browser storage using this envelope:

```json
{
  "schemaVersion": 1,
  "resetKey": "2026-06-04",
  "state": {},
  "theme": {},
  "tasks": [],
  "config": {}
}
```

`resetKey` is computed from the current date in `Pacific/Auckland`. On initialization, if the saved reset key differs from today's NZ key, saved demo state is discarded and defaults are restored.

This reset applies to theme edits, task edits, climate/lighting control changes, config edits, and watchface edits. A visitor can edit and save theme settings during the day; they reset to defaults on the first load after the next NZ date begins.

## Supported Dashboard Routes

The provider supports the dashboard browser routes needed by the static demo:

- `GET /api/state`
- `GET /api/config/client`
- `GET /api/config`
- `PUT /api/config`
- `GET /api/theme`
- `POST /api/theme`
- `GET /api/tasks?command=list`
- `POST /api/tasks?command=add`
- `PATCH /api/tasks/:id`
- `DELETE /api/tasks/:id`
- `POST /api/tasks/:id/complete`
- `POST /api/tasks/:id/dismiss`
- `GET /api/tasks/audio?status=1`
- `GET /api/tasks/icloud-status`
- `POST /api/tasks/sync-icloud`
- `GET /api/watchface`
- `POST /api/watchface`
- `GET /api/power`
- `GET /api/router`
- `GET /api/nova-load`
- `GET /api/version`
- `POST /api/zone`
- `POST /api/entity`
- `POST /api/aircon/timer`
- `POST /api/panel-heater/timer`
- `POST /api/desktop/sleep`

Unsupported routes return a realistic JSON error response.

## Dummy Entity Catalog

The default state includes:

- Zones: Everything, Lounge, Bedroom, Office, Kitchen, Climate, Network, Tasks.
- The top-level dashboard Grid entry handles power; the dummy state does not include a Power sub-zone.
- Nova load defaults to a low demo value near 15%.
- Lights with brightness and RGB support.
- Illumination switches.
- Air conditioner with heat, fan, cool, fan modes, and target temperature.
- Panel heater.
- Fresh-air, quiet, and turbo switches.
- Lounge temperature/humidity sensors.
- Router status and speed sensors.
- Weather and sun data.
- Demo local and mirrored tasks.

## Demo Gym Timestamp

The provider replaces fixture `watchface.gymLastResetAt` with the current
provider time when it creates or reads demo state. `/api/state` and
`/api/watchface` both report that timestamp with `daysSinceGym: 0`, so the
dashboard demo does not show stale gym-attendance age.

## Compatibility Target

The compatibility target is the current `nova-ha-dashboard` browser demo mode. Production Nova behavior must remain unchanged.
