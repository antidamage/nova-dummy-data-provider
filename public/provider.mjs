const SCHEMA_VERSION = 1;
const DEFAULT_STORAGE_KEY = "nova.demo.provider.v1";
const NZ_TIME_ZONE = "Pacific/Auckland";

const FIXTURES = {
  state: "state.json",
  tasks: "tasks.json",
  watchface: "watchface.json",
  power: "power.json",
  router: "router.json",
  novaLoad: "nova-load.json",
  version: "version.json",
};

function clone(value) {
  return structuredClone ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "X-Nova-Demo": "true",
    },
  });
}

function errorResponse(message, status = 404) {
  return jsonResponse({ error: message }, status);
}

function normalizePath(input) {
  const url = new URL(input, "https://demo.local");
  return { pathname: url.pathname.replace(/\/+$/, "") || "/", searchParams: url.searchParams };
}

function nzResetKey(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: NZ_TIME_ZONE,
    year: "numeric",
  }).formatToParts(now);
  const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${byType.year}-${byType.month}-${byType.day}`;
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value)),
  };
}

function browserStorage() {
  if (typeof window === "undefined") {
    return memoryStorage();
  }
  try {
    return window.localStorage;
  } catch {
    return memoryStorage();
  }
}

async function fetchJson(baseUrl, fileName) {
  const url = new URL(`api/${fileName}`, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const response = await fetch(url.href, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to load ${fileName}: ${response.status}`);
  }
  return response.json();
}

async function loadDefaultFixtures(baseUrl, supplied) {
  if (supplied) {
    return clone(supplied);
  }

  const entries = await Promise.all(
    Object.entries(FIXTURES).map(async ([key, fileName]) => [key, await fetchJson(baseUrl, fileName)]),
  );
  return Object.fromEntries(entries);
}

function zoneBrightnessPct(entities) {
  const values = entities
    .filter((entity) => entity.domain === "light" && entity.state === "on")
    .map((entity) => Number(entity.attributes?.brightness ?? 0))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (!values.length) return 0;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length / 255) * 100);
}

function entityIsOn(entity) {
  if (["unknown", "unavailable"].includes(entity.state)) return false;
  if (entity.domain === "climate") return entity.state !== "off";
  if (entity.domain === "sensor") return false;
  return ["on", "open", "opening", "heat", "cool", "fan_only"].includes(entity.state);
}

function countsFor(entities) {
  const domains = ["light", "switch", "climate", "fan", "cover", "humidifier", "sensor"];
  return Object.fromEntries(domains.map((domain) => [domain, entities.filter((entity) => entity.domain === domain).length]));
}

function zone(id, name, entities, special) {
  return {
    id,
    name,
    entities,
    counts: countsFor(entities),
    isOn: entities.some(entityIsOn),
    brightnessPct: zoneBrightnessPct(entities),
    ...(special ? { special } : {}),
  };
}

function recomputeState(state) {
  const entities = state.entities;
  const byArea = (area) => entities.filter((entity) => entity.area_id === area);
  const visible = entities.filter((entity) => !["sensor"].includes(entity.domain));
  const zones = [
    zone("everything", "Everything", visible),
    zone("lounge", "Lounge", byArea("lounge")),
    zone("bedroom", "Bedroom", byArea("bedroom")),
    zone("office", "Office", byArea("office")),
    zone("kitchen", "Kitchen", byArea("kitchen")),
    zone("climate", "Climate", entities.filter((entity) => ["climate", "heating"].includes(entity.area_id) || entity.entity_id.includes("aircon"))),
    zone("network", "Network", [], "power"),
    zone("tasks", "Tasks", [], "tasks"),
  ];
  return {
    ...state,
    generatedAt: new Date().toISOString(),
    zones,
    totals: countsFor(entities),
    router: state.router,
  };
}

function mergePreferences(current, next) {
  const merged = { ...current, ...next };
  if (next?.aircon) {
    merged.aircon = { ...(current.aircon ?? {}), ...next.aircon, updatedAt: new Date().toISOString() };
  }
  if (next?.panelHeater) {
    merged.panelHeater = { ...(current.panelHeater ?? {}), ...next.panelHeater, updatedAt: new Date().toISOString() };
  }
  if (next?.watchface) {
    merged.watchface = { ...(current.watchface ?? {}), ...next.watchface, updatedAt: new Date().toISOString() };
  }
  return merged;
}

function withCurrentGymAttendance(watchface, now = new Date()) {
  const timestamp = now.toISOString();
  return {
    ...(watchface ?? {}),
    gymLastResetAt: timestamp,
    daysSinceGym: 0,
    updatedAt: timestamp,
  };
}

function updateEntityForService(entity, service, data = {}) {
  let state = entity.state;
  let attributes = { ...(entity.attributes ?? {}) };
  if (service === "turn_on") {
    state = entity.domain === "climate" ? (entity.state === "off" ? "cool" : entity.state) : "on";
  } else if (service === "turn_off") {
    state = "off";
    if (entity.domain === "light") attributes.brightness = 0;
  } else if (service === "toggle") {
    state = entityIsOn(entity) ? "off" : "on";
  } else if (service === "set_hvac_mode" && typeof data.hvac_mode === "string") {
    state = data.hvac_mode;
  } else if (service === "set_temperature" && Number.isFinite(Number(data.temperature))) {
    attributes.temperature = Number(data.temperature);
  } else if (service === "set_fan_mode" && typeof data.fan_mode === "string") {
    attributes.fan_mode = data.fan_mode;
  }
  if (entity.domain === "light" && Number.isFinite(Number(data.brightness_pct))) {
    attributes.brightness = Math.round((Math.max(0, Math.min(100, Number(data.brightness_pct))) / 100) * 255);
    if (attributes.brightness > 0) state = "on";
  }
  if (entity.domain === "light" && Array.isArray(data.rgb_color)) {
    attributes.rgb_color = data.rgb_color.slice(0, 3).map((part) => Math.max(0, Math.min(255, Math.round(Number(part)))));
  }
  return { ...entity, state, attributes };
}

function makeEnvelope(defaults, resetKey, now = new Date()) {
  const watchface = withCurrentGymAttendance(defaults.watchface.watchface ?? {}, now);
  const state = recomputeState(clone(defaults.state));
  state.preferences = {
    ...(state.preferences ?? {}),
    watchface,
  };

  return {
    schemaVersion: SCHEMA_VERSION,
    resetKey,
    state,
    tasks: clone(defaults.tasks.tasks ?? []),
    watchface,
    power: clone(defaults.power),
    router: clone(defaults.router),
    novaLoad: clone(defaults.novaLoad),
    version: clone(defaults.version),
  };
}

async function bodyJson(init) {
  if (!init?.body) return {};
  if (typeof init.body === "string") return JSON.parse(init.body || "{}");
  return init.body;
}

function taskFromBody(body) {
  const now = new Date().toISOString();
  return {
    id: body.id ? String(body.id) : `demo-task-${Date.now().toString(36)}`,
    name: String(body.name ?? "Untitled task"),
    start: String(body.start ?? now),
    ...(body.end ? { end: String(body.end) } : {}),
    createdAt: body.createdAt ? String(body.createdAt) : now,
    ...(body.repeat ? { repeat: body.repeat } : {}),
    source: "local",
  };
}

export function createNovaDummyProvider(options = {}) {
  const storage = options.storage ?? browserStorage();
  const storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY;
  const baseUrl = options.baseUrl ?? (typeof document === "undefined" ? "http://127.0.0.1:4174/" : new URL("./", document.currentScript?.src ?? window.location.href).href);
  let defaultsPromise = loadDefaultFixtures(baseUrl, options.fixtures);
  let envelopePromise = null;
  const listeners = new Set();
  const now = () => options.now?.() ?? new Date();

  function syncCurrentGymAttendance(envelope) {
    envelope.watchface = withCurrentGymAttendance(envelope.watchface, now());
    envelope.state.preferences = {
      ...(envelope.state.preferences ?? {}),
      watchface: envelope.watchface,
    };
    return envelope;
  }

  async function loadEnvelope() {
    const defaults = await defaultsPromise;
    const raw = storage.getItem(storageKey);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        // Persist a visitor's demo state indefinitely; only rebuild when the
        // stored shape predates the current schema. (No daily reset.)
        if (parsed.schemaVersion === SCHEMA_VERSION) {
          return syncCurrentGymAttendance(parsed);
        }
      } catch {
        // discard malformed demo state
      }
    }
    const next = makeEnvelope(defaults, nzResetKey(now()), now());
    storage.setItem(storageKey, JSON.stringify(next));
    return next;
  }

  async function current() {
    envelopePromise ??= loadEnvelope();
    return envelopePromise;
  }

  function save(envelope) {
    storage.setItem(storageKey, JSON.stringify(envelope));
    for (const listener of listeners) listener(envelope);
  }

  async function stateResponse(envelope) {
    syncCurrentGymAttendance(envelope);
    envelope.state = recomputeState(envelope.state);
    save(envelope);
    return jsonResponse(envelope.state);
  }

  async function handleRequest(input, init = {}) {
    const method = String(init.method ?? "GET").toUpperCase();
    const { pathname, searchParams } = normalizePath(input);
    const envelope = await current();

    if (method === "GET" && pathname === "/api/state") return stateResponse(envelope);
    // Config and theme defaults are served by the Nova demo bootstrap from the
    // browser's local storage; the dummy provider only emulates Home Assistant.
    if (method === "GET" && pathname === "/api/tasks") return jsonResponse({ tasks: envelope.tasks });
    if (method === "POST" && pathname === "/api/tasks" && (searchParams.get("command") === "add" || !searchParams.has("command"))) {
      const task = taskFromBody(await bodyJson(init));
      envelope.tasks = [...envelope.tasks, task];
      save(envelope);
      return jsonResponse(task);
    }
    if (method === "POST" && pathname === "/api/tasks/bulk") {
      return jsonResponse({ created: [], errors: [{ line: 1, message: "Bulk import is disabled in the static demo." }] });
    }
    if (method === "GET" && pathname === "/api/tasks/audio") return jsonResponse({ exists: false });
    if (method === "GET" && pathname === "/api/tasks/icloud-status") return jsonResponse({ enabled: true, calendars: ["Work"], reminders: ["Home"], lastSyncAt: new Date().toISOString(), errors: [] });
    if (method === "POST" && pathname === "/api/tasks/sync-icloud") return jsonResponse({ result: { added: 0, updated: 0, removed: 0 } });
    const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(complete|dismiss))?$/);
    if (taskMatch) {
      const id = decodeURIComponent(taskMatch[1]);
      const command = taskMatch[2];
      const index = envelope.tasks.findIndex((task) => task.id === id);
      if (index < 0) return errorResponse("Task not found", 404);
      if (method === "DELETE" && !command) {
        envelope.tasks = envelope.tasks.filter((task) => task.id !== id);
        save(envelope);
        return jsonResponse({ ok: true });
      }
      if (method === "PATCH" && !command) {
        envelope.tasks[index] = { ...envelope.tasks[index], ...(await bodyJson(init)) };
        save(envelope);
        return jsonResponse(envelope.tasks[index]);
      }
      if (method === "POST" && command === "dismiss") {
        envelope.tasks[index] = { ...envelope.tasks[index], alertDismissedAt: new Date().toISOString(), alertDismissedFor: `${envelope.tasks[index].start}:reminder` };
        save(envelope);
        return jsonResponse(envelope.tasks[index]);
      }
      if (method === "POST" && command === "complete") {
        envelope.tasks[index] = { ...envelope.tasks[index], dismissedAt: new Date().toISOString() };
        save(envelope);
        return jsonResponse(envelope.tasks[index]);
      }
    }
    if (method === "GET" && pathname === "/api/watchface") {
      syncCurrentGymAttendance(envelope);
      save(envelope);
      return jsonResponse({ watchface: envelope.watchface });
    }
    if (method === "POST" && pathname === "/api/watchface") {
      envelope.watchface = { ...envelope.watchface, ...(await bodyJson(init)), updatedAt: new Date().toISOString() };
      envelope.state.preferences = mergePreferences(envelope.state.preferences, { watchface: envelope.watchface });
      save(envelope);
      return jsonResponse({ watchface: envelope.watchface });
    }
    if (method === "GET" && pathname === "/api/power") return jsonResponse(envelope.power);
    if (method === "GET" && pathname === "/api/router") return jsonResponse(envelope.router);
    if (method === "GET" && pathname === "/api/nova-load") {
      const t = Date.now() / 1000;
      const load = Math.max(0.08, Math.min(0.28, 0.15 + Math.sin(t / 3) * 0.03));
      return jsonResponse({ ...envelope.novaLoad, cpu: load, net: load * 0.52, gpu: load * 0.72, load });
    }
    if (method === "GET" && pathname === "/api/version") return jsonResponse(envelope.version);
    if (method === "POST" && pathname === "/api/zone") {
      const body = await bodyJson(init);
      const targetZone = envelope.state.zones.find((zone) => zone.id === body.zoneId);
      if (!targetZone) return errorResponse(`Unknown zone: ${body.zoneId}`, 400);
      const ids = new Set(targetZone.entities.map((entity) => entity.entity_id));
      const service = body.action === "off" ? "turn_off" : "turn_on";
      envelope.state.entities = envelope.state.entities.map((entity) => ids.has(entity.entity_id) ? updateEntityForService(entity, service, { brightness_pct: body.brightnessPct ?? 80, rgb_color: body.rgb }) : entity);
      return stateResponse(envelope);
    }
    if (method === "POST" && pathname === "/api/entity") {
      const body = await bodyJson(init);
      envelope.state.entities = envelope.state.entities.map((entity) => entity.entity_id === body.entityId ? updateEntityForService(entity, body.service, body.data) : entity);
      if (body.remember) envelope.state.preferences = mergePreferences(envelope.state.preferences, body.remember);
      return stateResponse(envelope);
    }
    if (method === "POST" && pathname === "/api/aircon/timer") {
      const body = await bodyJson(init);
      envelope.state.preferences = mergePreferences(envelope.state.preferences, { aircon: { offTimerEndsAt: body.offTimerEndsAt ?? null } });
      save(envelope);
      return jsonResponse({ aircon: envelope.state.preferences.aircon ?? {} });
    }
    if (method === "POST" && pathname === "/api/panel-heater/timer") {
      const body = await bodyJson(init);
      envelope.state.preferences = mergePreferences(envelope.state.preferences, { panelHeater: { offTimerEndsAt: body.offTimerEndsAt ?? null } });
      save(envelope);
      return jsonResponse({ panelHeater: envelope.state.preferences.panelHeater ?? {} });
    }
    if (method === "POST" && pathname === "/api/desktop/sleep") return jsonResponse({ ok: true, demo: true });
    if (method === "GET" && (pathname.startsWith("/api/radar/") || pathname.startsWith("/api/satellite/"))) {
      return new Response(new Uint8Array(), { status: 204, headers: { "X-Nova-Demo": "true" } });
    }
    return errorResponse(`Unsupported demo route: ${method} ${pathname}`, 404);
  }

  return {
    handleRequest,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async reset() {
      const defaults = await defaultsPromise;
      const next = makeEnvelope(defaults, nzResetKey(now()), now());
      envelopePromise = Promise.resolve(next);
      save(next);
      return clone(next);
    },
    async snapshot() {
      return clone(await current());
    },
  };
}

export const __test = { nzResetKey, recomputeState, withCurrentGymAttendance };
