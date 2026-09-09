import { adminClient, asRecord, env, getProduct, handleError, HttpError, json, preflight, timingSafeEqual, upsertIdentity } from "../_shared/mod.ts";

type ProductSlug = "wagoo" | "2avendas";

async function reconcileProduct(slug: ProductSlug) {
  const admin = adminClient();
  const product = await getProduct(admin, slug);
  const { data: run, error: runError } = await admin.from("sync_runs").insert({ product_id: product.id }).select("id").single();
  if (runError) throw runError;
  let seen = 0, changed = 0, divergences = 0;
  try {
    const baseUrl = env(slug === "wagoo" ? "WAGOO_API_BASE_URL" : "TWO_AVENDAS_API_BASE_URL").replace(/\/+$/, "");
    const secret = env(slug === "wagoo" ? "WAGOO_API_SECRET" : "TWO_AVENDAS_API_SECRET");
    let cursor: string | null = null;
    for (let page = 1; page <= 100; page++) {
      const url = new URL(slug === "wagoo"
        ? `${baseUrl}/api/admin/sync/users`
        : `${baseUrl}/api/admin/users/sync`);
      url.searchParams.set("page", String(page));
      url.searchParams.set(slug === "wagoo" ? "per_page" : "limit", "100");
      const response = await fetch(url, {
        headers: {
          authorization: `Bearer ${secret}`,
          "X-API-Key": secret,
          "x-admin-secret": secret,
          accept: "application/json",
        },
      });
      if (!response.ok) throw new Error(`${slug} users API returned ${response.status}`);
      const root = asRecord(await response.json(), "users response");
      const payload = root.data && typeof root.data === "object" && !Array.isArray(root.data)
        ? asRecord(root.data, "users data")
        : root;
      const rows = Array.isArray(payload.users)
        ? payload.users
        : Array.isArray(payload.items)
          ? payload.items
          : Array.isArray(payload.data)
            ? payload.data
            : [];
      for (const raw of rows) {
        const source = asRecord(raw, "user");
        if (typeof source.external_user_id !== "string" && typeof source.id === "string") source.external_user_id = source.id;
        const externalId = source.external_user_id;
        if (typeof externalId !== "string") continue;
        seen++;
        const { data: before } = await admin.from("user_product_accounts")
          .select("external_status,external_role,external_plan,organization_id")
          .eq("product_id", product.id).eq("external_user_id", externalId).maybeSingle();
        const differs = !!before && (
          before.external_status !== (source.status ?? null) ||
          before.external_role !== (source.role ?? null) ||
          before.external_plan !== (source.plan ?? null) ||
          before.organization_id !== (source.organization_id ?? null)
        );
        const isNew = !before;
        const account = await upsertIdentity(admin, product.id, source);
        if (isNew || differs) changed++;
        if (differs) {
          divergences++;
          await admin.from("notifications").insert({
            type: "sync.divergence", severity: "warning", title: "Divergência corrigida",
            product_id: product.id, user_id: account.user_id, account_id: account.id,
            data: { before, after: source },
          });
        }
      }
      const hasMore = typeof payload.has_more === "boolean"
        ? payload.has_more
        : typeof payload.next_page === "number"
          ? true
          : rows.length === 100;
      cursor = hasMore ? String(page + 1) : null;
      if (!hasMore || rows.length === 0) break;
    }
    const { error } = await admin.from("sync_runs").update({
      state: "succeeded", completed_at: new Date().toISOString(), cursor,
      records_seen: seen, records_changed: changed, divergences,
    }).eq("id", run.id);
    if (error) throw error;
    return { product: slug, records_seen: seen, records_changed: changed, divergences };
  } catch (error) {
    await admin.from("sync_runs").update({
      state: "failed", completed_at: new Date().toISOString(), records_seen: seen,
      records_changed: changed, divergences, error: error instanceof Error ? error.message : String(error),
    }).eq("id", run.id);
    throw error;
  }
}

Deno.serve(async (req) => {
  const options = preflight(req); if (options) return options;
  if (req.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);
  try {
    const supplied = req.headers.get("x-cron-secret") ?? "";
    if (!supplied || !timingSafeEqual(supplied, env("CRON_SECRET"))) throw new HttpError(401, "invalid cron secret");
    const rawBody = await req.text();
    if (new TextEncoder().encode(rawBody).byteLength > 10_000) throw new HttpError(413, "payload too large");
    let body: Record<string, unknown> = {};
    if (rawBody.trim()) {
      try { body = asRecord(JSON.parse(rawBody)); } catch (error) {
        if (error instanceof HttpError) throw error;
        throw new HttpError(400, "invalid JSON");
      }
    }
    const requested = body.product;
    if (requested != null && requested !== "wagoo" && requested !== "2avendas") throw new HttpError(400, "product is invalid");
    const products: ProductSlug[] = requested ? [requested as ProductSlug] : ["wagoo", "2avendas"];
    const results = [];
    for (const product of products) results.push(await reconcileProduct(product));
    return json({ ok: true, results });
  } catch (error) { return handleError(error); }
});
