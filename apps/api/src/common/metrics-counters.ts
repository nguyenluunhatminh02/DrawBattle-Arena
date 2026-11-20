/**
 * Process-local counters shared by guards and the metrics endpoint. Kept as a
 * plain module so CommonModule and AnalyticsModule do not need a circular DI
 * dependency. Values reset on restart and are per API instance.
 */
const counters = new Map<string, number>();

export function recordMetric(name: string, amount = 1): void {
  const key = name.slice(0, 128);
  counters.set(key, (counters.get(key) ?? 0) + amount);
}

export function metricSnapshot(): Record<string, number> {
  return Object.fromEntries(counters);
}
