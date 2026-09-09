import { adminClient, asRecord, env, getProduct, handleError, hmacHex, HttpError, json, preflight, timingSafeEqual, upsertIdentity } from "../_shared/mod.ts";

function verifyHeaderParts(header: string) {
  const parts = header.split(",").map((part) => part.trim().split("=", 2));
  const timestamp = parts.find(([key]) => key === "t")?.[1];
  const signatures = parts.filter(([key]) => key === "v1").map(([, value]) => value);
  if (!timestamp || !/^\d+$/.test(timestamp) || signatures.length === 0) throw new HttpError(401, "invalid Stripe-Signature");
  return { timestamp, signatures };
}

Deno.serve(async (req) => {
  const options = preflight(req); if (options) return options;
  if (req.method !== "POST") return json({ ok: false, error: "method not allowed" }, 405);
  try {
    const raw = await req.text();
    if (new TextEncoder().encode(raw).byteLength > 2_000_000) throw new HttpError(413, "payload too large");
    const signatureHeader = req.headers.get("stripe-signature");
    if (!signatureHeader) throw new HttpError(401, "missing Stripe-Signature");
    const { timestamp, signatures } = verifyHeaderParts(signatureHeader);
    if (Math.abs(Date.now() - Number(timestamp) * 1000) > 300_000) throw new HttpError(401, "Stripe signature expired");
    const expected = await hmacHex(env("STRIPE_WEBHOOK_SECRET"), `${timestamp}.${raw}`);
    if (!signatures.some((signature) => timingSafeEqual(signature, expected))) throw new HttpError(401, "invalid Stripe signature");

    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new HttpError(400, "invalid JSON"); }
    const event = asRecord(parsed, "event");
    const eventId = typeof event.id === "string" ? event.id : null;
    const eventType = typeof event.type === "string" ? event.type : null;
    if (!eventId || !eventType) throw new HttpError(400, "invalid Stripe event");
    const admin = adminClient();
    const { data: delivery } = await admin.from("webhook_deliveries").select("id,processed_at").eq("provider", "stripe").eq("event_id", eventId).maybeSingle();
    if (delivery?.processed_at) return json({ ok: true, duplicate: true });
    let deliveryId = delivery?.id;
    if (!deliveryId) {
      const { data, error } = await admin.from("webhook_deliveries").insert({
        provider: "stripe", event_id: eventId, event_type: eventType,
        signature_timestamp: new Date(Number(timestamp) * 1000).toISOString(), payload: event,
      }).select("id").single();
      if (error && error.code !== "23505") throw error;
      deliveryId = data?.id;
    }

    const object = asRecord(asRecord(event.data, "data").object, "data.object");
    const metadata = asRecord(object.metadata ?? {}, "metadata");
    const productSlug = metadata.product;
    if (productSlug !== "wagoo" && productSlug !== "2avendas") throw new HttpError(400, "metadata.product is required");
    const externalUserId = typeof metadata.external_user_id === "string" ? metadata.external_user_id : null;
    if (!externalUserId) throw new HttpError(400, "metadata.external_user_id is required");
    const product = await getProduct(admin, productSlug);
    const account = await upsertIdentity(admin, product.id, {
      external_user_id: externalUserId,
      organization_id: metadata.organization_id, plan: metadata.plan,
      email: object.customer_email ?? object.receipt_email,
    });

    const amount = typeof object.amount_paid === "number" ? object.amount_paid :
      typeof object.amount === "number" ? object.amount : null;
    const status = typeof object.status === "string" ? object.status :
      eventType.includes("payment_failed") ? "failed" : eventType.includes("succeeded") || eventType.includes("paid") ? "succeeded" : null;
    const { error: paymentError } = await admin.from("payment_events").upsert({
      product_id: product.id, account_id: account.id, stripe_event_id: eventId,
      stripe_object_id: typeof object.id === "string" ? object.id : null, event_type: eventType,
      amount, currency: object.currency, status, organization_id: metadata.organization_id,
      plan: metadata.plan, payload: event,
    }, { onConflict: "stripe_event_id", ignoreDuplicates: true });
    if (paymentError) throw paymentError;

    if (eventType.startsWith("customer.subscription.")) {
      const subscriptionId = typeof object.id === "string" ? object.id : null;
      if (subscriptionId) {
        const periodEnd = typeof object.current_period_end === "number" ? new Date(object.current_period_end * 1000).toISOString() : null;
        const { error } = await admin.from("subscriptions").upsert({
          product_id: product.id, account_id: account.id, stripe_customer_id: object.customer,
          stripe_subscription_id: subscriptionId, organization_id: metadata.organization_id,
          plan: metadata.plan, status: object.status ?? "unknown", current_period_end: periodEnd, metadata,
        }, { onConflict: "stripe_subscription_id" });
        if (error) throw error;
      }
    }

    if (status === "succeeded" || status === "paid" || status === "failed") {
      const failed = status === "failed";
      const { error } = await admin.from("notifications").insert({
        type: failed ? "payment.failed" : "payment.succeeded", severity: failed ? "error" : "success",
        title: failed ? "Falha no pagamento" : "Pagamento confirmado", product_id: product.id,
        user_id: account.user_id, account_id: account.id, source_event_id: eventId, data: { amount, metadata },
      });
      if (error) throw error;
    }
    const deliveryQuery = deliveryId
      ? admin.from("webhook_deliveries").update({ processed_at: new Date().toISOString(), error: null }).eq("id", deliveryId)
      : admin.from("webhook_deliveries").update({ processed_at: new Date().toISOString(), error: null }).eq("provider", "stripe").eq("event_id", eventId);
    const { error: deliveryError } = await deliveryQuery;
    if (deliveryError) throw deliveryError;
    return json({ ok: true });
  } catch (error) { return handleError(error); }
});
