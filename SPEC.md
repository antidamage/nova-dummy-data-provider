# Nova Dummy Data Provider Spec

## Purpose

`nova-dummy-data-provider` is the fake Home Automation backend for the public Nova HA Dashboard demo. It is designed for GitHub Pages, so it must run entirely as static files plus browser-side JavaScript.

The provider must never contain Home Assistant tokens, live Nova URLs, personal data, or any other secret. It exists only to make the dashboard demo look and behave like a real installation.

## Parity with a real installation

The demo should read as the owner's wall display at 1080x1920 with its data replaced. Rooms, controls, slot order, theme and layout match the real installation. Everything that identifies the household does not:

- Device, machine and account identifiers become neutral names (`climate.demo_aircon`, `switch.voice_mute`, "Wall Display"). Hardware makes, models and device ids are dropped, except the router's model name, which the dashboard's shared default config uses for its entity ids.
- People and reminders are invented, not edited copies. Reminders keep only the icon set.
- Sensor readings are plausible values. A device that happens to be offline on the real system is shown working, because a fault is not part of the look.
- The "Interactive demo" warning stays, so a visitor is never told a fictional home is real.

The mapping from real identifiers to these names is never committed here.

## Sample camera feed

`public/camera/outside/seg_000.ts` to `seg_299.ts`: ten minutes of CC BY 4.0 footage (README) cut into exact 2 s segments, 640x360, 12 fps, H.264, a keyframe at each segment start, about 115 kbps and 8.3 MB in all. They are committed directly under `public/` and have no copy under `src/`.

`GET /api/camera/outside/index.m3u8` and `/status` are computed from the clock, with no stored state:

- Segment number `n` is `floor(epochMs / 2000)`, and plays `seg_(n mod 300)`. Every visitor sees the same position.
- The playlist is a sliding window of the newest 300 finished segments with `EXT-X-PROGRAM-DATE-TIME`, so the DVR window is ten minutes.
- `EXT-X-DISCONTINUITY` marks each loop point, and `EXT-X-DISCONTINUITY-SEQUENCE` is `floor(first / 300)`.
- `status` reports `recording: true` with the same window's oldest and newest times.

Done means, in a Chromium browser on the deployed site: the panel plays and reads LIVE, scrubbing moves within the window, the jog changes the rate forward and runs in reverse, and Live returns to the edge.

## GitHub Pages Constraints

GitHub Pages can serve files, but it cannot run server-side API routes or accept real POST handlers. For that reason:

- Boot data is published as static JSON under `public/api`.
- Runtime writes are handled by `public/provider.mjs` inside the visitor's browser.
- Writes persist per visitor in browser storage only.
- There is no cross-user shared state for v1.

## Public Static Fixtures

The Pages site exposes these static files:

- `/api/state.json`
- `/api/tasks.json`
- `/api/watchface.json`
- `/api/power.json`
- `/api/router.json`
- `/api/nova-load.json`
- `/api/system.json`
- `/api/version.json`
- `/api/reminder-icons.json`
- `/assets/outside-demo.png` (AI-generated fictional camera scene: event thumbnails, and the panel's still before the feed is ready)
- `/camera/outside/seg_NNN.ts` (the sample camera feed)

These fixtures seed a visitor's demo. Configuration and theme are owned by the
dashboard's demo bootstrap, not this provider.

## Provider Module API

`/provider.mjs` exports:

- `createNovaDummyProvider(options?)`
- `provider.handleRequest(path, init?)`
- `provider.reset()`
- `provider.snapshot()`

`handleRequest` accepts dashboard-style paths such as `/api/state`, `/api/theme`, `/api/zone`, and `/api/entity`, then returns a `Response`.

## Browser Persistence

The provider stores mutable demo state in browser storage using this envelope:

```json
{
  "schemaVersion": 5,
  "resetKey": "2026-06-04",
  "state": {},
  "tasks": [],
  "system": {},
  "sampleAnchorAt": "2026-06-04T12:00:00Z"
}
```

`resetKey` records the New Zealand date on which the state was first created,
but visitor changes persist until the provider schema changes or the visitor
clears browser storage. Time-sensitive gym and task data is refreshed so it
does not go stale.

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
- `GET/POST /api/agent`
- `GET/POST /api/layout`
- `GET /api/update`
- `GET/PUT /api/camera/outside/settings`
- `GET /api/desktop/computers`
- `GET/POST /api/voice`
- `GET /api/voice/options`
- `GET/POST /api/voice/engine`
- `GET/POST /api/voice/satellites`
- `GET /api/voice/voices/:engine`
- `GET /api/voice/speaker-profiles`
- `GET /api/voice/administration`
- `GET /api/voice/memories`
- `GET /api/voice/automations`
- `GET /api/voice/training`
- `GET/DELETE /api/voice/transcript`
- `GET/POST /api/voice-personality-library`
- `POST /api/zone`
- `POST /api/entity`
- `POST /api/aircon/timer`
- `POST /api/panel-heater/timer`
- `POST /api/desktop/sleep`

Additional current routes include health and demo identity, reminder icons and
undo, CSV task import, the bedroom thermostat, status-orb settings, Phonoscope
configuration and image libraries, House Party zone participation, desktop
configuration and wallpapers, background textures, camera analysis zones and
event review, companion status, and local memory/automation/authority mutations.

Unsupported operations return explanatory JSON errors. Voice synthesis, model
training, face capture, module installation and real external actions require a
Nova installation. No route sends a device command or accesses household services.
Uploaded demo images are limited to 1 MB each and stored as browser-local data URLs.

The dashboard starts in the real installation's active theme. Config navigation preserves the Pages base
path; its demo reset clears the fixture state and demo preferences, without
invoking the household authentication service. Sample timestamps rebase together
to preserve chronology. Polls refresh sensor timestamps and expire sleep timers;
power reads recompute the current device estimates and refresh chart dates.

## Dummy Entity Catalog

The default state includes:

- Zones: Home, Lounge, Bedroom, Conservatory, Kitchen, Climate,
  Outside, and Network. Grid, World, and Tasks remain dashboard-owned special
  zones so the provider does not create duplicates.
- The top-level dashboard Grid entry handles power; the dummy state does not include a Power sub-zone.
- Nova load defaults to a low demo value near 15%.
- Lights covering on/off, brightness, RGB, and colour-temperature support.
- Illumination switches.
- Air conditioner with heat, fan, cool, fan modes, and target temperature.
- Panel heater.
- Fresh-air, quiet, and turbo switches.
- Lounge and bedroom temperature/humidity sensors.
- Router status and speed sensors.
- Weather and sun data.
- Demo local and mirrored tasks.
- Complete current power-dashboard graphs, rates, base loads, and device
  estimates.
- Managed computers, camera settings, voice engines, satellites, trained and
  custom voices, speaker profiles, agent goals/grants/research, memories,
  automations, interventions, transcripts, and voice-training state.

## Demo Gym Timestamp

The provider replaces fixture `watchface.gymLastResetAt` with the current
provider time when it creates or reads demo state. `/api/state` and
`/api/watchface` both report that timestamp with `daysSinceGym: 0`, so the
dashboard demo does not show stale gym-attendance age.

## Compatibility Target

The compatibility target is the current `nova-ha-dashboard` browser demo mode. Production Nova behavior must remain unchanged.
