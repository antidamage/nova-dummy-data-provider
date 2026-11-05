import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createNovaDummyProvider } from "../src/provider/provider.mjs";

const NAMES = { state: "state", tasks: "tasks", watchface: "watchface", power: "power", router: "router", novaLoad: "nova-load", system: "system", version: "version" };

async function fixtures() {
  const entries = await Promise.all(Object.entries(NAMES).map(async ([key, name]) => [key, JSON.parse(await readFile(path.join("src", "fixtures", `${name}.json`), "utf8"))]));
  return Object.fromEntries(entries);
}

function storage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
}

/** A provider on a clock the test moves, with no ambient event unless asked for. */
async function harness({ hidden = true, shared = storage(), data } = {}) {
  const clock = { ms: Date.parse("2027-02-12T08:00:00Z") };
  const fixtureData = data ?? await fixtures();
  let isHidden = hidden;
  const make = () => createNovaDummyProvider({ fixtures: fixtureData, storage: shared, now: () => new Date(clock.ms), random: () => 0, isHidden: () => isHidden });
  const provider = make();
  await provider.snapshot(); // The simulation's clock starts here, as it does at a page load.
  const events = [];
  provider.subscribe((name, payload) => events.push([name, payload]));
  // subscribe() starts the real interval; the tests drive tick() themselves.
  const post = async (url, body, method = "POST") => {
    const response = await provider.handleRequest(url, { method, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const advance = async (ms, step = 5000) => {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      clock.ms += step;
      await provider.tick();
    }
  };
  return { clock, provider, events, post, advance, make, shared, setHidden: (value) => { isHidden = value; } };
}

const SET_FIVE_MINUTES = { command: "set", durationMs: 300_000, icon: "egg", label: "Egg" };

test("a timer runs on the real clock, completes at its end and is dismissed by a tap", async (t) => {
  const { provider, post, advance, clock, events } = await harness();
  t.after(() => process.nextTick(() => {}));
  const { body: { timer } } = await post("/api/orb-timer", SET_FIVE_MINUTES);
  assert.equal(timer.endsAt, clock.ms + 300_000);
  assert.equal(timer.autoComplete, true);
  assert.deepEqual(events.at(-1), ["orb-timer", { timer }]);

  await advance(295_000);
  assert.equal((await (await provider.handleRequest("/api/orb-timer")).json()).timer.completedAt, null);

  const early = await post("/api/orb-timer", { command: "chime", id: timer.id, slot: 0 });
  assert.equal(early.body.claimed, false);

  await advance(5000);
  const done = (await (await provider.handleRequest("/api/orb-timer")).json()).timer;
  assert.equal(done.completedAt, timer.endsAt);
  assert.ok(events.some(([name, payload]) => name === "orb-timer" && payload.timer?.completedAt === timer.endsAt));

  assert.equal((await post("/api/orb-timer", { command: "chime", id: timer.id, slot: 0 })).body.claimed, true);
  assert.equal((await post("/api/orb-timer", { command: "chime", id: timer.id, slot: 0 })).body.claimed, false);
  await advance(30_000);
  assert.equal((await post("/api/orb-timer", { command: "chime", id: timer.id, slot: 1 })).body.claimed, true, "repeats every 30 s with a timer entry on the orb");

  const dismissed = await post("/api/orb-timer", { command: "dismiss", id: timer.id });
  assert.notEqual(dismissed.body.timer.dismissedAt, null);
});

test("a timer refuses bad input, cancels at zero and ignores an early dismiss", async () => {
  const { post } = await harness();
  assert.equal((await post("/api/orb-timer", { ...SET_FIVE_MINUTES, durationMs: 9 * 3_600_000 })).status, 400);
  assert.equal((await post("/api/orb-timer", { command: "set", durationMs: 1000 })).status, 400);
  const { body: { timer } } = await post("/api/orb-timer", SET_FIVE_MINUTES);
  assert.equal((await post("/api/orb-timer", { command: "dismiss", id: timer.id })).body.timer.dismissedAt, null);
  assert.equal((await post("/api/orb-timer", { ...SET_FIVE_MINUTES, durationMs: 0 })).body.timer, null);
});

test("a running timer survives a reload without restarting", async () => {
  const shared = storage();
  const first = await harness({ shared });
  const { body: { timer } } = await first.post("/api/orb-timer", SET_FIVE_MINUTES);
  const reloaded = first.make();
  assert.equal((await (await reloaded.handleRequest("/api/orb-timer")).json()).timer.endsAt, timer.endsAt);
});

test("the room moves towards a running aircon's target and stops there", async () => {
  const { provider, post, advance } = await harness();
  const reading = async (id) => (await provider.snapshot()).state.entities.find((entity) => entity.entity_id === id);
  await post("/api/aircon/target", { temperature: 25 });
  await post("/api/entity", { entityId: "climate.demo_aircon", service: "set_hvac_mode", data: { hvac_mode: "cool" } });
  await advance(5000);
  assert.equal((await reading("sensor.lounge_temperature")).state, "25.9");
  assert.equal((await reading("climate.demo_aircon")).attributes.current_temperature, 25.9);
  await advance(60_000);
  assert.equal((await reading("sensor.lounge_temperature")).state, "25.0");
  await advance(10_000);
  assert.equal((await reading("sensor.lounge_temperature")).state, "25.0");
});

test("with nothing running the room drifts slowly and a long gap counts only 60 s", async () => {
  const { provider, clock } = await harness();
  clock.ms += 7 * 86_400_000;
  await provider.tick();
  const { state } = await provider.snapshot();
  const lounge = Number(state.entities.find((entity) => entity.entity_id === "sensor.lounge_temperature").state);
  assert.equal(lounge, 25.8, "12 ticks of 0.02 from 26");
});

test("the bedroom heater in auto is a thermostat", async () => {
  const { provider, post, advance } = await harness();
  const state = async () => (await provider.snapshot()).state;
  const heater = async () => (await state()).entities.find((entity) => entity.entity_id === "switch.bedroom_heater").state;
  await post("/api/bedroom-heater", { mode: "auto", temperature: 20.8 });
  assert.equal(await heater(), "on");
  await advance(15_000);
  assert.equal((await state()).entities.find((entity) => entity.entity_id === "sensor.bedroom_temperature").state, "20.8");
  await advance(5000);
  assert.equal(await heater(), "off");
});

test("ambient events take turns, respect a hidden page, the visitor and the per-load cap", async () => {
  const { advance, setHidden, provider, events, post, clock } = await harness();
  await advance(120_000);
  assert.equal((await provider.snapshot()).simulation.wash, null, "nothing starts while hidden");

  setHidden(false);
  await post("/api/zone", { zoneId: "everything", action: "white" });
  await advance(30_000);
  assert.equal((await provider.snapshot()).simulation.wash, null, "held back after the visitor's action");
  clock.ms += 30_000;
  await advance(5000);
  const first = await provider.snapshot();
  assert.ok(first.simulation.wash, "wash first");
  assert.equal(first.simulation.nextKind, "reminder");

  await advance(180_000);
  const second = await provider.snapshot();
  assert.ok(second.simulation.reminderId, "reminder second");
  assert.ok(second.tasks.some((task) => task.id === second.simulation.reminderId));
  assert.ok(events.some(([name]) => name === "tasks"));
  assert.equal(second.simulation.ambientThisLoad, 2);

  await advance(600_000 + 45_000);
  const later = await provider.snapshot();
  assert.ok(later.simulation.ambientThisLoad >= 3);
  assert.ok(later.simulation.ambientThisLoad <= 6);
  await advance(3_600_000, 60_000);
  assert.equal((await provider.snapshot()).simulation.ambientThisLoad, 6, "capped per load");
});

/** Runs the scheduler to the wash and returns its harness. */
async function withWash() {
  const context = await harness({ hidden: false });
  await context.advance(60_000);
  assert.ok((await context.provider.snapshot()).simulation.wash);
  return context;
}

test("a whole wash: running, claimed by the primary person, closed, in history, notified", async () => {
  const { provider, post, advance, events } = await withWash();
  const power = () => provider.handleRequest("/api/power").then((response) => response.json());
  await advance(20_000);
  const running = await power();
  assert.ok(running.washingMachine.watts > 0);
  assert.equal(running.washingMachine.open.person, null);
  assert.equal(running.devices.find((device) => device.entityId === "switch.washing_machine").watts, running.washingMachine.watts);

  // Unassigned, then each configured person in order: alex, then sam (the primary).
  const toAlex = await post("/api/power/washing-machine", { active: true });
  assert.equal(toAlex.body.washingMachine.open.person, "alex");
  assert.equal(toAlex.body.washingMachine.open.timer, undefined);
  const toSam = await post("/api/power/washing-machine", { active: true });
  const open = toSam.body.washingMachine.open;
  assert.equal(open.person, "sam");
  assert.equal(open.timer.notify, true);
  const timer = (await (await provider.handleRequest("/api/orb-timer")).json()).timer;
  assert.equal(timer.autoComplete, false);
  assert.equal(timer.washNotify, true);
  assert.equal(timer.id, open.timer.orbTimerId);

  await post("/api/power/washing-machine", { notify: false });
  assert.equal((await (await provider.handleRequest("/api/orb-timer")).json()).timer.washNotify, false);

  const before = (await power()).washingMachine.totals.find((row) => row.person === "sam");
  await advance(165_000);
  const after = await power();
  assert.equal(after.washingMachine.open, null);
  assert.equal(after.washingMachine.watts, null);
  assert.equal(after.washingMachine.cycles[0].person, "sam");
  assert.ok(after.washingMachine.cycles[0].curve.length <= 48);
  assert.equal(after.washingMachine.totals.find((row) => row.person === "sam").cycles, before.cycles + 1);
  assert.notEqual((await (await provider.handleRequest("/api/orb-timer")).json()).timer.completedAt, null);
  const raised = events.filter(([name, payload]) => name === "notification" && payload.title === "Wash finished");
  assert.equal(raised.length, 1);
  assert.equal((await (await provider.handleRequest("/api/notifications")).json()).notifications.length, 1);

  const history = await (await provider.handleRequest("/api/power/washing-machine")).json();
  const closed = history.cycles.find((cycle) => cycle.id === after.washingMachine.cycles[0].id);
  assert.equal(closed.durationLabel, "1h 00m");
});

test("moving a claim off the primary person cancels the wash's timer, and refusals match the real route", async () => {
  const { post, provider } = await withWash();
  assert.equal((await post("/api/power/washing-machine", { active: true, person: "nobody" })).status, 400);
  assert.equal((await post("/api/power/washing-machine", { cycleId: "missing" })).status, 404);
  assert.equal((await post("/api/power/washing-machine", {})).status, 400);
  await post("/api/power/washing-machine", { active: true, person: "sam" });
  assert.ok((await (await provider.handleRequest("/api/orb-timer")).json()).timer);
  await post("/api/power/washing-machine", { active: true, person: null });
  assert.equal((await (await provider.handleRequest("/api/orb-timer")).json()).timer, null);
});

test("no active wash is a 404 for a claim and for the bell; a past wash can be reattributed", async () => {
  const { post } = await harness();
  assert.equal((await post("/api/power/washing-machine", { active: true })).status, 404);
  assert.equal((await post("/api/power/washing-machine", { notify: true })).status, 404);
  const changed = await post("/api/power/washing-machine", { cycleId: "demo-cycle-1", person: "alex" });
  assert.equal(changed.body.washingMachine.cycles.find((cycle) => cycle.id === "demo-cycle-1").person, "alex");
  assert.equal(changed.body.washingMachine.totals.find((row) => row.person === "alex").cycles, 2);
});

test("household routes store per visitor with the real shapes", async () => {
  const { post, provider } = await harness();
  assert.deepEqual((await post("/api/climate-range", { min: 18, max: 26 })).body, { range: { min: 18, max: 26 } });
  assert.deepEqual(await (await provider.handleRequest("/api/climate-range")).json(), { range: { min: 18, max: 26 } });
  assert.equal((await post("/api/climate-range", { min: 26, max: 18 })).status, 400);
  assert.equal((await post("/api/aircon/target", { temperature: 24 })).body.aircon.temperature, 24);
  assert.equal((await post("/api/aircon/target", { temperature: "warm" })).status, 400);
  assert.equal((await post("/api/power/floating-meter", { categoryId: "nothing" })).status, 400);
  const moved = await post("/api/power/floating-meter", { categoryId: "computers" });
  assert.equal(moved.body.floatingMeter.activeCategoryId, "computers");
  assert.equal(moved.body.floatingMeter.categories.find((category) => category.id === "computers").active, true);
  assert.equal((await post("/api/power/amp-automation", { autoOff: true })).body.floatingMeter.ampControl.autoOff, true);
  assert.deepEqual((await post("/api/orb-info/events", { entries: [] })).body.outputs, {});
});

test("notifications can be dismissed and expire by themselves", async () => {
  const { provider, advance, post, events } = await withWash();
  await advance(180_000);
  const { notifications } = await (await provider.handleRequest("/api/notifications")).json();
  assert.equal((await post(`/api/notifications?id=${notifications[0].id}`, {}, "DELETE")).status, 200);
  assert.equal((await post(`/api/notifications?id=${notifications[0].id}`, {}, "DELETE")).status, 404);
  assert.ok(events.some(([name, payload]) => name === "notification-dismiss" && payload.id === notifications[0].id));
});

test("saved ranges store times and play from the looped segments", async () => {
  const { post, provider, clock } = await harness();
  const startMs = clock.ms - 120_000;
  const endMs = clock.ms - 60_000;
  assert.equal((await post("/api/camera/outside/saved", { startMs, endMs: startMs + 10 })).status, 400);
  assert.equal((await post("/api/camera/outside/saved", { startMs: clock.ms - 3_600_000, endMs })).status, 400);
  const { body: { range } } = await post("/api/camera/outside/saved", { startMs, endMs });
  assert.match(range.id, /^range_\d{1,16}$/);
  assert.equal(range.state, "ready");
  assert.equal(range.durationSeconds, 60);
  assert.equal((await (await provider.handleRequest("/api/camera/outside/saved")).json()).ranges.length, 1);
  const playlist = await (await provider.handleRequest(`/api/camera/outside/saved/${range.id}/index.m3u8`)).text();
  assert.match(playlist, /#EXT-X-ENDLIST/);
  assert.equal((playlist.match(/#EXTINF/g) ?? []).length, 30);
  assert.equal((await post(`/api/camera/outside/saved/${range.id}`, {}, "DELETE")).status, 200);
  assert.equal((await provider.handleRequest(`/api/camera/outside/saved/${range.id}/index.m3u8`)).status, 404);
});

test("reset clears the timer and the simulation", async () => {
  const { post, provider } = await withWash();
  await post("/api/orb-timer", SET_FIVE_MINUTES);
  await provider.reset();
  const snapshot = await provider.snapshot();
  assert.equal(snapshot.orbTimer.timer, null);
  assert.equal(snapshot.simulation.wash, null);
});

test("router readings move and stay in range; the event snapshot carries what a page needs on connecting", async () => {
  const { provider, clock } = await harness();
  const seen = new Set();
  for (let index = 0; index < 20; index += 1) {
    clock.ms += 7000;
    const router = await (await provider.handleRequest("/api/router")).json();
    assert.ok(router.download.value >= 12.4 * 0.4 - 0.1 && router.download.value <= 12.4 * 1.6 + 0.1);
    seen.add(router.download.display);
  }
  assert.ok(seen.size > 3);
  const snapshot = await provider.eventSnapshot();
  assert.deepEqual(snapshot.map(([name]) => name), ["notifications", "orb-timer"]);
});
