import { adminClient, enumField, getProduct, handleError, hmacHex, HttpError, json, parseJson, preflight, stringField, timingSafeEqual, upsertIdentity } from "../_shared/mod.ts";

const PRODUCTS = ["wagoo", "2avendas"] as const;

Deno.serve(async (req) => {
  const options = preflight(req); if (options) return options;
  if (req.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);
  try {
    const product = enumField({ product: req.headers.get("x-korven-product") }, "product", PRODUCTS);
    const timestamp = req.headers.get("x-korven-timestamp")?.trim();
    const signature = req.headers.get("x-korven-signature")?.trim().replace(/^sha256=/, "");
    if (!timestamp || !signature) throw new HttpError(401, "missing signature headers");
    const timestampMs = /^\d+$/.test(timestamp) ? Number(timestamp) * 1000 : Date.parse(timestamp);
    if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > 300_000) throw new HttpError(401, "timestamp outside replay window");
    const { raw, body } = await parseJson(req);
    const secretName = product === "wagoo" ? "WAGOO_INGEST_SECRET" : "TWO_AVENDAS_INGEST_SECRET";
    const admin = adminClient();
    let secret = Deno.env.get(secretName)?.trim();
    if (!secret) {
      const { data, error } = await admin.rpc("get_control_plane_secret", { p_name: secretName });
      if (error) throw error;
      secret = typeof data === "string" ? data.trim() : undefined;
    }
    if (!secret) throw new HttpError(503, `${secretName} is not configured`);
    const expected = await hmacHex(secret, `${timestamp}.${raw}`);
    if (!timingSafeEqual(expected, signature)) throw new HttpError(401, "invalid signature");

    const eventId = stringField(body, "event_id", { required: true, max: 255 })!;
    const eventType = stringField(body, "event_type", { required: true, max: 100 })!;
    const occurredAtRaw = stringField(body, "occurred_at", { required: true, max: 100 })!;
    const occurredAt = new Date(occurredAtRaw);
    if (Number.isNaN(occurredAt.valueOf())) throw new HttpError(400, "occurred_at is invalid");
    const user = body.user && typeof body.user === "object" && !Array.isArray(body.user) ? body.user as Record<string, unknown> : body;

    const productRow = await getProduct(admin, product);
    const { data: existing } = await admin.from("user_activity_events").select("id").eq("product_id", productRow.id).eq("event_id", eventId).maybeSingle();
    if (existing) return json({ ok: true, duplicate: true, event_id: eventId });
    if (eventType === "admin.event" && body.external_user_id === "system") {
      const { error } = await admin.from("integration_events").upsert({
        product_id: productRow.id,
        event_type: eventType,
        external_event_id: eventId,
        state: "succeeded",
        payload: body,
      }, { onConflict: "product_id,external_event_id", ignoreDuplicates: true });
      if (error) throw error;
      return json({ ok: true, event_id: eventId }, 201);
    }
    const account = await upsertIdentity(admin, productRow.id, user);
    const { error } = await admin.from("user_activity_events").insert({
      product_id: productRow.id, account_id: account.id, user_id: account.user_id,
      event_id: eventId, event_type: eventType, occurred_at: occurredAt.toISOString(), payload: body,
    });
    if (error) {
      if (error.code === "23505") return json({ ok: true, duplicate: true, event_id: eventId });
      throw error;
    }
    await admin.from("integration_events").upsert({
      product_id: productRow.id,
      event_type: eventType,
      external_event_id: eventId,
      state: "succeeded",
      payload: body,
    }, { onConflict: "product_id,external_event_id", ignoreDuplicates: true });
    const eventPayload =
      body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)
        ? body.payload as Record<string, unknown>
        : {};
    if (eventType === "payment.succeeded" || eventType === "payment.failed") {
      const amountRaw =
        eventPayload.amount_paid ?? eventPayload.amount_total ?? eventPayload.amount_due;
      const amount = typeof amountRaw === "number" && Number.isFinite(amountRaw)
        ? Math.round(amountRaw)
        : null;
      const stripeEventId =
        typeof eventPayload.stripe_event_id === "string"
          ? eventPayload.stripe_event_id
          : eventId;
      const { error: paymentError } = await admin.from("payment_events").upsert({
        product_id: productRow.id,
        account_id: account.id,
        stripe_event_id: stripeEventId,
        stripe_object_id:
          typeof eventPayload.invoice_id === "string"
            ? eventPayload.invoice_id
            : typeof eventPayload.checkout_session_id === "string"
              ? eventPayload.checkout_session_id
              : null,
        event_type: eventType,
        amount,
        currency: typeof eventPayload.currency === "string" ? eventPayload.currency : null,
        status: eventType === "payment.succeeded" ? "succeeded" : "failed",
        organization_id: typeof body.organization_id === "string" ? body.organization_id : null,
        plan: typeof eventPayload.plan === "string" ? eventPayload.plan : null,
        payload: body,
      }, { onConflict: "stripe_event_id" });
      if (paymentError) throw paymentError;
    }
    if (eventType === "subscription.changed") {
      const subscriptionId =
        typeof eventPayload.subscription_id === "string"
          ? eventPayload.subscription_id
          : null;
      if (subscriptionId) {
        const { error: subscriptionError } = await admin.from("subscriptions").upsert({
          product_id: productRow.id,
          account_id: account.id,
          stripe_subscription_id: subscriptionId,
          stripe_customer_id:
            typeof eventPayload.customer_id === "string" ? eventPayload.customer_id : null,
          organization_id: typeof body.organization_id === "string" ? body.organization_id : null,
          plan: typeof eventPayload.plan === "string" ? eventPayload.plan : null,
          status: typeof eventPayload.status === "string" ? eventPayload.status : "unknown",
          metadata: body,
        }, { onConflict: "stripe_subscription_id" });
        if (subscriptionError) throw subscriptionError;
      }
    }
    const notificationTypes: Record<string, [string, string]> = {
      "user.first_login": ["success", "Primeiro acesso"],
      "payment.succeeded": ["success", "Pagamento confirmado"],
      "payment.failed": ["error", "Falha no pagamento"],
    };
    if (notificationTypes[eventType]) {
      const [severity, title] = notificationTypes[eventType];
      const { error: notificationError } = await admin.from("notifications").insert({
        type: eventType, severity, title, product_id: productRow.id, user_id: account.user_id,
        account_id: account.id, source_event_id: eventId,
        body: typeof body.email === "string" ? body.email : null, data: body,
      });
      if (notificationError) throw notificationError;
    }
    return json({ ok: true, event_id: eventId }, 201);
  } catch (error) { return handleError(error); }
});
