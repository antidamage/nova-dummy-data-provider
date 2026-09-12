import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import path from "node:path";
import { createNovaDummyProvider, __test } from "../src/provider/provider.mjs";

test("lighting presets leave climate, sensors and appliances untouched and zero really turns lights off", async () => {
  const provider = createNovaDummyProvider({ fixtures: await fixtures(), storage: storage() });
  const before = await provider.snapshot();
  const unrelated = (state) => state.entities.filter((entity) => entity.domain !== "light" && !entity.isIllumination)
    .map(({ last_reported, ...entity }) => entity);
  const request = (body) => provider.handleRequest("/api/zone", { method: "POST", body: JSON.stringify(body) });
  await request({ zoneId: "everything", action: "white" });
  assert.deepEqual(unrelated((await provider.snapshot()).state), unrelated(before.state));
  await request({ zoneId: "lounge", action: "brightness", brightnessPct: 0 });
  assert.ok((await provider.snapshot()).state.zones.find((zone) => zone.id === "lounge").entities.filter((entity) => entity.domain === "light").every((entity) => entity.state === "off"));
  await request({ zoneId: "lounge", action: "candlelight" });
  assert.deepEqual((await provider.snapshot()).state.entities.find((entity) => entity.entity_id === "light.lounge_light").attributes.rgb_color, [255, 160, 64]);
});

test("heater, reminder undo, House Party and memories survive a provider reload", async () => {
  const shared = storage();
  const data = await fixtures();
  const provider = createNovaDummyProvider({ fixtures: data, storage: shared });
  const write = async (path, body, method = "POST") => {
    const response = await provider.handleRequest(path, { method, body: JSON.stringify(body) });
    assert.equal(response.status, 200, path);
    return response.json();
  };
  await write("/api/bedroom-heater", { mode: "auto", temperature: 21 });
  await write("/api/tasks/demo-water-plants/complete", {});
  await write("/api/tasks/demo-water-plants/uncomplete", {});
  await write("/api/phonoscope/house-party/zones/lounge", { enabled: true }, "PUT");
  await write("/api/voice/memories", { action: "update", memoryId: "demo-memory-candlelight", update: { pinned: false } });
  const reloaded = await createNovaDummyProvider({ fixtures: data, storage: shared }).snapshot();
  assert.equal(reloaded.state.preferences.bedroomHeater.temperature, 21);
  assert.equal(reloaded.state.entities.find((entity) => entity.entity_id === "switch.bedroom_heater").state, "on");
  assert.equal(reloaded.tasks.find((task) => task.id === "demo-water-plants").dismissedAt, undefined);
  assert.equal(reloaded.state.preferences.lighting.housePartyZones.lounge.enabled, true);
  assert.equal(reloaded.system.memories.find((memory) => memory.id === "demo-memory-candlelight").pinned, false);
});

test("the demo starts with recent, resolved conversation turns and working discovery routes", async () => {
  const clock = new Date("2027-02-12T08:00:00Z");
  const provider = createNovaDummyProvider({ fixtures: await fixtures(), storage: storage(), now: () => clock });
  for (const path of ["/api/healthz", "/api/auth/whoami", "/api/reminders/icons", "/api/orb-info", "/api/phonoscope/config", "/api/phonoscope/house-party/theme", "/api/phonoscope/house-party/clock"]) {
    assert.equal((await provider.handleRequest(path)).status, 200, path);
  }
  const { transcripts } = await (await provider.handleRequest("/api/voice/transcript")).json();
  assert.ok(transcripts.length >= 12);
  assert.ok(transcripts.every((turn) => turn.outcome && Date.parse(turn.at) < clock.getTime() && clock.getTime() - Date.parse(turn.at) < 3_600_000));
  assert.ok(transcripts.some((turn) => turn.text.includes("browser-only controls")));
});

async function fixture(name) {
  return JSON.parse(await readFile(path.join(process.cwd(), "src", "fixtures", name), "utf8"));
}

async function fixtures() {
  return {
    state: await fixture("state.json"),
    tasks: await fixture("tasks.json"),
    watchface: await fixture("watchface.json"),
    power: await fixture("power.json"),
    router: await fixture("router.json"),
    novaLoad: await fixture("nova-load.json"),
    system: await fixture("system.json"),
    version: await fixture("version.json"),
  };
}

function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value)),
  };
}

test("computes reset keys in Pacific/Auckland", () => {
  assert.equal(__test.nzResetKey(new Date("2026-06-03T12:00:00.000Z")), "2026-06-04");
});

test("does not serve config or theme (Nova owns those in the demo)", async () => {
  const provider = createNovaDummyProvider({ fixtures: await fixtures(), storage: storage() });

  assert.equal((await provider.handleRequest("/api/theme")).status, 404);
  assert.equal((await provider.handleRequest("/api/config")).status, 404);
  assert.equal((await provider.handleRequest("/api/config/client")).status, 404);
});

test("persists a visitor's demo state across NZ days (no daily reset)", async () => {
  const sharedStorage = storage();
  const first = createNovaDummyProvider({
    fixtures: await fixtures(),
    now: () => new Date("2026-06-03T12:00:00.000Z"),
    storage: sharedStorage,
  });
  await first.handleRequest("/api/zone", {
    method: "POST",
    body: JSON.stringify({ zoneId: "bedroom", action: "on", brightnessPct: 50 }),
  });

  const second = createNovaDummyProvider({
    fixtures: await fixtures(),
    now: () => new Date("2026-06-04T12:00:00.000Z"),
    storage: sharedStorage,
  });
  const state = await (await second.handleRequest("/api/state")).json();
  assert.equal(state.entities.find((entity) => entity.entity_id === "light.bedroom_light").state, "on");
});

test("zone and entity writes update the dashboard state", async () => {
  const provider = createNovaDummyProvider({ fixtures: await fixtures(), storage: storage() });

  const zoneWrite = await provider.handleRequest("/api/zone", {
    method: "POST",
    body: JSON.stringify({ zoneId: "bedroom", action: "on", brightnessPct: 50 }),
  });
  assert.equal(zoneWrite.status, 200);
  let state = await zoneWrite.json();
  assert.equal(state.entities.find((entity) => entity.entity_id === "light.bedroom_light").state, "on");

  const entityWrite = await provider.handleRequest("/api/entity", {
    method: "POST",
    body: JSON.stringify({
      entityId: "climate.c6780cad",
      domain: "climate",
      service: "set_temperature",
      data: { temperature: 19 },
    }),
  });
  state = await entityWrite.json();
  assert.equal(state.entities.find((entity) => entity.entity_id === "climate.c6780cad").attributes.temperature, 19);
});

test("uses Home for the aggregate and does not generate duplicate special zones", async () => {
  const provider = createNovaDummyProvider({ fixtures: await fixtures(), storage: storage() });
  const state = await (await provider.handleRequest("/api/state")).json();
  const zoneNames = state.zones.map((zone) => zone.name);

  assert.equal(state.zones[0].id, "everything");
  assert.equal(state.zones[0].name, "Home");
  assert.ok(zoneNames.includes("Office"));
  assert.ok(zoneNames.includes("Network"));
  assert.ok(!state.zones.some((zone) => zone.id === "power" || zone.name === "Power"));
  assert.ok(!state.zones.some((zone) => zone.id === "tasks" || zone.name === "Tasks"));
});

test("covers every dashboard entity domain with rich fixture data", async () => {
  const provider = createNovaDummyProvider({ fixtures: await fixtures(), storage: storage() });
  const state = await (await provider.handleRequest("/api/state")).json();

  assert.deepEqual(
    Object.fromEntries(Object.entries(state.totals).filter(([, count]) => count > 0)),
    {
      light: 16,
      switch: 9,
      climate: 2,
      fan: 1,
      cover: 1,
      humidifier: 1,
      sensor: 5,
    },
  );
  assert.equal(state.zones.find((zone) => zone.id === "lounge").environment.temperatureEntityId,
    "sensor.tuya_mobile_lounge_sensor_temperature");
});

test("serves simulated voice, agent, computer, camera, layout, and update surfaces", async () => {
  const provider = createNovaDummyProvider({ fixtures: await fixtures(), storage: storage() });

  const voice = await (await provider.handleRequest("/api/voice")).json();
  assert.equal(voice.voice.agentName, "Johnny Silverhand");
  const options = await (await provider.handleRequest("/api/voice/options")).json();
  assert.equal(options.engine, "trained");
  assert.equal(options.engines.length, 3);
  const satellites = await (await provider.handleRequest("/api/voice/satellites")).json();
  assert.equal(satellites.satellites.length, 2);
  const profiles = await (await provider.handleRequest("/api/voice/speaker-profiles")).json();
  assert.equal(profiles.profiles[0].displayName, "Alex (demo household)");
  const training = await (await provider.handleRequest("/api/voice/training")).json();
  assert.equal(training.sets[0].state.status, "ready");
  const transcript = await (await provider.handleRequest("/api/voice/transcript")).json();
  assert.ok(transcript.transcripts.every((entry) => entry.id && entry.at && entry.role && entry.text));
  const computers = await (await provider.handleRequest("/api/desktop/computers")).json();
  assert.equal(computers.computers.length, 3);
  assert.equal((await provider.handleRequest("/api/camera/outside/settings")).status, 200);
  assert.equal((await provider.handleRequest("/api/layout")).status, 200);
  assert.equal((await provider.handleRequest("/api/update")).status, 200);
});

test("returns a current complete power dashboard", async () => {
  const provider = createNovaDummyProvider({ fixtures: await fixtures(), storage: storage() });
  const power = await (await provider.handleRequest("/api/power")).json();

  assert.equal(power.currentWatts, 859.3);
  assert.equal(power.devices.length, 9);
  assert.equal(power.accountUsageGraph.length, 12);
  assert.equal(power.backgroundEstimateGraph.length, 12);
});

test("uses a low default Nova load", async () => {
  const originalDateNow = Date.now;
  Date.now = () => 0;

  try {
    const provider = createNovaDummyProvider({ fixtures: await fixtures(), storage: storage() });
    const body = await (await provider.handleRequest("/api/nova-load")).json();

    assert.equal(body.load, 0.15);
    assert.equal(body.cpu, 0.15);
    assert.equal(body.net, 0.078);
    assert.equal(body.gpu, 0.108);
  } finally {
    Date.now = originalDateNow;
  }
});

test("panel heater timer persists in dashboard preferences", async () => {
  const provider = createNovaDummyProvider({ fixtures: await fixtures(), storage: storage(), now: () => new Date("2026-06-04T09:00:00.000Z") });
  const offTimerEndsAt = "2026-06-04T09:30:00.000Z";

  const write = await provider.handleRequest("/api/panel-heater/timer", {
    method: "POST",
    body: JSON.stringify({ offTimerEndsAt }),
  });
  assert.equal(write.status, 200);
  assert.equal((await write.json()).panelHeater.offTimerEndsAt, offTimerEndsAt);

  const state = await (await provider.handleRequest("/api/state")).json();
  assert.equal(state.preferences.panelHeater.offTimerEndsAt, offTimerEndsAt);
});

test("camera review and zone edits persist, and the visualiser references an installed module", async () => {
  const provider = createNovaDummyProvider({ fixtures: await fixtures(), storage: storage(), baseUrl: "https://example.test/demo/" });
  const json = async (path, body, method = "GET") => {
    const response = await provider.handleRequest(path, { method, body: body ? JSON.stringify(body) : undefined });
    assert.equal(response.status, 200, path);
    return response.json();
  };
  const events = await json("/api/camera/outside/events");
  assert.equal(events.events[0].thumbnailUrl, "https://example.test/demo/assets/outside-demo.png");
  await json(`/api/camera/outside/events/${events.events[0].id}`, { reviewed: true, starred: true }, "PUT");
  assert.equal((await json("/api/camera/outside/events")).events[0].starred, true);
  const analysis = await json("/api/camera/outside/analysis");
  analysis.zones[0].points[0] = [0.2, 0.4];
  await json("/api/camera/outside/analysis", analysis, "PUT");
  assert.deepEqual((await json("/api/camera/outside/analysis")).zones[0].points[0], [0.2, 0.4]);
  const { config, modules } = await json("/api/phonoscope/config");
  assert.ok(modules.some((module) => module.id === config.activeModuleId && module.version === config.activeModuleVersion));
  assert.ok(modules.length >= 7);
});

test("CSV imports report invalid lines, image upload returns the shape the image picker expects", async () => {
  const provider = createNovaDummyProvider({ fixtures: await fixtures(), storage: storage() });
  const result = await (await provider.handleRequest("/api/tasks/bulk", { method: "POST", body: JSON.stringify({ referenceDate: "2026-09-12", csv: "09:00,,Water plants,days:2\nbroken\n23:00,01:00,Movie night" }) })).json();
  assert.equal(result.created.length, 2);
  assert.equal(result.errors[0].line, 2);
  assert.ok(Date.parse(result.created[1].end) > Date.parse(result.created[1].start));
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), "demo.png");
  form.set("slot", "centre");
  const image = await (await provider.handleRequest("/api/phonoscope/images", { method: "POST", body: form })).json();
  assert.ok(image.id);
  assert.ok(image.url.startsWith("data:image/png;base64,"));
  const library = await (await provider.handleRequest("/api/phonoscope/images?slot=centre")).json();
  assert.equal(library.images[0].id, image.id);
});

test("power reacts to controls, timers expire, and reports have fresh dates", async () => {
  let clock = new Date("2027-02-12T08:00:00Z");
  const provider = createNovaDummyProvider({ fixtures: await fixtures(), storage: storage(), now: () => clock });
  const baseline = await (await provider.handleRequest("/api/power")).json();
  assert.equal(baseline.generatedAt, clock.toISOString());
  const write = (path, body) => provider.handleRequest(path, { method: "POST", body: JSON.stringify(body) });
  await write("/api/bedroom-heater", { mode: "auto", temperature: 21, offTimerEndsAt: "2027-02-12T08:01:00Z" });
  assert.equal((await (await provider.handleRequest("/api/power")).json()).currentWatts, baseline.currentWatts + 2000);
  clock = new Date("2027-02-12T08:02:00Z");
  const state = await (await provider.handleRequest("/api/state")).json();
  assert.equal(state.preferences.bedroomHeater.mode, "off");
  assert.equal(state.entities.find((entity) => entity.entity_id === "sensor.bedroom_temperature").last_reported, clock.toISOString());
});

test("uses the current time for demo gym attendance", async () => {
  const now = new Date("2026-06-06T01:23:45.000Z");
  const provider = createNovaDummyProvider({
    fixtures: await fixtures(),
    now: () => now,
    storage: storage(),
  });

  const watchface = await (await provider.handleRequest("/api/watchface")).json();
  assert.equal(watchface.watchface.gymLastResetAt, now.toISOString());
  assert.equal(watchface.watchface.daysSinceGym, 0);

  const state = await (await provider.handleRequest("/api/state")).json();
  assert.equal(state.preferences.watchface.gymLastResetAt, now.toISOString());
  assert.equal(state.preferences.watchface.daysSinceGym, 0);
});
