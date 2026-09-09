import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const corsHeaders = {
  "Access-Control-Allow-Origin": Deno.env.get("CORS_ALLOW_ORIGIN") ?? "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, idempotency-key, x-korven-product, x-korven-timestamp, x-korven-signature, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: corsHeaders });
}

export function preflight(req: Request): Response | null {
  return req.method === "OPTIONS" ? new Response("ok", { headers: corsHeaders }) : null;
}

export function env(name: string): string {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function adminKey(): string {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
  if (legacy) return legacy;
  const keys = JSON.parse(env("SUPABASE_SECRET_KEYS")) as Record<string, string>;
  if (!keys.default) throw new Error("Missing default Supabase secret key");
  return keys.default;
}

export function adminClient(): SupabaseClient {
  return createClient(env("SUPABASE_URL"), adminKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function asRecord(value: unknown, label = "body"): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, `${label} must be an object`);
  return value as Record<string, unknown>;
}

export function stringField(record: Record<string, unknown>, key: string, options: { required?: boolean; max?: number } = {}): string | null {
  const value = record[key];
  if (value == null || value === "") {
    if (options.required) throw new HttpError(400, `${key} is required`);
    return null;
  }
  if (typeof value !== "string") throw new HttpError(400, `${key} must be a string`);
  const clean = value.trim();
  if (!clean || clean.length > (options.max ?? 500)) throw new HttpError(400, `${key} is invalid`);
  return clean;
}

export function enumField<T extends string>(record: Record<string, unknown>, key: string, allowed: readonly T[]): T {
  const value = stringField(record, key, { required: true, max: 100 });
  if (!allowed.includes(value as T)) throw new HttpError(400, `${key} is invalid`);
  return value as T;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function parseJson(req: Request, maxBytes = 1_000_000): Promise<{ raw: string; body: Record<string, unknown> }> {
  const raw = await req.text();
  if (new TextEncoder().encode(raw).byteLength > maxBytes) throw new HttpError(413, "payload too large");
  try { return { raw, body: asRecord(JSON.parse(raw)) }; } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "invalid JSON");
  }
}

function bytesToHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
}

export function timingSafeEqual(a: string, b: string): boolean {
  const aa = new TextEncoder().encode(a.toLowerCase());
  const bb = new TextEncoder().encode(b.toLowerCase());
  if (aa.length !== bb.length) return false;
  let result = 0;
  for (let i = 0; i < aa.length; i++) result |= aa[i] ^ bb[i];
  return result === 0;
}

export async function requireOperator(req: Request, roles: readonly ("admin" | "operator" | "viewer")[]) {
  const auth = req.headers.get("authorization") ?? "";
  const token = auth.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) throw new HttpError(401, "missing bearer token");
  const admin = adminClient();
  // Chamadas do servidor SSR do Dashboard já passaram pela sessão HttpOnly
  // e usam a service role apenas no runtime server-side.
  if (token === adminKey()) {
    return { admin, user: { id: null }, role: "admin" as const };
  }
  const { data: userData, error: authError } = await admin.auth.getUser(token);
  if (authError || !userData.user) throw new HttpError(401, "invalid bearer token");
  const { data: profile, error } = await admin.from("operator_profiles").select("role").eq("auth_user_id", userData.user.id).maybeSingle();
  if (error) throw error;
  if (!profile || !roles.includes(profile.role)) throw new HttpError(403, "insufficient role");
  return { admin, user: userData.user, role: profile.role as "admin" | "operator" | "viewer" };
}

export function handleError(error: unknown): Response {
  console.error(error);
  if (error instanceof HttpError) return json({ ok: false, error: error.message }, error.status);
  return json({ ok: false, error: error instanceof Error ? error.message : "internal error" }, 500);
}

export async function getProduct(admin: SupabaseClient, slug: string) {
  const { data, error } = await admin.from("products").select("id,slug").eq("slug", slug).single();
  if (error) throw error;
  return data as { id: string; slug: "wagoo" | "2avendas" };
}

export async function upsertIdentity(admin: SupabaseClient, productId: string, input: Record<string, unknown>) {
  const externalUserId = stringField(input, "external_user_id", { required: true, max: 255 })!;
  const email = stringField(input, "email", { max: 320 });
  const { data: existingAccount, error: existingAccountError } = await admin
    .from("user_product_accounts").select("user_id")
    .eq("product_id", productId).eq("external_user_id", externalUserId).maybeSingle();
  if (existingAccountError) throw existingAccountError;
  let userId: string | null = existingAccount?.user_id ?? null;
  if (!userId && email) {
    const { data } = await admin.from("users").select("id").eq("email_normalized", email.toLowerCase()).maybeSingle();
    userId = data?.id ?? null;
  }
  if (!userId) {
    const { data, error } = await admin.from("users").insert({
      email, display_name: stringField(input, "display_name", { max: 255 }),
      phone: stringField(input, "phone", { max: 50 }), metadata: asRecord(input.metadata ?? {}, "metadata"),
    }).select("id").single();
    if (error) throw error;
    userId = data.id;
  } else {
    const userPatch = {
      ...(email ? { email } : {}),
      ...(typeof input.display_name === "string" ? { display_name: stringField(input, "display_name", { max: 255 }) } : {}),
      ...(typeof input.phone === "string" ? { phone: stringField(input, "phone", { max: 50 }) } : {}),
    };
    if (Object.keys(userPatch).length) {
      const { error } = await admin.from("users").update(userPatch).eq("id", userId);
      if (error) throw error;
    }
  }
  const account = {
    user_id: userId, product_id: productId, external_user_id: externalUserId,
    organization_id: stringField(input, "organization_id", { max: 255 }),
    external_status: stringField(input, "status", { max: 100 }),
    external_role: stringField(input, "role", { max: 100 }),
    external_plan: stringField(input, "plan", { max: 100 }),
    metadata: asRecord(input.metadata ?? {}, "metadata"), last_synced_at: new Date().toISOString(),
  };
  const { data, error } = await admin.from("user_product_accounts").upsert(account, { onConflict: "product_id,external_user_id" }).select("id,user_id").single();
  if (error) throw error;
  return data as { id: string; user_id: string };
}
