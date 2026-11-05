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

## Live simulation

Produced by card 137856. Owner's choices, 2026-11-05: gentle ambient life; timers in real time and physical processes compressed; typed voice unchanged; no mock maintenance processes.

The demo behaves as if a house is running behind it. Everything below happens in the visitor's browser with invented data, and no route reaches a device or a service.

### Out of scope, unchanged

Typed voice turns, update check/apply/rollback, computer sleep and wake, voice LLM switching, voice training, module installation and face capture keep their existing response or their "needs a real Nova installation" message.

### The clock

`src/provider/simulation.mjs` holds the rules as pure functions over the stored envelope, the current time and a random source, and starts no timers. `provider.tick()` runs them once. `provider.subscribe(listener)` starts a 5 s interval at the first listener, stops it at the last, and returns an unsubscribe function. A listener is called `listener(eventName, data)` for each event below.

A tick after a long gap (reload, sleeping laptop) counts at most 60 s of physics. Time-based ends are exact: a timer or a wash that ended during the gap ends at its own time, on the first tick. The ambient scheduler starts nothing while `document.hidden`, so a returning visitor is not met with a pile of events.

### Events pushed to the page

The dashboard's demo `EventSource` delivers these exactly as the real `/api/events` stream names them:

| Event | Data | When |
|---|---|---|
| `state` | the `/api/state` body | each tick in which an entity changed |
| `orb-timer` | `{ timer }` | set, completed, dismissed, cancelled |
| `tasks` | `{ tasks }` | an ambient reminder is added or removed |
| `notifications` | `{ notifications }` | on connect, from `provider.eventSnapshot()` |
| `notification` | one notification | when raised |
| `notification-dismiss` | `{ id }` | when dismissed or expired |

A dashboard running against an older provider without `subscribe` keeps working with no push, so the two sites can deploy in either order.

### Household timer: `GET/POST /api/orb-timer`

Same contract and rules as the dashboard's `lib/orb-timer.ts` and `lib/orb-timer-model.ts`. Real time.

- `{ command: "set", durationMs, icon, label }`: 0 cancels with no sound; above 8 h or invalid is a 400; replacing a timer starts a new id. `autoComplete: true`.
- `completedAt` is set to `endsAt` at the first tick at or after it. A reload does not lose or restart a running timer.
- `{ command: "dismiss", id }` completes a timer within 5 s of its end and then sets `dismissedAt`; earlier than that it changes nothing.
- `{ command: "chime", id, slot }` returns `{ claimed }`, using the 30 s repeat over a 5 min window, once per slot. It repeats only when the orb stack holds a `timer` entry.
- The fixture's orb stack holds a `timer` entry, so a started timer shows on the orb.

### Climate

Each tick, per room (`sensor.lounge_temperature` with `climate.demo_aircon.current_temperature`; `sensor.bedroom_temperature`, plus the bedroom heater and panel heater):

- A running unit moves its room towards its target at 0.1 °C per 5 s and stops there. The aircon's target is `preferences.aircon.temperature`. The bedroom heater's is `preferences.bedroomHeater.temperature`; the panel heater warms at the same rate with no target, capped at 30 °C.
- With nothing running, the room moves towards 18 °C at 0.02 °C per 5 s.
- Values stay in 5 to 35 °C and are written to one decimal place. Fan-only and dry modes do not move temperature.
- `switch.bedroom_heater` in `auto` runs as a thermostat: on below target, off at target or above.
- Humidity wanders within ±3 points of its fixture value.

### Power and network

`GET /api/power` adds a slow wobble of at most ±3% to each device that is on, and includes a running wash at its current wattage. `GET /api/router` moves download and upload within 40% to 160% of their fixture values and updates `display` to match. Both are functions of the clock and need no stored state.

### Ambient scheduler

The first event comes 60 to 90 s after the page loads, later ones 180 to 360 s after the last one started. They take turns in this order, and a turn is skipped while its own kind is still running: wash, reminder, notification. Each page load gets at most 6, and none starts within 60 s of the visitor's own last action. The existing "Interactive demo" warning is the only marking; there is no new banner. A chime the browser has not yet allowed stays silent.

- **Wash.** 180 s on the clock, drawn from an invented curve peaking near 420 W. The smart plug's `switch.washing_machine` stays on, as a real plug does; the wattage appears on the device row and `washingMachine.watts`, and `washingMachine.open` and `running` are filled in. Time is compressed: the history records it as about an hour, so it reads like the fixture's washes on the day graph. On finishing it closes into `cycles` with a `curve` of at most 48 points, adds to the month totals and the day graph (`GET /api/power/washing-machine`), and raises a "Wash finished" notification. The newest 20 closed washes are kept.
- **Claiming a wash.** `POST /api/power/washing-machine` cycles or names the person for `{ active: true }` or `{ cycleId }`, as the real route does, and refuses an unknown person, cycle or inactive wash with its real status. Only the fixture's invented people appear. Claiming for the primary person replaces the one household timer with one for the wash's remaining time, with `autoComplete: false` and `washNotify: true`; `{ notify }` flips it, and moving the claim off that person cancels it if it is still the one the wash set. The wash's end completes that timer.
- **Reminder.** One invented local task, from a short fixed list of neutral chores, due 45 s after it is added. It is an ordinary task: it alerts, chimes and can be dismissed, edited or completed. One left unacknowledged is removed 10 min after it fell due. Only one exists at a time.
- **Notification.** One of a short fixed list of neutral household lines, `severity: "info"`, expires after 2 min.

All names are invented and none comes from the owner's household.

### Household routes that used to return 404

These now store per visitor, with the real route's response shape:

- `POST /api/aircon/target` sets `preferences.aircon.temperature` and the entity's `temperature`.
- `GET/POST /api/climate-range` reads and writes `preferences.climateTargetRange`.
- `POST /api/power/floating-meter` sets `activeCategoryId`; an unknown category is a 400.
- `POST /api/power/amp-automation` writes `ampControl`.
- `POST /api/orb-info/events` answers with no events, so event-driven orb entries read inactive rather than erroring.
- `DELETE /api/notifications?id=`.
- `GET/POST /api/camera/outside/saved` and `DELETE /api/camera/outside/saved/:id`: a saved range is a stored pair of times, `state: "ready"`, with `sizeBytes` estimated from the feed's bitrate. Playback uses a playlist built from those times with the same clock-to-segment rule as the sample feed. A range has no file behind it, so its download reaches the card's own "frame smoothing service is not running" message. The dashboard's `useSavedRanges` loads the list in demo mode, and `SavedRangePlayer` uses the demo playlist loader as the main player does.

### Reset and storage

The envelope gains `orbTimer` and `simulation` (`lastTickAt`, `nextAmbientAt`, `nextKind`, `wash`, `notifications`), and `schemaVersion` becomes 6. **Reset demo** clears them.

### Done

Unit tests cover: timer set, completion, dismiss, chime slots, reload and cancel; room temperature moving towards target and stopping; thermostat switching; gap capping; a whole wash from start through claim to the closed cycle and notification; scheduler ordering and the hidden-page hold; each route above.

In a Chromium browser against a local build of both sites: turn the timer dial and watch the orb count down in real seconds, reach Done and chime, and dismiss by tap; turn the aircon on and see the room reading move; wait for an ambient wash, claim it and see it finish; see the dashboard look unchanged otherwise, with no new console errors.

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
- `provider.tick()`, `provider.subscribe(listener)`, `provider.eventSnapshot()` ("Live simulation")

`handleRequest` accepts dashboard-style paths such as `/api/state`, `/api/theme`, `/api/zone`, and `/api/entity`, then returns a `Response`.

## Browser Persistence

The provider stores mutable demo state in browser storage using this envelope:

```json
{
  "schemaVersion": 6,
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
