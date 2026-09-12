const SCHEMA_VERSION = 4;
const DEFAULT_STORAGE_KEY = "nova.demo.provider.v1";
const NZ_TIME_ZONE = "Pacific/Auckland";

const FIXTURES = {
  state: "state.json",
  tasks: "tasks.json",
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

function recomputeState(state, now = new Date()) {
  const timestamp = now.toISOString();
  const entities = state.entities.map((entity) => ({ ...entity, last_reported: timestamp }));
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
    entities,
    generatedAt: timestamp,
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
  } else if (service === "set_swing_mode") {
    attributes.swing_mode = data.swing_mode;
  } else if (service === "set_percentage") {
    attributes.percentage = Math.max(0, Math.min(100, Number(data.percentage)));
    state = attributes.percentage > 0 ? "on" : "off";
  } else if (service === "open_cover" || service === "close_cover" || service === "set_cover_position") {
    attributes.current_position = service === "open_cover" ? 100 : service === "close_cover" ? 0 : Math.max(0, Math.min(100, Number(data.position)));
    state = attributes.current_position > 0 ? "open" : "closed";
  } else if (service === "set_humidity") {
    attributes.humidity = Math.max(30, Math.min(90, Number(data.humidity)));
  } else if (service === "set_mode") {
    attributes.mode = data.mode;
  }
  if (entity.domain === "light" && Number.isFinite(Number(data.brightness_pct))) {
    attributes.brightness = Math.round((Math.max(0, Math.min(100, Number(data.brightness_pct))) / 100) * 255);
    state = attributes.brightness > 0 ? "on" : "off";
  }
  if (entity.domain === "light" && Array.isArray(data.rgb_color)) {
    attributes.rgb_color = data.rgb_color.slice(0, 3).map((part) => Math.max(0, Math.min(255, Math.round(Number(part)))));
    attributes.color_mode = "rgb";
  }
  if (entity.domain === "light" && Number.isFinite(data.color_temp_kelvin)) {
    attributes.color_temp_kelvin = data.color_temp_kelvin;
    attributes.color_mode = "color_temp";
  }
  return { ...entity, state, attributes };
}

function makeEnvelope(defaults, resetKey, now = new Date()) {
  const watchface = withCurrentGymAttendance(defaults.watchface.watchface ?? {}, now);
  const state = recomputeState(clone(defaults.state), now);
  state.preferences = {
    ...(state.preferences ?? {}),
    watchface,
  };

  return {
    schemaVersion: SCHEMA_VERSION,
    sampleAnchorAt: now.toISOString(),
    resetKey,
    state,
    tasks: withCurrentTasks(clone(defaults.tasks.tasks ?? []), now),
    watchface,
    power: clone(defaults.power),
    router: clone(defaults.router),
    novaLoad: clone(defaults.novaLoad),
    system: refreshSampleDates(clone(defaults.system), now),
    version: clone(defaults.version),
  };
}

// Rebase the fictional day's timestamps together, preserving durations and order.
function refreshSampleDates(value, now, anchor = Date.parse("2026-07-27T08:00:00.000Z")) {
  const offset = now.getTime() - anchor;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}(T|$)/.test(value)) {
    const timestamp = Date.parse(value);
    const date = Number.isFinite(timestamp) ? new Date(timestamp + offset).toISOString() : value;
    return value.includes("T") ? date : date.slice(0, 10);
  }
  if (typeof value === "string" && (/^[A-Z][a-z]{2} \d{4}$/.test(value) || /^\d{4}-\d{2}$/.test(value))) {
    const date = new Date(/^\d/.test(value) ? `${value}-01T12:00:00Z` : `01 ${value} 12:00:00 GMT`);
    const source = new Date(anchor);
    date.setUTCMonth(date.getUTCMonth() + (now.getUTCFullYear() - source.getUTCFullYear()) * 12 + now.getUTCMonth() - source.getUTCMonth());
    return /^\d/.test(value) ? date.toISOString().slice(0, 7) : date.toLocaleDateString("en-NZ", { month: "short", year: "numeric", timeZone: "UTC" });
  }
  if (Array.isArray(value)) return value.map((item) => refreshSampleDates(item, now, anchor));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, refreshSampleDates(item, now, anchor)]));
  return value;
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

function importDemoTasks(csv, referenceDate) {
  const created = [], errors = [];
  const date = (text) => /^\d{2}:\d{2}$/.test(text)
    ? new Date(`${referenceDate.slice(0, 10)}T${text}:00`) : new Date(text);
  String(csv ?? "").split(/\r?\n/).forEach((line, index) => {
    if (!line.trim() || line.trim().startsWith("#")) return;
    const [startText, endText, name, repeatText = ""] = line.split(",").map((part) => part.trim());
    const start = date(startText ?? "");
    const end = endText ? date(endText) : null;
    if (end && /^\d{2}:\d{2}$/.test(endText) && end < start) end.setDate(end.getDate() + 1);
    const repeat = repeatText.toLowerCase();
    const days = /^(?:days?[:= ]?|every\s*)?(\d+)$/.exec(repeat);
    let error = !name ? "Expected start,end,name[,repeat]" : !Number.isFinite(start.getTime()) ? "Start time is invalid"
      : end && (!Number.isFinite(end.getTime()) || end <= start) ? "End time must be after start time" : null;
    const parsedRepeat = repeat === "hourly" ? { kind: "hourly" }
      : ["morning/night", "morning-night"].includes(repeat) ? { kind: "morning-night" }
      : days && Number(days[1]) >= 1 && Number(days[1]) <= 365 ? { kind: "days", intervalDays: Number(days[1]) } : null;
    if (repeat && !["none", "no repeat"].includes(repeat) && !parsedRepeat) error = "Repeat must be hourly, morning/night, or days:1 through days:365";
    if (error) errors.push({ line: index + 1, message: error });
    else created.push(taskFromBody({ id: crypto.randomUUID(), name, start: start.toISOString(), end: end?.toISOString(), repeat: parsedRepeat }));
  });
  return { created, errors };
}

async function demoImageAsset(file, now) {
  if (!file || !/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error("Choose a PNG, JPEG, WebP or GIF image");
  if (file.size > 1_000_000) throw new Error("Use an image under 1 MB for this browser-only demo");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const url = `data:${file.type};base64,${btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))}`;
  const bitmap = typeof createImageBitmap === "function" ? await createImageBitmap(file) : null;
  const result = { id: crypto.randomUUID(), name: file.name ?? "Demo image", url, contentType: file.type, size: file.size, width: bitmap?.width ?? 1, height: bitmap?.height ?? 1, hasAlpha: file.type !== "image/jpeg", createdAt: now.toISOString(), updatedAt: now.toISOString() };
  bitmap?.close();
  return result;
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
          const anchor = Date.parse(parsed.sampleAnchorAt);
          if (Number.isFinite(anchor) && now().getTime() - anchor >= 86_400_000) {
            parsed.system = refreshSampleDates(parsed.system, now(), anchor);
            parsed.sampleAnchorAt = now().toISOString();
          }
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
    for (const [key, entityId] of [["aircon", "climate.c6780cad"], ["bedroomHeater", "switch.bedroom_heater"], ["panelHeater", "climate.tuya_mobile_panel_heater"]]) {
      const preference = envelope.state.preferences[key];
      if (preference?.offTimerEndsAt && Date.parse(preference.offTimerEndsAt) <= now().getTime()) {
        preference.offTimerEndsAt = null;
        if (key === "bedroomHeater") preference.mode = "off";
        if (key === "aircon") preference.autoMode = false;
        envelope.state.entities = envelope.state.entities.map((entity) => entity.entity_id === entityId ? updateEntityForService(entity, "turn_off") : entity);
      }
    }
    envelope.state = recomputeState(envelope.state, now());
    save(envelope);
    return jsonResponse(envelope.state);
  }

  async function handleRequest(input, init = {}) {
    const method = String(init.method ?? "GET").toUpperCase();
    const { pathname, searchParams } = normalizePath(input);
    const envelope = await current();

    if (method === "GET" && pathname === "/api/state") return stateResponse(envelope);
    if (pathname === "/api/healthz") return jsonResponse({ ok: true, demo: true });
    if (pathname === "/api/orb-info") {
      if (method === "POST") { envelope.state.preferences.orbInfo = { ...envelope.state.preferences.orbInfo, ...(await bodyJson(init)) }; save(envelope); }
      return jsonResponse({ orbInfo: envelope.state.preferences.orbInfo });
    }
    if (pathname === "/api/auth/whoami") return jsonResponse({ authenticated: true, username: "Demo visitor", email: null, groups: ["demo"], demo: true });
    if (pathname === "/api/modules") return jsonResponse({ modules: [], errors: [] });
    if (pathname === "/api/modules/events" || pathname === "/api/kiosk/text-editing") return jsonResponse({ ok: true, demo: true });
    if (pathname === "/api/reminders/icons") {
      const entries = envelope.system.reminderIcons ?? [];
      if (method === "PATCH") {
        const body = await bodyJson(init);
        const entry = entries.find((row) => row.key === body.key);
        if (Array.isArray(body.keys)) body.keys.forEach((key, order) => { const row = entries.find((item) => item.key === key); if (row) row.order = order; });
        else if (entry) Object.assign(entry, body);
        else return errorResponse("Reminder icon not found", 404);
        save(envelope);
        return jsonResponse({ entries, entry });
      }
      return jsonResponse({ entries });
    }
    if (pathname === "/api/bedroom-heater" && method === "POST") {
      const body = await bodyJson(init);
      const current = envelope.state.preferences.bedroomHeater ?? { mode: "off", temperature: 20 };
      if (body.mode !== undefined && !["auto", "off"].includes(body.mode)) return errorResponse("Unknown heater mode", 400);
      if (body.temperature !== undefined && !Number.isFinite(Number(body.temperature))) return errorResponse("Invalid temperature", 400);
      const bedroomHeater = { ...current, ...body, ...(body.temperature !== undefined ? { temperature: Math.max(5, Math.min(30, Number(body.temperature))) } : {}), updatedAt: now().toISOString() };
      envelope.state.preferences.bedroomHeater = bedroomHeater;
      const temperature = Number(envelope.state.entities.find((entity) => entity.entity_id === "sensor.bedroom_temperature")?.state);
      envelope.state.entities = envelope.state.entities.map((entity) => entity.entity_id === "switch.bedroom_heater" ? { ...entity, state: bedroomHeater.mode === "auto" && temperature < bedroomHeater.temperature ? "on" : "off" } : entity);
      save(envelope);
      return jsonResponse({ bedroomHeater, demo: true });
    }
    if (pathname.startsWith("/api/phonoscope/house-party/zones/") && method === "PUT") {
      const zoneId = decodeURIComponent(pathname.split("/").pop());
      const body = await bodyJson(init);
      const lighting = envelope.state.preferences.lighting;
      lighting.housePartyZones = { ...lighting.housePartyZones, [zoneId]: { enabled: body.enabled === true } };
      save(envelope);
      return jsonResponse({ ok: true, demo: true });
    }
    if (pathname === "/api/phonoscope/house-party/theme") return jsonResponse({ active: false, followVisualizerWhenActive: false, theme: null });
    if (pathname === "/api/phonoscope/house-party/clock") return jsonResponse({ active: false, serverNowMs: now().getTime(), master: null });
    if (pathname === "/api/phonoscope/config") {
      if (method === "POST") { envelope.system.phonoscope.config = { ...envelope.system.phonoscope.config, ...(await bodyJson(init)) }; save(envelope); }
      return jsonResponse(envelope.system.phonoscope);
    }
    if (pathname === "/api/background-texture" || pathname.startsWith("/api/desktop/wallpapers") || pathname === "/api/phonoscope/images") {
      const texture = pathname === "/api/background-texture";
      const phonoscope = pathname === "/api/phonoscope/images";
      const slot = phonoscope ? (init.body?.get?.("slot") ?? searchParams.get("slot") ?? "centre") : "wallpaper";
      const key = texture ? "textures" : phonoscope ? `images-${slot}` : "wallpapers";
      envelope.system[key] ??= [];
      let asset;
      if (method === "POST") {
        try { asset = await demoImageAsset(init.body?.get?.("file"), now()); }
        catch (error) { return errorResponse(error.message, 400); }
        envelope.system[key] = texture ? [asset] : [...envelope.system[key], asset];
        save(envelope);
      }
      if (method === "DELETE") {
        const id = phonoscope ? searchParams.get("id") : decodeURIComponent(pathname.split("/").pop());
        envelope.system[key] = texture ? [] : envelope.system[key].filter((row) => row.id !== id);
        save(envelope);
      }
      if (texture) return jsonResponse({ exists: envelope.system[key].length > 0, ...envelope.system[key][0] });
      return jsonResponse(phonoscope ? (asset ?? { images: envelope.system[key] }) : { asset, assets: envelope.system[key] });
    }
    if (pathname === "/api/phonoscope/diagnostics") return jsonResponse({ demo: true, status: "Configuration preview", message: "Settings are saved in this browser. Live audio analysis and Apple TV playback require a Nova installation." });
    if (pathname === "/api/camera/outside/analysis") {
      if (method === "PUT") { envelope.system.cameraAnalysis = await bodyJson(init); save(envelope); }
      return jsonResponse(envelope.system.cameraAnalysis);
    }
    if (pathname === "/api/camera/outside/analysis/status") return jsonResponse({ ok: true, backlogSeconds: 0, queueDepth: 0, policyConfigured: true, policyVersion: 1, demo: true });
    if (pathname === "/api/camera/outside/analysis/references") {
      if (method === "POST") {
        const form = init.body;
        const file = form?.get?.("image");
        if (!file || !file.type.startsWith("image/")) return errorResponse("Choose an image file", 400);
        if (file.size > 1_000_000) return errorResponse("Use an image under 1 MB for this browser-only demo", 400);
        const bytes = new Uint8Array(await file.arrayBuffer());
        const imageUrl = `data:${file.type};base64,${btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))}`;
        envelope.system.cameraReferences.push({ id: crypto.randomUUID(), kind: form.get("kind"), name: form.get("name"), imageUrl, created_at: now().toISOString(), source_name: form.get("sourceName") });
        save(envelope);
      }
      return jsonResponse({ references: envelope.system.cameraReferences });
    }
    if (pathname.startsWith("/api/camera/outside/analysis/references/") && method === "DELETE") {
      envelope.system.cameraReferences = envelope.system.cameraReferences.filter((row) => row.id !== pathname.split("/").pop());
      save(envelope);
      return jsonResponse({ ok: true });
    }
    if (pathname === "/api/camera/outside/events") {
      if (method === "DELETE") {
        const body = await bodyJson(init);
        const deleted = envelope.system.cameraEvents.filter((event) => body.ids?.includes(event.id)).map((event) => event.id);
        envelope.system.cameraEvents = envelope.system.cameraEvents.filter((event) => !deleted.includes(event.id));
        save(envelope);
        return jsonResponse({ deleted });
      }
      return jsonResponse({ events: envelope.system.cameraEvents.slice(0, Number(searchParams.get("limit") ?? 100)).map((event) => ({ ...event, thumbnailUrl: new URL("assets/outside-demo.png", baseUrl).href })) });
    }
    if (pathname.startsWith("/api/camera/outside/events/")) {
      const id = pathname.split("/").pop();
      const event = envelope.system.cameraEvents.find((row) => row.id === id);
      if (!event) return errorResponse("Event not found", 404);
      if (method === "DELETE") envelope.system.cameraEvents = envelope.system.cameraEvents.filter((row) => row.id !== id);
      else if (method === "PUT") Object.assign(event, await bodyJson(init));
      save(envelope);
      return jsonResponse({ ...event, thumbnailUrl: new URL("assets/outside-demo.png", baseUrl).href });
    }
    if (pathname === "/api/voice/companion-status") return jsonResponse({ voiceHost: { ok: true }, status: envelope.system.companion });
    if (pathname === "/api/face/subjects") return jsonResponse({ subjects: [] });
    if (pathname.startsWith("/api/face/")) return errorResponse("Face enrolment needs a connected Nova installation. This demo does not capture or identify visitors.", 501);
    if (pathname === "/api/config/secrets") {
      if (method !== "GET") return errorResponse("Connection credentials are not used in this demo. No secret was saved and no notification was sent.", 501);
      return jsonResponse({ themeChangeNotificationUrl: { configured: false, preview: null } });
    }
    if (pathname === "/api/kiosk/witness/activity") return jsonResponse({ sessions: envelope.system.kioskSessions ?? [], demo: true });
    if (pathname === "/api/preferences/history") return jsonResponse({ revisions: [], demo: true });
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
    if (pathname === "/api/desktop/computers" && method === "PUT") {
      const body = await bodyJson(init);
      if (!Array.isArray(body.computers)) return errorResponse("Expected a list of computers", 400);
      envelope.system.computers = body.computers;
      save(envelope);
      return jsonResponse({ computers: envelope.system.computers, demo: true });
    }
    if (pathname === "/api/desktop/sync" && method === "POST") {
      return jsonResponse({ ok: true, demo: true, synced: 0, results: envelope.system.computers.filter((computer) => computer.enabled).map((computer) => ({ id: computer.id, name: computer.name, ok: true, demo: true })) });
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
    if (pathname === "/api/voice/administration" && method === "POST") {
      const body = await bodyJson(init);
      const admin = envelope.system.administration;
      if (body.action === "cancel-goal") {
        const goal = admin.goals.find((row) => row.id === body.goalId);
        if (!goal) return errorResponse("Goal not found", 404);
        goal.status = "cancelled";
      } else if (body.action === "revoke-grant") {
        const grant = admin.grants.find((row) => row.id === body.grantId);
        if (!grant) return errorResponse("Grant not found", 404);
        grant.active = false;
      } else if (body.action === "create-grant") {
        admin.grants.push({ ...body.grant, id: crypto.randomUUID(), active: true, target_scope: body.grant?.target_scope ?? [] });
      } else if (body.action === "set-role") {
        admin.identities = admin.identities.filter((row) => row.person_id !== body.personId);
        admin.identities.push({ person_id: body.personId, role: body.role });
      } else return errorResponse("This action requires a running Nova agent; no external action was taken.", 501);
      admin.audit.unshift({ id: crypto.randomUUID(), actor_id: "demo-owner", action: body.action, object_type: "demo", object_id: body.goalId ?? body.grantId ?? body.personId ?? "demo", created_at: now().toISOString() });
      admin.auditTotal = admin.audit.length;
      save(envelope);
      return jsonResponse({ ok: true, demo: true });
    }
    if (pathname === "/api/voice/memories" && method === "POST") {
      const body = await bodyJson(init);
      const memory = envelope.system.memories.find((row) => row.id === body.memoryId);
      if (body.action === "forget") envelope.system.memories = envelope.system.memories.filter((row) => row.id !== body.memoryId);
      else if (body.action === "update" && memory) Object.assign(memory, body.update);
      else if (body.action === "consolidate") envelope.system.memories = envelope.system.memories.filter((row, index, rows) => rows.findIndex((other) => other.text === row.text) === index);
      else if (body.action === "backup") envelope.system.memoryBackup = clone(envelope.system.memories);
      else return errorResponse("Memory action could not be applied", 400);
      save(envelope);
      return jsonResponse({ ok: true, demo: true });
    }
    if (pathname === "/api/voice/automations" && method === "POST") {
      const body = await bodyJson(init);
      const automation = envelope.system.automations.find((row) => row.id === body.automationId);
      if (body.action === "draft") {
        if (envelope.system.automations.some((row) => row.id === body.draft?.id)) return errorResponse("Automation ID already exists", 409);
        envelope.system.automations.push({ ...body.draft, owner_id: body.ownerId, state: "draft", monitor_failures: 0 });
      } else if (body.action === "feedback") {
        const intervention = envelope.system.interventions.find((row) => row.id === body.interventionId);
        if (!intervention) return errorResponse("Intervention not found", 404);
        intervention.feedback = body.outcome;
        intervention.status = "resolved";
      } else if (automation && ["simulate", "approve", "activate", "rollback"].includes(body.action)) {
        automation.state = { simulate: "simulated", approve: "approved", activate: "active", rollback: "rolled_back" }[body.action];
        if (body.action === "simulate") automation.simulation = { matches: 3, errors: [], demo: true };
      } else return errorResponse("Automation action could not be applied", 400);
      save(envelope);
      return jsonResponse({ ok: true, demo: true });
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
      const body = await bodyJson(init);
      const result = importDemoTasks(body.csv, String(body.referenceDate ?? now().toISOString()));
      envelope.tasks.push(...result.created);
      save(envelope);
      return jsonResponse(result);
    }
    if (method === "GET" && pathname === "/api/tasks/audio") return jsonResponse({ exists: false });
    if (method === "GET" && pathname === "/api/tasks/icloud-status") return jsonResponse({ enabled: true, calendars: ["Work"], reminders: ["Home"], lastSyncAt: new Date().toISOString(), errors: [] });
    if (method === "POST" && pathname === "/api/tasks/sync-icloud") return jsonResponse({ result: { added: 0, updated: 0, removed: 0 } });
    const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(complete|uncomplete|dismiss|chimed))?$/);
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
      if (method === "POST" && command === "uncomplete") {
        delete envelope.tasks[index].dismissedAt;
        save(envelope);
        return jsonResponse(envelope.tasks[index]);
      }
      if (method === "POST" && command === "chimed") {
        envelope.tasks[index].lastChimedAt = now().toISOString();
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
    if (method === "GET" && pathname === "/api/power") {
      const defaults = await defaultsPromise;
      const power = refreshSampleDates(clone(defaults.power), now(), Date.parse(defaults.power.generatedAt));
      power.devices = power.devices.map((device) => {
        const entity = envelope.state.entities.find((row) => row.entity_id === device.entityId);
        const initial = defaults.state.entities.find((row) => row.entity_id === device.entityId);
        if (!entity) return device;
        const scale = entity.domain === "light" ? (entity.attributes.brightness ?? 255) / Math.max(1, initial?.attributes?.brightness ?? 255) : 1;
        return { ...device, state: entity.state, watts: entityIsOn(entity) ? Math.round((device.watts || device.ratedWatts) * scale * 10) / 10 : 0 };
      });
      power.currentWatts = Math.round(power.devices.reduce((total, device) => total + device.watts, 0) * 10) / 10;
      return jsonResponse(power);
    }
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
      if (!["on", "off", "brightness", "color", "candlelight", "white"].includes(body.action)) return errorResponse("Unknown lighting action", 400);
      const ids = new Set(targetZone.entities.filter((entity) => entity.domain === "light" || (entity.domain === "switch" && entity.isIllumination)).map((entity) => entity.entity_id));
      const service = body.action === "off" || (body.action === "brightness" && body.brightnessPct === 0) ? "turn_off" : "turn_on";
      const preset = body.action === "white" ? { rgb_color: [255, 244, 229], color_temp_kelvin: 4200, brightness_pct: 100 }
        : ["on", "candlelight"].includes(body.action) ? { rgb_color: [255, 160, 64], color_temp_kelvin: 2700, brightness_pct: 65 } : {};
      envelope.state.entities = envelope.state.entities.map((entity) => ids.has(entity.entity_id)
        ? updateEntityForService(entity, service, { ...preset, ...(body.brightnessPct !== undefined ? { brightness_pct: body.brightnessPct } : {}), ...(body.rgb ? { rgb_color: body.rgb } : {}) }) : entity);
      const lighting = envelope.state.preferences.lighting;
      lighting.adaptiveCandlelightZones = { ...lighting.adaptiveCandlelightZones, [body.zoneId]: { enabled: ["on", "candlelight"].includes(body.action), lastSunState: envelope.state.sun.state } };
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
