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
    configClient: await fixture("config-client.json"),
    tasks: await fixture("tasks.json"),
    theme: await fixture("theme.json"),
    watchface: await fixture("watchface.json"),
    power: await fixture("power.json"),
    router: await fixture("router.json"),
    novaLoad: await fixture("nova-load.json"),
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

test("reads and saves editable theme for the same NZ day", async () => {
  const provider = createNovaDummyProvider({
    fixtures: await fixtures(),
    now: () => new Date("2026-06-03T12:00:00.000Z"),
    storage: storage(),
  });

  const write = await provider.handleRequest("/api/theme", {
    method: "POST",
    body: JSON.stringify({ theme: { accent: { cursor: { x: 0.1, y: 0.2 }, intensity: 77, rgb: [1, 2, 3] } } }),
  });
  assert.equal(write.status, 200);

  const read = await provider.handleRequest("/api/theme");
  const body = await read.json();
  assert.deepEqual(body.theme.accent.rgb, [1, 2, 3]);
});

test("resets stale persisted state on the next NZ day", async () => {
  const sharedStorage = storage();
  const first = createNovaDummyProvider({
    fixtures: await fixtures(),
    now: () => new Date("2026-06-03T12:00:00.000Z"),
    storage: sharedStorage,
  });
  await first.handleRequest("/api/theme", {
    method: "POST",
    body: JSON.stringify({ theme: { accent: { cursor: { x: 0.1, y: 0.2 }, intensity: 77, rgb: [1, 2, 3] } } }),
  });

  const second = createNovaDummyProvider({
    fixtures: await fixtures(),
    now: () => new Date("2026-06-04T12:00:00.000Z"),
    storage: sharedStorage,
  });
  const body = await (await second.handleRequest("/api/theme")).json();
  assert.notDeepEqual(body.theme.accent.rgb, [1, 2, 3]);
});

test("zone and entity writes update the dashboard state", async () => {
  const provider = createNovaDummyProvider({ fixtures: await fixtures(), storage: storage() });

  const zoneWrite = await provider.handleRequest("/api/zone", {
    method: "POST",
    body: JSON.stringify({ zoneId: "bedroom", action: "on", brightnessPct: 50 }),
  });
  assert.equal(zoneWrite.status, 200);
  let state = await zoneWrite.json();
  assert.equal(state.entities.find((entity) => entity.entity_id === "light.bedroom_lamp").state, "on");

  const entityWrite = await provider.handleRequest("/api/entity", {
    method: "POST",
    body: JSON.stringify({
      entityId: "climate.lounge_aircon",
      domain: "climate",
      service: "set_temperature",
      data: { temperature: 19 },
    }),
  });
  state = await entityWrite.json();
  assert.equal(state.entities.find((entity) => entity.entity_id === "climate.lounge_aircon").attributes.temperature, 19);
});

test("does not generate a duplicate power sub-zone", async () => {
  const provider = createNovaDummyProvider({ fixtures: await fixtures(), storage: storage() });
  const state = await (await provider.handleRequest("/api/state")).json();
  const zoneNames = state.zones.map((zone) => zone.name);

  assert.ok(zoneNames.includes("Network"));
  assert.ok(!state.zones.some((zone) => zone.id === "power" || zone.name === "Power"));
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
