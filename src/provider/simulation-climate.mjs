// Rooms moving towards what is running in them. SPEC.md, "Live simulation".

const ROOM_RUNNING_PER_TICK = 0.1;
const ROOM_IDLE_PER_TICK = 0.02;
const ROOM_REST_TEMPERATURE = 18;
const PANEL_HEATER_CAP = 30;

const findEntity = (state, id) => state.entities.find((entity) => entity.entity_id === id);

function moveTowards(value, target, step) {
  if (Math.abs(target - value) <= step) return target;
  return value + Math.sign(target - value) * step;
}

function airconTarget(state, aircon) {
  if (!aircon || ["off", "fan_only", "dry"].includes(aircon.state)) return null;
  const target = Number(state.preferences?.aircon?.temperature ?? aircon.attributes?.temperature);
  return Number.isFinite(target) ? target : null;
}

function nextRoomTemperature(current, target, ticks, onlyUp, onlyDown) {
  if (target === null) return moveTowards(current, ROOM_REST_TEMPERATURE, ROOM_IDLE_PER_TICK * ticks);
  if ((onlyUp && current >= target) || (onlyDown && current <= target)) return current;
  return moveTowards(current, target, ROOM_RUNNING_PER_TICK * ticks);
}

function writeReading(entity, value) {
  const clamped = Math.max(5, Math.min(35, value));
  // The unrounded value travels with the entity, so a step smaller than the
  // displayed 0.1 still accumulates.
  const reading = clamped.toFixed(1);
  const changed = entity.state !== reading;
  entity.state = reading;
  entity.attributes = { ...entity.attributes, simulated_value: clamped };
  return changed;
}

const readingOf = (entity) => Number(entity.attributes?.simulated_value ?? entity.state);

export function stepClimate(state, ticks, nowMs, defaults) {
  if (ticks <= 0) return false;
  let changed = false;

  const lounge = findEntity(state, "sensor.lounge_temperature");
  const aircon = findEntity(state, "climate.demo_aircon");
  if (lounge) {
    const next = nextRoomTemperature(readingOf(lounge), airconTarget(state, aircon), ticks, aircon?.state === "heat", aircon?.state === "cool");
    changed = writeReading(lounge, next) || changed;
    if (aircon) {
      const current = Math.round(Number(lounge.state) * 10) / 10;
      if (aircon.attributes?.current_temperature !== current) {
        aircon.attributes = { ...aircon.attributes, current_temperature: current };
        changed = true;
      }
    }
  }

  const bedroom = findEntity(state, "sensor.bedroom_temperature");
  const heater = findEntity(state, "switch.bedroom_heater");
  const panel = findEntity(state, "climate.demo_panel_heater");
  const preference = state.preferences?.bedroomHeater;
  if (bedroom) {
    const temperature = readingOf(bedroom);
    const target = Number(preference?.temperature);
    if (heater && preference?.mode === "auto" && Number.isFinite(target)) {
      const running = temperature < target ? "on" : "off";
      if (heater.state !== running) { heater.state = running; changed = true; }
    }
    let next;
    if (heater?.state === "on") next = nextRoomTemperature(temperature, Number.isFinite(target) ? target : null, ticks, true, false);
    else if (panel && panel.state !== "off") next = moveTowards(temperature, Math.max(temperature, PANEL_HEATER_CAP), ROOM_RUNNING_PER_TICK * ticks);
    else next = nextRoomTemperature(temperature, null, ticks, false, false);
    changed = writeReading(bedroom, next) || changed;
    const heaterSensor = findEntity(state, "sensor.bedroom_heater_temperature");
    if (heaterSensor) changed = writeReading(heaterSensor, Number(bedroom.state)) || changed;
  }

  for (const entity of state.entities) {
    if (!entity.entity_id.endsWith("_humidity")) continue;
    const base = Number(defaults?.state?.entities?.find((row) => row.entity_id === entity.entity_id)?.state);
    if (!Number.isFinite(base)) continue;
    const reading = String(Math.round(base + 3 * Math.sin(nowMs / 97_000)));
    if (entity.state !== reading) { entity.state = reading; changed = true; }
  }
  return changed;
}
