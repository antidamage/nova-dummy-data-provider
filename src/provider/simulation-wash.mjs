// A running wash, compressed to minutes. SPEC.md, "Live simulation".

import { raiseNotification } from "./simulation-notifications.mjs";
import { emptyOrbTimer, setOrbTimer } from "./simulation-timer.mjs";

export const WASH_MS = 180_000;
// A real wash is about an hour; the history records it at that scale.
const WASH_RECORDED_MS = 3_600_000;
const WASH_KWH = 0.33;
const WASH_COST_NZD = 0.1;
const WASH_CURVE = [90, 380, 420, 240, 210, 260, 220, 340, 380, 200, 90, 0];
const CLOSED_WASHES_KEPT = 20;

function washFraction(wash, nowMs) {
  return Math.max(0, Math.min(1, (nowMs - wash.startedAtMs) / WASH_MS));
}

function washWatts(fraction) {
  const position = fraction * (WASH_CURVE.length - 1);
  const low = Math.floor(position);
  const high = Math.min(WASH_CURVE.length - 1, low + 1);
  return Math.round(WASH_CURVE[low] + (WASH_CURVE[high] - WASH_CURVE[low]) * (position - low));
}

function washCurve(fraction) {
  const points = Math.max(2, Math.round(48 * fraction));
  return Array.from({ length: points }, (_, index) => washWatts((index / (points - 1)) * fraction));
}

const money = (value) => Math.round(value * 100) / 100;

export function startWash(envelope, nowMs) {
  const simulation = envelope.simulation;
  simulation.counter += 1;
  simulation.wash = {
    id: `demo-wash-${nowMs.toString(36)}-${simulation.counter}`,
    startedAtMs: nowMs,
    endsAtMs: nowMs + WASH_MS,
    person: null,
    attribution: null,
    timerId: null,
    notify: false,
  };
}

/** Everything the dashboard reads about the wash under way. */
export function washSummary(envelope, nowMs) {
  const wash = envelope.simulation?.wash;
  if (!wash) return { open: null, running: undefined, watts: null };
  const fraction = washFraction(wash, nowMs);
  const kwh = Math.round(WASH_KWH * fraction * 1000) / 1000;
  const costNzd = money(WASH_COST_NZD * fraction);
  const watts = washWatts(fraction);
  return {
    watts,
    running: { id: wash.id, person: wash.person, kwh, curve: washCurve(fraction), ...(wash.attribution ? { attribution: wash.attribution } : {}) },
    open: {
      aboveSince: null, belowSince: null, costNzd, kwh,
      lastSampleAt: new Date(nowMs).toISOString(),
      lastWatts: watts,
      person: wash.person,
      startedAt: new Date(wash.startedAtMs).toISOString(),
      ...(wash.attribution ? { attribution: wash.attribution } : {}),
      ...(wash.timerId ? { timer: {
        startedAt: new Date(wash.startedAtMs).toISOString(),
        endsAt: new Date(wash.endsAtMs).toISOString(),
        extensions: 0, completedAt: null, orbTimerId: wash.timerId, notify: wash.notify,
      } } : {}),
    },
  };
}

export function closeWash(envelope, nowMs, events) {
  const simulation = envelope.simulation;
  const wash = simulation.wash;
  const endedAt = wash.endsAtMs;
  simulation.closedWashes = [{
    id: wash.id,
    person: wash.person,
    startedAt: new Date(endedAt - WASH_RECORDED_MS).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    kwh: WASH_KWH,
    costNzd: WASH_COST_NZD,
    curve: washCurve(1),
    completion: { at: new Date(endedAt).toISOString(), person: wash.person, discord: false },
    attribution: wash.attribution ?? { at: new Date(endedAt).toISOString(), source: "auto" },
  }, ...simulation.closedWashes].slice(0, CLOSED_WASHES_KEPT);
  simulation.wash = null;
  const store = envelope.orbTimer;
  if (wash.timerId && store.timer?.id === wash.timerId && store.timer.completedAt === null && store.timer.dismissedAt === null) {
    store.timer = { ...store.timer, completedAt: endedAt };
    events.push(["orb-timer", { timer: store.timer }]);
  }
  raiseNotification(envelope, { title: "Wash finished", body: wash.person ? `Claimed by ${personLabel(envelope, wash.person)}.` : "Nobody has claimed it yet." }, nowMs, events);
}

function personLabel(envelope, id) {
  return envelope.power?.washingMachine?.people?.find((person) => person.id === id)?.label ?? id;
}

/** Who a wash belongs to next: unassigned, each person in order, unassigned. */
export function nextWashPerson(people, current) {
  const ids = people.map((person) => person.id);
  const index = ids.indexOf(current);
  return index < 0 ? (ids[0] ?? null) : (ids[index + 1] ?? null);
}

/** Set the person on the wash under way, starting or cancelling its timer. */
export function claimRunningWash(envelope, person, nowMs) {
  const wash = envelope.simulation.wash;
  wash.person = person;
  wash.attribution = { at: new Date(nowMs).toISOString(), source: "manual" };
  const primary = envelope.power?.washingMachine?.primaryPersonId;
  const store = envelope.orbTimer;
  if (person && person === primary) {
    const timer = setOrbTimer(envelope, {
      durationMs: Math.max(1000, wash.endsAtMs - nowMs),
      icon: "washing-machine", label: "Wash", autoComplete: false, washNotify: true,
    }, nowMs);
    wash.timerId = timer.id;
    wash.notify = true;
  } else {
    if (wash.timerId && store.timer?.id === wash.timerId) envelope.orbTimer = emptyOrbTimer();
    wash.timerId = null;
    wash.notify = false;
  }
  return envelope.orbTimer.timer;
}

export function setRunningWashNotify(envelope, notify) {
  const wash = envelope.simulation.wash;
  if (!wash) return false;
  wash.notify = notify;
  const store = envelope.orbTimer;
  if (wash.timerId && store.timer?.id === wash.timerId) store.timer = { ...store.timer, washNotify: notify };
  return true;
}
