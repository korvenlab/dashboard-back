import cors from "cors";
import express from "express";

const app = express();
app.use(cors());
app.use(express.json());

function toInt(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function firstObject(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

async function pullDashboard(label, baseUrl, apiKey, filtros) {
  if (!baseUrl || !apiKey) {
    return { ok: false, warn: `${label}: env ausente` };
  }
  const url = new URL(`${String(baseUrl).replace(/\/+$/, "")}/dashboard`);
  url.searchParams.set("period_days", String(filtros.period_days));
  url.searchParams.set("chart_days", String(filtros.chart_days));
  if (filtros.organization_id) {
    url.searchParams.set("organization_id", filtros.organization_id);
  }

  try {
    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-API-Key": apiKey,
        Accept: "application/json",
      },
    });
    const text = await res.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      return { ok: false, warn: `${label}: JSON inválido` };
    }
    if (!res.ok) return { ok: false, warn: `${label}: HTTP ${res.status}` };
    return { ok: true, json };
  } catch (e) {
    return { ok: false, warn: `${label}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function mergeDashboards(wagooJson, avendasJson, filtros, warnings) {
  const wagoo = firstObject(wagooJson);
  const avendas = firstObject(avendasJson);
  const wagooBlock = firstObject(wagoo.wagoo);
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

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "korven-dashboard-backend" });
});

app.get("/dashboard", async (req, res) => {
  const filtros = {
    organization_id: typeof req.query.organization_id === "string" ? req.query.organization_id : undefined,
    period_days: toInt(req.query.period_days, 30),
    chart_days: toInt(req.query.chart_days, 14),
  };

  const authHeader = req.header("authorization");
  const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
  const incomingKey = req.header("x-api-key") || bearer;
  const gatewayKey = process.env.DASHBOARD_BACKEND_API_KEY;
  if (gatewayKey && incomingKey !== gatewayKey) {
    return res.status(401).json({ ok: false, message: "unauthorized" });
  }

  const [wagooPull, avendasPull] = await Promise.all([
    pullDashboard(
      "Wagoo",
      process.env.WAGOO_API_BASE_URL,
      process.env.WAGOO_METRICS_API_KEY,
      filtros,
    ),
    pullDashboard(
      "2AVENDAS",
      process.env.TWO_AVENDAS_API_BASE_URL,
      process.env.TWO_AVENDAS_METRICS_API_KEY,
      filtros,
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
  return res.json(merged);
});

const port = Number(process.env.PORT || 3001);
app.listen(port, "0.0.0.0", () => {
  console.log(`backend running on :${port}`);
});
