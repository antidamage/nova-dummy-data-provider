import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import path from "node:path";
import { createNovaDummyProvider, __test } from "../src/provider/provider.mjs";

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
      switch: 8,
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
  assert.equal(voice.voice.agentName, "[◯_◯]");
  const options = await (await provider.handleRequest("/api/voice/options")).json();
  assert.equal(options.engine, "trained");
  assert.equal(options.engines.length, 3);
  const satellites = await (await provider.handleRequest("/api/voice/satellites")).json();
  assert.equal(satellites.satellites.length, 2);
  const profiles = await (await provider.handleRequest("/api/voice/speaker-profiles")).json();
  assert.equal(profiles.profiles[0].displayName, "Household Owner");
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

  assert.equal(power.currentWatts, 844.3);
  assert.equal(power.devices.length, 8);
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
  const provider = createNovaDummyProvider({ fixtures: await fixtures(), storage: storage() });
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
