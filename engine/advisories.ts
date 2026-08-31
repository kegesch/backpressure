import { compareFindings, MAX_DELIVERIES_PER_SESSION, type AdvisoryFinding } from "./core.ts";

export { MAX_DELIVERIES_PER_SESSION };

export const MAX_PER_SESSION = 50;

export const SCAN_SCOPE_CAP = 20;

const store = new Map<string, Map<string, AdvisoryFinding>>();
const deliveries = new Map<string, number>();
const deliveredKeys = new Map<string, Set<string>>();
const scanScope = new Map<string, string[]>();

function key(f: AdvisoryFinding): string {
  return `${f.checkId}|${f.path}|${f.startLine ?? 0}`;
}

export function collectAdvisories(sessionID: string, findings: AdvisoryFinding[]): number {
  let sessionStore = store.get(sessionID);
  if (!sessionStore) {
    sessionStore = new Map();
    store.set(sessionID, sessionStore);
  }
  const delivered = deliveredKeys.get(sessionID) ?? new Set<string>();
  let stored = 0;
  for (const f of findings) {
    if (sessionStore.size >= MAX_PER_SESSION) break;
    const k = key(f);
    if (!sessionStore.has(k) && !delivered.has(k)) {
      sessionStore.set(k, f);
      stored++;
    }
  }
  return stored;
}

export function getAdvisories(sessionID: string): AdvisoryFinding[] {
  const sessionStore = store.get(sessionID);
  if (!sessionStore) return [];
  return [...sessionStore.values()].sort(compareFindings);
}

export function deliveryCount(sessionID: string): number {
  return deliveries.get(sessionID) ?? 0;
}

export function incrementDelivery(sessionID: string): number {
  const next = deliveryCount(sessionID) + 1;
  deliveries.set(sessionID, next);
  return next;
}

export function markDelivered(sessionID: string, findings: AdvisoryFinding[]): void {
  let keys = deliveredKeys.get(sessionID);
  if (!keys) {
    keys = new Set();
    deliveredKeys.set(sessionID, keys);
  }
  const sessionStore = store.get(sessionID);
  for (const f of findings) {
    const k = key(f);
    keys.add(k);
    if (sessionStore) sessionStore.delete(k);
  }
}

export function noteScanScope(sessionID: string, path: string): void {
  if (!path) return;
  let scope = scanScope.get(sessionID);
  if (!scope) {
    scope = [];
    scanScope.set(sessionID, scope);
  }
  const idx = scope.indexOf(path);
  if (idx >= 0) scope.splice(idx, 1);
  scope.push(path);
  while (scope.length > SCAN_SCOPE_CAP) scope.shift();
}

export function getScanScope(sessionID: string): string[] {
  const scope = scanScope.get(sessionID);
  return scope ? [...scope] : [];
}

export function clearAdvisories(sessionID: string): void {
  store.delete(sessionID);
  deliveries.delete(sessionID);
  deliveredKeys.delete(sessionID);
  scanScope.delete(sessionID);
}

export function clearAllAdvisories(): void {
  store.clear();
  deliveries.clear();
  deliveredKeys.clear();
  scanScope.clear();
}
