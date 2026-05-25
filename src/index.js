import cors from "cors";
import express from "express";
import {
  createTtlCache,
  dashboardFiltrosKey,
  DASHBOARD_CACHE_TTL_MS,
  UPTIMEROBOT_CACHE_TTL_MS,
} from "./cache.js";

const app = express();

const mergedDashboardCache = createTtlCache(DASHBOARD_CACHE_TTL_MS, 32);
const wagooUpstreamCache = createTtlCache(DASHBOARD_CACHE_TTL_MS, 32);
const avendasUpstreamCache = createTtlCache(DASHBOARD_CACHE_TTL_MS, 32);
const uptimeRobotCache = createTtlCache(UPTIMEROBOT_CACHE_TTL_MS, 4);
app.use(cors());
app.use(express.json());

function toInt(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function toIntInRange(v, d, min, max) {
  const n = toInt(v, d);
  return Math.max(min, Math.min(max, Math.round(n)));
}

function firstObject(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

const UPTIMEROBOT_URL = "https://api.uptimerobot.com/v2/getMonitors";

function mapUptimeMonitorStatus(statusCode) {
  const code = Number(statusCode);
  if (code === 2) return "Online";
  if (code === 9) return "Offline";
  if (code === 0) return "Paused";
  return "Unknown";
}

async function pullDashboard(label, baseUrl, apiKey, filtros, opts = {}) {
  if (!baseUrl || !apiKey) {
    return { ok: false, warn: `${label}: env ausente` };
  }
  const path = opts.path ?? "/dashboard";
  const url = new URL(`${String(baseUrl).replace(/\/+$/, "")}${path}`);
  const queryMap = opts.queryMap ?? {
    period_days: "period_days",
    chart_days: "chart_days",
    organization_id: "organization_id",
  };
  url.searchParams.set(queryMap.period_days, String(filtros.period_days));
  url.searchParams.set(queryMap.chart_days, String(filtros.chart_days));
  if (filtros.organization_id) url.searchParams.set(queryMap.organization_id, filtros.organization_id);

  try {
    const headers = {
      Accept: "application/json",
      ...(opts.authMode === "admin"
        ? {
            Authorization: `Bearer ${apiKey}`,
            "x-admin-secret": apiKey,
          }
        : {
            Authorization: `Bearer ${apiKey}`,
            "X-API-Key": apiKey,
          }),
    };
    const res = await fetch(url.toString(), {
      headers,
    });
    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    const text = await res.text();
    if (!contentType.includes("application/json")) {
      const hint = `esperado JSON, veio ${contentType || "sem content-type"}`;
      const preview = text.replace(/\s+/g, " ").slice(0, 80);
      return {
        ok: false,
        warn: `${label}: ${hint}. Verifique API_BASE_URL/path. Preview: ${preview}`,
      };
    }
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      return { ok: false, warn: `${label}: JSON inválido (${text.slice(0, 80)})` };
    }
    if (!res.ok) return { ok: false, warn: `${label}: HTTP ${res.status}` };
    return { ok: true, json };
  } catch (e) {
    return { ok: false, warn: `${label}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Reutiliza resposta upstream em cache (só sucesso HTTP). */
async function pullDashboardCached(cache, cacheLabel, label, baseUrl, apiKey, filtros, opts = {}) {
  const key = `${cacheLabel}:${dashboardFiltrosKey(filtros)}`;
  const hit = cache.get(key);
  if (hit) return { ...hit, fromCache: true };

  const result = await pullDashboard(label, baseUrl, apiKey, filtros, opts);
  if (result.ok) cache.set(key, result);
  return { ...result, fromCache: false };
}

/**
 * Série de receita do produto Wagoo (repo wag-backend).
 * Prefere o payload do wag-backend (chave JSON `wagoo`); se vazio, usa o bloco equivalente
 * devolvido pela API 2AVendas — repo 2A-back (produto 2AVendas, não “A2”; chaves `waggo` ou `wagoo`).
 */
function mergeWagooReceitaBlock(wagBackendPayload, twoAvendasPayload) {
  const fromWagooApi = firstObject(firstObject(wagBackendPayload).wagoo);
  const avRoot = firstObject(twoAvendasPayload);
  const from2AvendasAlias = firstObject(avRoot.waggo);
  const from2AvendasCanonical = firstObject(avRoot.wagoo);
  const from2Avendas =
    Array.isArray(from2AvendasAlias.receita_por_dia) && from2AvendasAlias.receita_por_dia.length
      ? from2AvendasAlias
      : from2AvendasCanonical;
  const wLen = Array.isArray(fromWagooApi.receita_por_dia) ? fromWagooApi.receita_por_dia.length : 0;
  const aLen = Array.isArray(from2Avendas.receita_por_dia) ? from2Avendas.receita_por_dia.length : 0;
  if (wLen > 0) return fromWagooApi;
  if (aLen > 0) return from2Avendas;
  return { ...from2Avendas, ...fromWagooApi };
}

/** wagBackendJson = Wagoo (wag-backend). twoAvendasJson = 2AVendas (2A-back). */
function mergeDashboards(wagBackendJson, twoAvendasJson, filtros, warnings) {
  const wagoo = firstObject(wagBackendJson);
  const avendas = firstObject(twoAvendasJson);
  const wagooBlock = mergeWagooReceitaBlock(wagBackendJson, twoAvendasJson);
  const avendasBlock =
    firstObject(avendas.dois_avendas).volume_por_dia || firstObject(avendas.dois_avendas).kpis
      ? firstObject(avendas.dois_avendas)
      : firstObject(avendas["2avendas"]);

  const kpis = {
    ...firstObject(wagoo.kpis),
    ...firstObject(avendas.kpis),
  };

  const eventos = [
    ...(Array.isArray(wagoo.eventos_recentes) ? wagoo.eventos_recentes : []),
    ...(Array.isArray(avendas.eventos_recentes) ? avendas.eventos_recentes : []),
  ];

  const ui = {
    ...firstObject(wagoo.ui),
    ...firstObject(avendas.ui),
  };

  return {
    ok: true,
    gerado_em: avendas.gerado_em ?? wagoo.gerado_em ?? new Date().toISOString(),
    filtros,
    kpis,
    wagoo: wagooBlock,
    dois_avendas: avendasBlock,
    eventos_recentes: eventos,
    ui,
    warnings,
  };
}

function withCacheMeta(payload, meta) {
  return {
    ...payload,
    cache: meta,
  };
}

const healthPayload = () => ({
  ok: true,
  service: "korven-dashboard-backend",
  timestamp: new Date().toISOString(),
});

/** Mesma chave que protege `GET /dashboard` (Bearer ou X-API-Key). */
function authorizeDashboardGateway(req, res) {
  const authHeader = req.header("authorization");
  const bearer =
    typeof authHeader === "string" && authHeader.toLowerCase().startsWith("bearer ")
      ? authHeader.slice(7).trim()
      : undefined;
  const incomingKey = (req.header("x-api-key") ?? bearer ?? "").trim();
  const gatewayKey = (process.env.DASHBOARD_BACKEND_API_KEY ?? "").trim();
  if (gatewayKey && incomingKey !== gatewayKey) {
    res.status(401).json({ ok: false, message: "unauthorized" });
    return false;
  }
  return true;
}

app.get("/health", (_req, res) => {
  res.json(healthPayload());
});

app.get("/dashboard", async (req, res) => {
  const filtros = {
    organization_id: typeof req.query.organization_id === "string" ? req.query.organization_id : undefined,
    period_days: toIntInRange(req.query.period_days, 30, 1, 366),
    chart_days: toIntInRange(req.query.chart_days, 14, 1, 90),
  };

  if (!authorizeDashboardGateway(req, res)) return;

  const forceRefresh =
    req.query.refresh === "1" || String(req.header("x-korven-refresh") ?? "").trim() === "1";
  const cacheKey = dashboardFiltrosKey(filtros);

  if (!forceRefresh) {
    const cachedMerged = mergedDashboardCache.get(cacheKey);
    if (cachedMerged) {
      res.setHeader("X-Korven-Cache", "HIT");
      return res.json(
        withCacheMeta(cachedMerged, {
          hit: true,
          ttl_seconds: Math.round(mergedDashboardCache.ttlMs / 1000),
        }),
      );
    }
  }

  const [wagooPull, avendasPull] = await Promise.all([
    pullDashboardCached(
      wagooUpstreamCache,
      "wagoo",
      "Wagoo",
      process.env.WAGOO_API_BASE_URL,
      process.env.WAGOO_METRICS_API_KEY,
      filtros,
      {
        path: process.env.WAGOO_DASHBOARD_PATH || "/api/admin/dashboard",
        queryMap: {
          period_days: "periodDays",
          chart_days: "chartDays",
          organization_id: "organization_id",
        },
        authMode: "admin",
      },
    ),
    pullDashboardCached(
      avendasUpstreamCache,
      "2avendas",
      "2AVendas",
      process.env.TWO_AVENDAS_API_BASE_URL,
      process.env.TWO_AVENDAS_METRICS_API_KEY,
      filtros,
      {
        path: process.env.TWO_AVENDAS_DASHBOARD_PATH || "/dashboard",
      },
    ),
  ]);

  const warnings = [wagooPull.warn, avendasPull.warn].filter(Boolean);
  if (!wagooPull.ok && !avendasPull.ok) {
    return res.status(502).json({
      ok: false,
      message: "Falha ao consultar APIs upstream",
      warnings,
      filtros,
    });
  }

  const merged = mergeDashboards(
    wagooPull.ok ? wagooPull.json : {},
    avendasPull.ok ? avendasPull.json : {},
    filtros,
    warnings,
  );
  const cachedAt = new Date().toISOString();
  mergedDashboardCache.set(cacheKey, merged);

  res.setHeader("X-Korven-Cache", "MISS");
  return res.json(
    withCacheMeta(merged, {
      hit: false,
      ttl_seconds: Math.round(mergedDashboardCache.ttlMs / 1000),
      cached_at: cachedAt,
      upstream: {
        wagoo: wagooPull.fromCache ? "HIT" : "MISS",
        "2avendas": avendasPull.fromCache ? "HIT" : "MISS",
      },
    }),
  );
});

app.get("/monitoring/uptimerobot", async (req, res) => {
  const apiKey = (process.env.UPTIMEROBOT_API_KEY ?? "").trim();
  if (!apiKey) {
    return res.status(503).json({
      ok: false,
      message: "UPTIMEROBOT_API_KEY não configurada no backend.",
    });
  }

  const forceRefresh =
    req.query.refresh === "1" || String(req.header("x-korven-refresh") ?? "").trim() === "1";
  const includeHeavy =
    req.query.full === "1" || String(req.header("x-korven-uptime-full") ?? "").trim() === "1";

  if (!forceRefresh) {
    const cacheKey = includeHeavy ? "uptime:full" : "uptime:lite";
    const cached = uptimeRobotCache.get(cacheKey);
    if (cached) {
      res.setHeader("X-Korven-Cache", "HIT");
      return res.json({
        ...cached,
        cache: {
          hit: true,
          ttl_seconds: Math.round(uptimeRobotCache.ttlMs / 1000),
          mode: includeHeavy ? "full" : "lite",
        },
      });
    }
  }

  try {
    const body = new URLSearchParams({
      api_key: apiKey,
      format: "json",
      custom_uptime_ratios: "1-7-30",
    });
    if (includeHeavy) {
      body.set("logs", "1");
      body.set("response_times", "1");
      body.set("response_times_limit", "20");
    } else {
      body.set("logs", "0");
      body.set("response_times", "0");
    }

    const upstream = await fetch(UPTIMEROBOT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    const contentType = (upstream.headers.get("content-type") || "").toLowerCase();
    const rawText = await upstream.text();
    let json = {};
    try {
      json = rawText ? JSON.parse(rawText) : {};
    } catch {
      json = {};
    }

    if (!contentType.includes("application/json")) {
      return res.status(502).json({
        ok: false,
        message: "UptimeRobot retornou resposta não-JSON.",
        upstreamStatus: upstream.status,
      });
    }

    if (!upstream.ok) {
      return res.status(502).json({
        ok: false,
        message: `Falha ao consultar UptimeRobot (HTTP ${upstream.status}).`,
        upstream: json,
      });
    }

    const root = firstObject(json);
    const monitorsRaw = Array.isArray(root.monitors) ? root.monitors : [];
    const monitors = monitorsRaw.map((item) => {
      const m = firstObject(item);
      const statusCode = Number(m.status ?? -1);
      return {
        id: m.id ?? null,
        name: m.friendly_name ?? "Sem nome",
        url: m.url ?? null,
        statusCode,
        status: mapUptimeMonitorStatus(statusCode),
        type: m.type ?? null,
        interval: m.interval ?? null,
        uptimeRatio: m.custom_uptime_ratio ?? m.all_time_uptime_ratio ?? null,
        createDatetime: m.create_datetime ?? null,
        logs: Array.isArray(m.logs) ? m.logs : [],
        responseTimes: Array.isArray(m.response_times) ? m.response_times : [],
      };
    });

    const payload = {
      ok: true,
      fetchedAt: new Date().toISOString(),
      stat: root.stat ?? "unknown",
      total: monitors.length,
      monitors,
      ...(includeHeavy ? { raw: root } : {}),
      cache: {
        hit: false,
        ttl_seconds: Math.round(uptimeRobotCache.ttlMs / 1000),
        mode: includeHeavy ? "full" : "lite",
      },
    };
    uptimeRobotCache.set(includeHeavy ? "uptime:full" : "uptime:lite", payload);
    res.setHeader("X-Korven-Cache", "MISS");
    return res.json(payload);
  } catch (error) {
    return res.status(502).json({
      ok: false,
      message: `Erro ao consultar UptimeRobot: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
});

const port = Number(process.env.PORT || 3001);
app.listen(port, "0.0.0.0", () => {
  console.log(`backend running on :${port}`);
});
