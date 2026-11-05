// The household timer in the demo: the rules of the dashboard's lib/orb-timer.ts
// and lib/orb-timer-model.ts. SPEC.md, "Live simulation".

const DISMISS_CLOCK_SKEW_MS = 5000;
const TIMER_SOUND_REPEAT_MS = 30_000;
const TIMER_SOUND_WINDOW_MS = 300_000;
const MAX_TIMER_MS = 8 * 3_600_000;

export function emptyOrbTimer() {
  return { timer: null, soundSlot: -1 };
}

function timerId(simulation, nowMs) {
  simulation.counter += 1;
  return `demo-timer-${nowMs.toString(36)}-${simulation.counter}`;
}

export function completeOrbTimer(store, nowMs) {
  const timer = store.timer;
  if (timer && timer.autoComplete && timer.completedAt === null && timer.dismissedAt === null && nowMs >= timer.endsAt) {
    store.timer = { ...timer, completedAt: timer.endsAt };
    return true;
  }
  return false;
}

export function setOrbTimer(envelope, { durationMs, icon, label, autoComplete = true, washNotify }, nowMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > MAX_TIMER_MS) throw new Error("Timer must be between Off and eight hours");
  envelope.orbTimer = {
    soundSlot: -1,
    timer: durationMs === 0 ? null : {
      id: timerId(envelope.simulation, nowMs),
      icon, label, durationMs, startedAt: nowMs, endsAt: nowMs + durationMs,
      completedAt: null, dismissedAt: null, autoComplete,
      ...(washNotify === undefined ? {} : { washNotify }),
    },
  };
  return envelope.orbTimer.timer;
}

export function dismissOrbTimer(envelope, id, nowMs) {
  const store = envelope.orbTimer;
  if (store.timer?.id === id && store.timer.dismissedAt === null) {
    completeOrbTimer(store, nowMs + DISMISS_CLOCK_SKEW_MS);
    if (store.timer.completedAt !== null) store.timer = { ...store.timer, dismissedAt: nowMs };
  }
  return store.timer;
}

export function claimOrbTimerSound(envelope, id, slot, repeat, nowMs) {
  const store = envelope.orbTimer;
  const timer = store.timer;
  if (timer?.id !== id || timer.completedAt === null || timer.dismissedAt !== null) return false;
  const elapsed = nowMs - timer.completedAt;
  if (elapsed < 0 || elapsed >= TIMER_SOUND_WINDOW_MS) return false;
  const current = Math.floor(elapsed / TIMER_SOUND_REPEAT_MS);
  if (slot !== current || (!repeat && store.soundSlot >= 0) || slot <= store.soundSlot) return false;
  store.soundSlot = slot;
  return true;
}
