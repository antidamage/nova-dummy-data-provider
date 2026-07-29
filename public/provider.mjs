const SCHEMA_VERSION = 3;
const DEFAULT_STORAGE_KEY = "nova.demo.provider.v1";
const NZ_TIME_ZONE = "Pacific/Auckland";

const FIXTURES = {
  state: "state.json",
  tasks: "tasks.json",
  reminderIcons: "reminder-icons.json",
  watchface: "watchface.json",
  power: "power.json",
  router: "router.json",
  novaLoad: "nova-load.json",
  system: "system.json",
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

function environmentFor(entities) {
  const temperature = entities.find((entity) => entity.attributes?.device_class === "temperature");
  const humidity = entities.find((entity) => entity.attributes?.device_class === "humidity");
  if (!temperature && !humidity) return undefined;
  return {
    temperatureEntityId: temperature?.entity_id ?? null,
    humidityEntityId: humidity?.entity_id ?? null,
  };
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
    ...(environmentFor(entities) ? { environment: environmentFor(entities) } : {}),
  };
}

function recomputeState(state) {
  const entities = state.entities;
  const byArea = (area) => entities.filter((entity) => entity.area_id === area);
  const areaNames = {
    bedroom: "Bedroom",
    conservatory: "Conservatory",
    kitchen: "Kitchen",
    lounge: "Lounge",
    office: "Office",
  };
  const climateEntities = entities.filter(
    (entity) => ["climate", "heating"].includes(entity.area_id) || entity.entity_id.includes("aircon"),
  );
  const homeEntities = entities.filter(
    (entity) => !["climate", "heating", "network", "outside"].includes(entity.area_id),
  );
  const indoorAreas = Object.keys(areaNames).filter((area) => byArea(area).length > 0);
  const zones = [
    zone("everything", "Home", homeEntities),
    ...indoorAreas.map((area) => zone(area, areaNames[area], byArea(area))),
    ...(climateEntities.length ? [zone("climate", "Climate", climateEntities)] : []),
    ...(byArea("outside").length ? [zone("outside", "Outside", byArea("outside"))] : []),
    zone("network", "Network", []),
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

function withCurrentTasks(tasks, now = new Date()) {
  const offsets = [-5, 120, 210, 300, 24 * 60 + 30, 48 * 60];
  return (tasks ?? []).map((task, index) => {
    const start = new Date(now.getTime() + (offsets[index] ?? (index + 1) * 60) * 60_000);
    const originalDuration = task.end
      ? Math.max(5 * 60_000, new Date(task.end).getTime() - new Date(task.start).getTime())
      : null;
    return {
      ...task,
      start: start.toISOString(),
      ...(originalDuration ? { end: new Date(start.getTime() + originalDuration).toISOString() } : {}),
      createdAt: now.toISOString(),
    };
  });
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
    tasks: withCurrentTasks(clone(defaults.tasks.tasks ?? []), now),
    reminderIcons: clone(defaults.reminderIcons.entries ?? []),
    watchface,
    power: clone(defaults.power),
    router: clone(defaults.router),
    novaLoad: clone(defaults.novaLoad),
    system: clone(defaults.system),
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

  function refreshTasksIfStale(envelope) {
    const latestStart = Math.max(
      ...envelope.tasks.map((task) => new Date(task.start).getTime()).filter(Number.isFinite),
      0,
    );
    if (latestStart >= now().getTime() - 24 * 60 * 60_000) return;
    envelope.tasks = withCurrentTasks(envelope.tasks, now()).map((task) => {
      const next = { ...task };
      delete next.dismissedAt;
      delete next.alertDismissedAt;
      delete next.alertDismissedFor;
      return next;
    });
    save(envelope);
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
    if (pathname === "/api/agent") {
      if (method === "GET") return jsonResponse({ agent: envelope.system.agent });
      if (method === "POST") {
        envelope.system.agent = { ...envelope.system.agent, ...(await bodyJson(init)) };
        save(envelope);
        return jsonResponse({ agent: envelope.system.agent, demo: true });
      }
    }
    if (pathname === "/api/layout") {
      if (method === "GET") return jsonResponse({ layout: envelope.system.layout });
      if (method === "POST") {
        const body = await bodyJson(init);
        envelope.system.layout = {
          ...envelope.system.layout,
          ...body,
          swipe: { ...(envelope.system.layout?.swipe ?? {}), ...(body.swipe ?? body) },
        };
        save(envelope);
        return jsonResponse({ layout: envelope.system.layout, demo: true });
      }
    }
    if (pathname === "/api/update" && method === "GET") {
      return jsonResponse(envelope.system.update);
    }
    if (pathname === "/api/update/settings" && method === "POST") {
      const body = await bodyJson(init);
      envelope.system.update = {
        ...envelope.system.update,
        ...(typeof body.autoUpdate === "boolean" ? { autoUpdate: body.autoUpdate } : {}),
      };
      save(envelope);
      return jsonResponse(envelope.system.update);
    }
    if (pathname.startsWith("/api/update/") && method === "POST") {
      return jsonResponse({
        ...envelope.system.update,
        demo: true,
        phaseMessage: "Updates are disabled in the static demo.",
      });
    }
    if (pathname === "/api/camera/outside/settings") {
      if (method === "GET") return jsonResponse(envelope.system.camera);
      if (method === "PUT" || method === "POST") {
        envelope.system.camera = { ...envelope.system.camera, ...(await bodyJson(init)) };
        save(envelope);
        return jsonResponse({ ...envelope.system.camera, demo: true });
      }
    }
    if (pathname === "/api/desktop/computers" && method === "GET") {
      return jsonResponse({ computers: envelope.system.computers });
    }
    if (pathname === "/api/desktop/sync" && method === "POST") {
      return jsonResponse({ ok: true, demo: true, synced: 0 });
    }
    if (pathname === "/api/events" && method === "POST") {
      return jsonResponse({ ok: true, demo: true });
    }
    if (pathname === "/api/orb-modules" && method === "GET") {
      return jsonResponse({ modules: [], errors: [] });
    }
    if (pathname === "/api/voice-personality-library") {
      if (method === "GET") {
        return jsonResponse({ library: envelope.system.personalityLibrary, updatedAt: null });
      }
      if (method === "POST") {
        const body = await bodyJson(init);
        envelope.system.personalityLibrary = clone(body.library ?? body);
        save(envelope);
        return jsonResponse({ library: envelope.system.personalityLibrary, updatedAt: new Date().toISOString() });
      }
    }
    if (pathname === "/api/voice") {
      if (method === "GET") {
        return jsonResponse({ agent: envelope.system.agent, voice: envelope.system.voice });
      }
      if (method === "POST") {
        envelope.system.voice = { ...envelope.system.voice, ...(await bodyJson(init)) };
        save(envelope);
        return jsonResponse({ agent: envelope.system.agent, voice: envelope.system.voice, demo: true });
      }
    }
    if (pathname === "/api/voice/options" && method === "GET") {
      const active = envelope.system.activeEngine;
      return jsonResponse({
        ...envelope.system.voiceOptions,
        voices: (envelope.system.engineVoices[active] ?? []).map((voice) => ({
          value: voice.id,
          label: voice.name,
          detail: `${active} voices${voice.language ? ` · ${voice.language}` : ""}`,
        })),
        current: envelope.system.voice,
        engine: active,
        engines: envelope.system.engines,
        engineVoices: envelope.system.engineVoices[active] ?? [],
      });
    }
    if (pathname === "/api/voice/engine") {
      if (method === "POST") {
        const body = await bodyJson(init);
        if (envelope.system.engines.some((engine) => engine.id === body.engine)) {
          envelope.system.activeEngine = body.engine;
          save(envelope);
        }
        return jsonResponse({ changed: false, engine: envelope.system.activeEngine, demo: true });
      }
      if (method === "GET") {
        return jsonResponse({
          reachable: true,
          engine: envelope.system.activeEngine,
          engines: envelope.system.engines,
          switch: { target: envelope.system.activeEngine, phase: "ready", updatedAt: new Date().toISOString() },
          tts: {
            ok: true,
            ready: true,
            engine: envelope.system.activeEngine,
            speaker: envelope.system.voice.trainedSpeaker,
            language: envelope.system.voice.language,
            streaming: true,
            sampleRate: 32000,
            voices: (envelope.system.engineVoices[envelope.system.activeEngine] ?? []).map((voice) => voice.id),
          },
        });
      }
    }
    if (pathname === "/api/voice/satellites") {
      if (method === "GET") return jsonResponse(envelope.system.satellites);
      if (method === "POST") {
        const body = await bodyJson(init);
        const satellite = envelope.system.satellites.satellites.find((row) => row.id === body.id);
        if (!satellite) return errorResponse("Satellite not found", 404);
        if (typeof body.voiceEnabled === "boolean") satellite.voiceEnabled = body.voiceEnabled;
        if (typeof body.roomId === "string") {
          satellite.configuredRoomId = body.roomId;
          satellite.status = { ...satellite.status, roomId: body.roomId };
        }
        save(envelope);
        return jsonResponse({ ok: true, demo: true, pushed: false, pushError: "Static demo only" });
      }
    }
    if (pathname === "/api/voice/satellites/reconnect" && method === "POST") {
      return jsonResponse({ ok: true, demo: true });
    }
    const voiceCatalogueMatch = pathname.match(/^\/api\/voice\/voices\/([^/]+)(?:\/([^/]+))?$/);
    if (voiceCatalogueMatch && method === "GET") {
      const engine = decodeURIComponent(voiceCatalogueMatch[1]);
      return jsonResponse({ voices: envelope.system.engineVoices[engine] ?? [] });
    }
    if (pathname === "/api/voice/speaker-profiles" && method === "GET") {
      return jsonResponse(envelope.system.speakerProfiles);
    }
    if (pathname === "/api/voice/administration" && method === "GET") {
      return jsonResponse(envelope.system.administration);
    }
    if (pathname === "/api/voice/memories" && method === "GET") {
      return jsonResponse({ memories: envelope.system.memories });
    }
    if (pathname === "/api/voice/automations" && method === "GET") {
      return jsonResponse({
        automations: envelope.system.automations,
        interventions: envelope.system.interventions,
      });
    }
    if (pathname === "/api/voice/training" && method === "GET") {
      return jsonResponse(envelope.system.training);
    }
    if (pathname === "/api/voice/transcript") {
      if (method === "GET") return jsonResponse({ transcripts: envelope.system.transcripts });
      if (method === "DELETE") {
        envelope.system.transcripts = [];
        save(envelope);
        return jsonResponse({ ok: true, demo: true, clearedAt: new Date().toISOString() });
      }
    }
    if (pathname === "/api/voice/preview" && method === "POST") {
      return errorResponse("Voice playback is not available in the static demo.", 501);
    }
    if (pathname.startsWith("/api/voice/") && method !== "GET") {
      return errorResponse("This voice action is not available in the static demo.", 501);
    }
    if (method === "GET" && pathname === "/api/tasks") {
      refreshTasksIfStale(envelope);
      return jsonResponse({ tasks: envelope.tasks });
    }
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
    // Sigil roster for the reminder icon bar. Keyed on the normalised reminder
    // name, matching lib/reminder-icons.ts.
    if (method === "GET" && pathname === "/api/reminders/icons") {
      return jsonResponse({ entries: envelope.reminderIcons });
    }
    if (method === "PATCH" && pathname === "/api/reminders/icons") {
      const body = await bodyJson(init);
      if (Array.isArray(body.keys)) {
        const position = new Map(body.keys.map((key, index) => [key, index]));
        envelope.reminderIcons = envelope.reminderIcons
          .map((entry) => (position.has(entry.key) ? { ...entry, order: position.get(entry.key) } : entry))
          .sort((left, right) => left.order - right.order);
        save(envelope);
        return jsonResponse({ entries: envelope.reminderIcons });
      }
      const index = envelope.reminderIcons.findIndex((entry) => entry.key === body.key);
      if (index < 0) return errorResponse("Reminder not found", 404);
      const next = { ...envelope.reminderIcons[index] };
      if (body.glyph !== undefined) {
        next.glyph = body.glyph;
        next.source = "user";
      }
      if (body.showInBar !== undefined) {
        next.showInBar = Boolean(body.showInBar);
        next.showInBarLocked = true;
      }
      envelope.reminderIcons[index] = next;
      save(envelope);
      return jsonResponse({ entry: next });
    }
    if (method === "DELETE" && pathname === "/api/reminders/icons") {
      const key = searchParams.get("key");
      envelope.reminderIcons = envelope.reminderIcons.filter((entry) => entry.key !== key);
      save(envelope);
      return jsonResponse({ entries: envelope.reminderIcons });
    }
    const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(complete|dismiss|uncomplete))?$/);
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
      // The real store replays a pre-completion snapshot (a repeating reminder
      // also rolls forward on completion). The demo never rolls tasks forward,
      // so clearing the completion is the faithful equivalent here.
      if (method === "POST" && command === "uncomplete") {
        const restored = { ...envelope.tasks[index] };
        delete restored.dismissedAt;
        delete restored.alertDismissedAt;
        delete restored.alertDismissedFor;
        envelope.tasks[index] = restored;
        save(envelope);
        return jsonResponse(restored);
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
    if (method === "POST" && (pathname === "/api/desktop/sleep" || pathname === "/api/desktop/wake")) {
      return jsonResponse({ ok: true, demo: true });
    }
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
