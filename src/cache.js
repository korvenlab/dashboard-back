/**
 * Cache TTL em memória (por instância Render). Reduz chamadas a wag-backend e 2A-back.
 * TTL configurável via env; reinício do serviço limpa o cache.
 */

function parsePositiveInt(raw, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.round(n);
}

export const DASHBOARD_CACHE_TTL_MS = Math.max(
  30_000,
  parsePositiveInt(process.env.DASHBOARD_CACHE_TTL_MS, 180_000),
);

export const UPTIMEROBOT_CACHE_TTL_MS = Math.max(
  60_000,
  parsePositiveInt(process.env.UPTIMEROBOT_CACHE_TTL_MS, 600_000),
);

/** @template T */
export function createTtlCache(ttlMs, maxEntries = 48) {
  /** @type {Map<string, { value: T, expiresAt: number }>} */
  const store = new Map();

  return {
    get(key) {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (Date.now() > entry.expiresAt) {
        store.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value) {
      if (store.size >= maxEntries) {
        const oldest = store.keys().next().value;
        if (oldest !== undefined) store.delete(oldest);
      }
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
    },
    ttlMs,
  };
}

export function dashboardFiltrosKey(filtros) {
  return JSON.stringify({
    period_days: filtros.period_days,
    chart_days: filtros.chart_days,
    organization_id: filtros.organization_id ?? "",
  });
}
