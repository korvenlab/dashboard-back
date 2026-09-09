import { enumField, env, getProduct, handleError, HttpError, json, parseJson, preflight, requireOperator, stringField } from "../_shared/mod.ts";

const PRODUCTS = ["wagoo", "2avendas"] as const;
const KINDS = ["promo", "complimentary"] as const;

Deno.serve(async (req) => {
  const options = preflight(req); if (options) return options;
  if (req.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);
  try {
    const { admin, user } = await requireOperator(req, ["admin", "operator"]);
    const { body } = await parseJson(req);
    const productSlug = enumField(body, "product", PRODUCTS);
    const kind = enumField(body, "kind", KINDS);
    const externalUserId = stringField(body, "external_user_id", { required: true, max: 255 })!;
    const idempotencyKey = stringField(body, "idempotency_key", { required: true, max: 255 })!;
    const organizationId = stringField(body, "organization_id", { max: 255 });
    const product = await getProduct(admin, productSlug);
    const { data: account, error } = await admin.from("user_product_accounts").select("id,organization_id").eq("product_id", product.id).eq("external_user_id", externalUserId).maybeSingle();
    if (error) throw error;
    if (!account) throw new HttpError(404, "account not found");
    const { data: existing } = await admin.from("access_links").select("*").eq("idempotency_key", idempotencyKey).maybeSingle();
    if (existing) return json({ ok: true, duplicate: true, access_link: existing });

    const baseUrl = env(productSlug === "wagoo" ? "WAGOO_API_BASE_URL" : "TWO_AVENDAS_API_BASE_URL").replace(/\/+$/, "");
    const secret = env(productSlug === "wagoo" ? "WAGOO_API_SECRET" : "TWO_AVENDAS_API_SECRET");
    const targetOrganizationId = organizationId ?? account.organization_id;
    if (productSlug === "2avendas" && !targetOrganizationId) throw new HttpError(400, "organization_id is required for 2avendas");
    const targetUrl = productSlug === "wagoo"
      ? `${baseUrl}/api/admin/wagoo/promo-links`
      : `${baseUrl}/api/billing/organization-access-link`;
    const requestBody = productSlug === "wagoo"
      ? { label: `Korven Dashboard · ${externalUserId}`, complimentary_days: 60, max_redemptions: 1 }
      : { organization_id: targetOrganizationId };
    const response = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secret}`,
        "X-API-Key": secret,
        "x-admin-secret": secret,
        "X-Billing-Admin-Secret": secret,
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(requestBody),
    });
    const result = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new HttpError(502, `product API returned ${response.status}`);
    const dataRoot = result.data && typeof result.data === "object" && !Array.isArray(result.data)
      ? result.data as Record<string, unknown>
      : result;
    const link =
      typeof dataRoot.signup_url === "string" ? dataRoot.signup_url :
      typeof dataRoot.unlock_url === "string" ? dataRoot.unlock_url :
      typeof dataRoot.url === "string" ? dataRoot.url :
      typeof dataRoot.link === "string" ? dataRoot.link : null;
    if (!link || !/^https:\/\//i.test(link)) throw new HttpError(502, "product API returned an invalid link");
    const expiresAt = typeof dataRoot.expires_at === "string" && !Number.isNaN(Date.parse(dataRoot.expires_at)) ? dataRoot.expires_at : null;
    const { data, error: insertError } = await admin.from("access_links").insert({
      product_id: product.id, account_id: account.id, kind, idempotency_key: idempotencyKey,
      url: link, expires_at: expiresAt, created_by: user.id,
    }).select("*").single();
    if (insertError) throw insertError;
    await admin.from("audit_logs").insert({
      actor_auth_user_id: user.id, action: "access_link.create", target_type: "user_product_account",
      target_id: account.id, product_id: product.id, details: { kind, idempotency_key: idempotencyKey },
    });
    return json({ ok: true, access_link: data }, 201);
  } catch (error) { return handleError(error); }
});
