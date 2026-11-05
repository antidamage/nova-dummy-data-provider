// The demo's running house: SPEC.md, "Live simulation". Pure rules over the stored
// envelope, the time and a random source. Nothing here starts a timer or touches
// the page; provider.mjs owns the clock and delivers the events returned.

import { stepClimate } from "./simulation-climate.mjs";
import { dismissNotification, raiseNotification } from "./simulation-notifications.mjs";
import { claimOrbTimerSound, completeOrbTimer, dismissOrbTimer, emptyOrbTimer, setOrbTimer } from "./simulation-timer.mjs";
import { claimRunningWash, closeWash, nextWashPerson, setRunningWashNotify, startWash, WASH_MS, washSummary } from "./simulation-wash.mjs";

export {
  WASH_MS,
  claimOrbTimerSound,
  claimRunningWash,
  dismissNotification,
  dismissOrbTimer,
  emptyOrbTimer,
  nextWashPerson,
  setOrbTimer,
  setRunningWashNotify,
  washSummary,
};

export const TICK_MS = 5000;
const MAX_GAP_MS = 60_000;

const AMBIENT_PER_LOAD = 6;
const AMBIENT_QUIET_AFTER_VISITOR_MS = 60_000;
const AMBIENT_KINDS = ["wash", "reminder", "notification"];
const REMINDER_LEAD_MS = 45_000;
const REMINDER_LINGER_MS = 600_000;

const REMINDER_NAMES = ["Put the bins out", "Water the plants", "Bring the washing in", "Feed the sourdough starter"];
const NOTIFICATION_LINES = [
  { title: "Backup finished", body: "Last night's backup completed." },
  { title: "Rain later today", body: "Showers are expected this evening." },
  { title: "Filter reminder", body: "The aircon filter is due for a clean." },
];

const between = (random, low, high) => low + random() * (high - low);
const firstAmbientAt = (nowMs, random) => nowMs + between(random, 60_000, 90_000);

export function newSimulation(nowMs, random = Math.random) {
  return {
    lastTickAt: nowMs,
    nextAmbientAt: firstAmbientAt(nowMs, random),
    nextKind: "wash",
    ambientThisLoad: 0,
    lastVisitorAt: null,
    wash: null,
    closedWashes: [],
    reminderId: null,
    notifications: [],
    counter: 0,
  };
}

/** A page load: its own ambient allowance, and no event already overdue. */
export function resumeSimulation(simulation, nowMs, random = Math.random) {
  simulation.ambientThisLoad = 0;
  simulation.nextAmbientAt = firstAmbientAt(nowMs, random);
  return simulation;
}

function addReminder(envelope, nowMs, events, random) {
  const simulation = envelope.simulation;
  simulation.counter += 1;
  const id = `demo-ambient-${nowMs.toString(36)}-${simulation.counter}`;
  const iso = new Date(nowMs).toISOString();
  envelope.tasks = [...envelope.tasks, {
    id,
    name: REMINDER_NAMES[Math.floor(random() * REMINDER_NAMES.length)],
    start: new Date(nowMs + REMINDER_LEAD_MS).toISOString(),
    createdAt: iso,
    source: "local",
  }];
  simulation.reminderId = id;
  events.push(["tasks", { tasks: envelope.tasks }]);
}

function expireReminder(envelope, nowMs, events) {
  const simulation = envelope.simulation;
  if (!simulation.reminderId) return;
  const task = envelope.tasks.find((row) => row.id === simulation.reminderId);
  if (!task) { simulation.reminderId = null; return; }
  if (task.dismissedAt || task.alertDismissedAt) { simulation.reminderId = null; return; }
  if (nowMs >= Date.parse(task.start) + REMINDER_LINGER_MS) {
    envelope.tasks = envelope.tasks.filter((row) => row.id !== task.id);
    simulation.reminderId = null;
    events.push(["tasks", { tasks: envelope.tasks }]);
  }
}

function runAmbient(envelope, nowMs, random, hidden, events) {
  const simulation = envelope.simulation;
  if (hidden || nowMs < simulation.nextAmbientAt || simulation.ambientThisLoad >= AMBIENT_PER_LOAD) return;
  if (simulation.lastVisitorAt !== null && nowMs < simulation.lastVisitorAt + AMBIENT_QUIET_AFTER_VISITOR_MS) return;
  const start = AMBIENT_KINDS.indexOf(simulation.nextKind);
  for (let offset = 0; offset < AMBIENT_KINDS.length; offset += 1) {
    const kind = AMBIENT_KINDS[(start + offset) % AMBIENT_KINDS.length];
    if (kind === "wash" && simulation.wash) continue;
    if (kind === "reminder" && simulation.reminderId) continue;
    if (kind === "wash") startWash(envelope, nowMs);
    else if (kind === "reminder") addReminder(envelope, nowMs, events, random);
    else raiseNotification(envelope, NOTIFICATION_LINES[Math.floor(random() * NOTIFICATION_LINES.length)], nowMs, events);
    simulation.nextKind = AMBIENT_KINDS[(AMBIENT_KINDS.indexOf(kind) + 1) % AMBIENT_KINDS.length];
    simulation.ambientThisLoad += 1;
    simulation.nextAmbientAt = nowMs + between(random, 180_000, 360_000);
    return;
  }
}

// ---- One tick.

/**
 * Advance the house to `nowMs`. Returns the events to deliver, and whether the
 * entities changed, so the caller knows to publish a fresh state.
 */
export function tick(envelope, nowMs, { defaults, random = Math.random, hidden = false } = {}) {
  const simulation = envelope.simulation;
  const events = [];
  const gap = Math.max(0, Math.min(MAX_GAP_MS, nowMs - simulation.lastTickAt));
  const ticks = gap / TICK_MS;
  simulation.lastTickAt = nowMs;

  if (completeOrbTimer(envelope.orbTimer, nowMs)) events.push(["orb-timer", { timer: envelope.orbTimer.timer }]);
  if (simulation.wash && nowMs >= simulation.wash.endsAtMs) closeWash(envelope, nowMs, events);

  const stateChanged = stepClimate(envelope.state, ticks, nowMs, defaults);

  for (const notification of simulation.notifications) {
    if (Date.parse(notification.expiresAt) <= nowMs) events.push(["notification-dismiss", { id: notification.id }]);
  }
  simulation.notifications = simulation.notifications.filter((row) => Date.parse(row.expiresAt) > nowMs);

  expireReminder(envelope, nowMs, events);
  runAmbient(envelope, nowMs, random, hidden, events);
  return { events, stateChanged };
}
