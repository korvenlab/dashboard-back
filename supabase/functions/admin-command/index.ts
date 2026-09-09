import { asRecord, enumField, env, getProduct, handleError, HttpError, json, parseJson, preflight, requireOperator, stringField } from "../_shared/mod.ts";

const PRODUCTS = ["wagoo", "2avendas"] as const;
const ACTIONS = ["role.set", "status.set", "plan.set", "access.grant", "user.delete"] as const;

Deno.serve(async (req) => {
  const options = preflight(req); if (options) return options;
  if (req.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);
  try {
    const { admin, user } = await requireOperator(req, ["admin", "operator"]);
    const { body } = await parseJson(req);
    const productSlug = enumField(body, "product", PRODUCTS);
    const action = enumField(body, "action", ACTIONS);
    const externalUserId = stringField(body, "external_user_id", { required: true, max: 255 })!;
    const idempotencyKey = stringField(body, "idempotency_key", { required: true, max: 255 })!;
    const organizationId = stringField(body, "organization_id", { max: 255 });
    const params = asRecord(body.params ?? {}, "params");
    const mirrorPatch: Record<string, unknown> = {};
    if (action === "role.set") mirrorPatch.external_role = stringField(params, "role", { required: true, max: 100 });
    if (action === "status.set") {
      const status = typeof params.status === "string"
        ? stringField(params, "status", { required: true, max: 100 })
        : typeof params.active === "boolean"
          ? params.active ? "active" : "inactive"
          : null;
      if (!status) throw new HttpError(400, "params.status or params.active is required");
      mirrorPatch.external_status = status;
    }
    if (action === "plan.set") mirrorPatch.external_plan = stringField(params, "plan", { required: true, max: 100 });
    if (action === "user.delete") mirrorPatch.external_status = "deleted";
    const product = await getProduct(admin, productSlug);
    const { data: account, error: accountError } = await admin.from("user_product_accounts").select("id,user_id").eq("product_id", product.id).eq("external_user_id", externalUserId).maybeSingle();
    if (accountError) throw accountError;
    if (!account) throw new HttpError(404, "account not found");
    const { data: existing } = await admin.from("integration_commands").select("*").eq("idempotency_key", idempotencyKey).maybeSingle();
    if (existing) return json({ ok: true, duplicate: true, command: existing });

    const requestPayload = { action, external_user_id: externalUserId, organization_id: organizationId, params };
    const { data: command, error: commandError } = await admin.from("integration_commands").insert({
      product_id: product.id, account_id: account.id, action, idempotency_key: idempotencyKey,
      request: requestPayload, requested_by: user.id,
    }).select("id").single();
    if (commandError) throw commandError;
    await admin.from("audit_logs").insert({
      actor_auth_user_id: user.id, action: `command.${action}`, target_type: "user_product_account",
      target_id: account.id, product_id: product.id, details: requestPayload,
    });

    const baseUrl = env(productSlug === "wagoo" ? "WAGOO_API_BASE_URL" : "TWO_AVENDAS_API_BASE_URL").replace(/\/+$/, "");
    const apiSecret = env(productSlug === "wagoo" ? "WAGOO_API_SECRET" : "TWO_AVENDAS_API_SECRET");
    const productUrl = productSlug === "wagoo"
      ? `${baseUrl}/api/admin/commands/${encodeURIComponent(action)}`
      : `${baseUrl}/api/admin/users/commands`;
    const productBody = productSlug === "wagoo"
      ? { external_user_id: externalUserId, organization_id: organizationId, ...params }
      : { command: action, external_user_id: externalUserId, organization_id: organizationId, payload: params };
    const response = await fetch(productUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiSecret}`, "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(productBody),
    });
    const text = await response.text();
    let responseBody: unknown = text;
    try { responseBody = text ? JSON.parse(text) : null; } catch { /* preserve text */ }
    if (!response.ok) {
      await admin.from("integration_commands").update({ state: "failed", response: { status: response.status, body: responseBody } }).eq("id", command.id);
      throw new HttpError(502, `product API returned ${response.status}`);
    }

    if (Object.keys(mirrorPatch).length) {
      const { error } = await admin.from("user_product_accounts").update(mirrorPatch).eq("id", account.id);
      if (error) throw error;
    }
    const { data: completed, error } = await admin.from("integration_commands").update({
      state: "succeeded", response: { status: response.status, body: responseBody }, completed_at: new Date().toISOString(),
    }).eq("id", command.id).select("*").single();
    if (error) throw error;
    return json({ ok: true, command: completed });
  } catch (error) { return handleError(error); }
});
