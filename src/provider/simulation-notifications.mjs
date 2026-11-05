// The demo's one-off notifications. SPEC.md, "Live simulation".

const NOTIFICATION_LIFE_MS = 120_000;

export function raiseNotification(envelope, line, nowMs, events) {
  const simulation = envelope.simulation;
  simulation.counter += 1;
  const notification = {
    id: `demo-notification-${nowMs.toString(36)}-${simulation.counter}`,
    title: line.title,
    ...(line.body ? { body: line.body } : {}),
    severity: "info",
    source: "Nova",
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + NOTIFICATION_LIFE_MS).toISOString(),
  };
  simulation.notifications.push(notification);
  events.push(["notification", notification]);
}

export function dismissNotification(envelope, id) {
  const simulation = envelope.simulation;
  const before = simulation.notifications.length;
  simulation.notifications = simulation.notifications.filter((row) => row.id !== id);
  return simulation.notifications.length !== before;
}
