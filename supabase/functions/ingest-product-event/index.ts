import { adminClient, enumField, getProduct, handleError, hmacHex, HttpError, json, parseJson, preflight, stringField, timingSafeEqual, upsertIdentity } from "../_shared/mod.ts";

const PRODUCTS = ["wagoo", "2avendas"] as const;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function resolveProvider(eventPayload: Record<string, unknown>): "mercadopago" | "stripe" | "unknown" {
  const raw = eventPayload.provider;
  if (raw === "mercadopago" || raw === "stripe") return raw;
  if (typeof eventPayload.mercadopago_payment_id === "string") return "mercadopago";
  if (typeof eventPayload.stripe_event_id === "string") return "stripe";
  return "unknown";
}

/** Normaliza valor monetário para centavos (bigint do payment_events / métricas). */
function amountToCents(eventPayload: Record<string, unknown>, provider: string): number | null {
  const amountPaid = eventPayload.amount_paid;
  const amountTotal = eventPayload.amount_total;
  const amountDue = eventPayload.amount_due;
  const amount = eventPayload.amount;

  const pick =
    (typeof amountPaid === "number" && Number.isFinite(amountPaid) ? amountPaid : null) ??
    (typeof amountTotal === "number" && Number.isFinite(amountTotal) ? amountTotal : null) ??
    (typeof amountDue === "number" && Number.isFinite(amountDue) ? amountDue : null) ??
    (typeof amount === "number" && Number.isFinite(amount) ? amount : null);

  if (pick == null) return null;

  // Stripe já envia centavos. MP no backend envia amount_total em centavos + amount em reais.
  if (provider === "mercadopago") {
    if (typeof amountTotal === "number" && Number.isFinite(amountTotal)) {
      return Math.round(amountTotal);
    }
    return Math.round(pick * 100);
  }
  return Math.round(pick);
}

function formatBrlFromCents(cents: number | null): string | null {
  if (cents == null || !Number.isFinite(cents)) return null;
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function paymentNotificationCopy(input: {
  eventType: string;
  provider: string;
  email: string | null;
  cents: number | null;
  plan: string | null;
  kind: string | null;
}): { severity: string; title: string; body: string | null } {
  const providerLabel =
    input.provider === "mercadopago"
      ? "Mercado Pago"
      : input.provider === "stripe"
      ? "Stripe"
      : "Pagamento";
  const ok = input.eventType === "payment.succeeded";
  const money = formatBrlFromCents(input.cents);
  const kind =
    input.kind === "booking_deposit" || input.kind === "sinal"
      ? "sinal"
      : input.kind === "club_membership"
      ? "clube"
      : input.plan
      ? `plano ${input.plan}`
      : null;
  const title = ok
    ? `${providerLabel} · pagamento confirmado`
    : `${providerLabel} · falha no pagamento`;
  const parts = [input.email, money, kind].filter(Boolean);
  return {
    severity: ok ? "success" : "error",
    title,
    body: parts.length ? parts.join(" · ") : null,
  };
}

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

    const eventPayload = asRecord(body.payload);

    if (eventType === "admin.event" && body.external_user_id === "system") {
      const { error } = await admin.from("integration_events").upsert({
        product_id: productRow.id,
        event_type: eventType,
        external_event_id: eventId,
        state: "succeeded",
        payload: body,
      }, { onConflict: "product_id,external_event_id", ignoreDuplicates: true });
      if (error) throw error;

      const message =
        typeof eventPayload.message === "string"
          ? eventPayload.message
          : typeof body.message === "string"
          ? body.message
          : "Evento operacional";
      const status =
        typeof eventPayload.status === "string"
          ? eventPayload.status
          : "online";
      const severity =
        status === "offline" ? "error" : status === "degraded" ? "warning" : "info";
      const app =
        typeof eventPayload.app === "string" ? eventPayload.app : product;
      const { error: notificationError } = await admin.from("notifications").insert({
        type: eventType,
        severity,
        title: `${String(app).toUpperCase()} · operação`,
        product_id: productRow.id,
        user_id: null,
        account_id: null,
        source_event_id: eventId,
        body: message,
        data: body,
      });
      if (notificationError) throw notificationError;

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

    const provider = resolveProvider(eventPayload);
    const meta = asRecord(eventPayload.metadata);
    const plan =
      (typeof eventPayload.plan === "string" ? eventPayload.plan : null) ??
      (typeof meta.plan === "string" ? meta.plan : null);
    const kind =
      (typeof meta.kind === "string" ? meta.kind : null) ??
      (typeof eventPayload.kind === "string" ? eventPayload.kind : null);

    if (eventType === "payment.succeeded" || eventType === "payment.failed") {
      const cents = amountToCents(eventPayload, provider);
      const stripeEventId =
        typeof eventPayload.stripe_event_id === "string"
          ? eventPayload.stripe_event_id
          : typeof eventPayload.mercadopago_payment_id === "string"
          ? `mp:${eventPayload.mercadopago_payment_id}:${eventType}`
          : eventId;
      const stripeObjectId =
        typeof eventPayload.invoice_id === "string"
          ? eventPayload.invoice_id
          : typeof eventPayload.checkout_session_id === "string"
          ? eventPayload.checkout_session_id
          : typeof eventPayload.mercadopago_payment_id === "string"
          ? String(eventPayload.mercadopago_payment_id)
          : null;

      const { error: paymentError } = await admin.from("payment_events").upsert({
        product_id: productRow.id,
        account_id: account.id,
        stripe_event_id: stripeEventId,
        stripe_object_id: stripeObjectId,
        event_type: eventType,
        amount: cents,
        currency:
          typeof eventPayload.currency === "string"
            ? eventPayload.currency.toUpperCase()
            : "BRL",
        status: eventType === "payment.succeeded" ? "succeeded" : "failed",
        organization_id: typeof body.organization_id === "string" ? body.organization_id : null,
        plan,
        payload: {
          ...body,
          provider,
          kind,
        },
      }, { onConflict: "stripe_event_id" });
      if (paymentError) throw paymentError;

      const copy = paymentNotificationCopy({
        eventType,
        provider,
        email: typeof body.email === "string" ? body.email : null,
        cents,
        plan,
        kind,
      });
      const { error: notificationError } = await admin.from("notifications").insert({
        type: eventType,
        severity: copy.severity,
        title: copy.title,
        product_id: productRow.id,
        user_id: account.user_id,
        account_id: account.id,
        source_event_id: eventId,
        body: copy.body,
        data: body,
      });
      if (notificationError) throw notificationError;
    } else if (eventType === "subscription.changed") {
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
            typeof eventPayload.customer_id === "string"
              ? eventPayload.customer_id
              : null,
          organization_id: typeof body.organization_id === "string" ? body.organization_id : null,
          plan: typeof eventPayload.plan === "string" ? eventPayload.plan : null,
          status: typeof eventPayload.status === "string" ? eventPayload.status : "unknown",
          metadata: body,
        }, { onConflict: "stripe_subscription_id" });
        if (subscriptionError) throw subscriptionError;
      }
      const { error: notificationError } = await admin.from("notifications").insert({
        type: eventType,
        severity: "info",
        title: "Assinatura atualizada",
        product_id: productRow.id,
        user_id: account.user_id,
        account_id: account.id,
        source_event_id: eventId,
        body: typeof body.email === "string" ? body.email : plan,
        data: body,
      });
      if (notificationError) throw notificationError;
    } else {
      const notificationTypes: Record<string, [string, string]> = {
        "user.first_login": ["success", "Primeiro acesso"],
        "user.created": ["info", "Novo usuário"],
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
    }
    return json({ ok: true, event_id: eventId }, 201);
  } catch (error) { return handleError(error); }
});
