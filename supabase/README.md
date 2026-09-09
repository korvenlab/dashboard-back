# Fundação Supabase — Korven Dashboard

Esta pasta adiciona o novo plano de dados sem remover ou alterar o gateway Express em `src/`.

## Componentes

- `migrations/`: schema, índices, RLS, views/RPC, Realtime e seeds `wagoo`/`2avendas`.
- `functions/ingest-product-event`: ingestão HMAC idempotente de eventos dos produtos.
- `functions/stripe-webhook`: recepção e validação nativa de webhooks Stripe.
- `functions/admin-command`: comandos administrativos autenticados.
- `functions/access-link`: links `promo`/`complimentary` (Wagoo nunca usa trial).
- `functions/reconcile`: sincronização agendada com as APIs dos produtos.

## Variáveis

As funções recebem automaticamente `SUPABASE_URL` e, conforme o projeto, `SUPABASE_SERVICE_ROLE_KEY` ou `SUPABASE_SECRET_KEYS`. Configure também:

- `CORS_ALLOW_ORIGIN`
- `WAGOO_INGEST_SECRET`, `TWO_AVENDAS_INGEST_SECRET`
- `STRIPE_WEBHOOK_SECRET`
- `WAGOO_API_BASE_URL`, `TWO_AVENDAS_API_BASE_URL`
- `WAGOO_API_SECRET`, `TWO_AVENDAS_API_SECRET`
- `CRON_SECRET`

Nunca exponha chaves secret/service-role no navegador. Cadastre operadores inserindo o UUID de `auth.users` em `operator_profiles`; somente `admin` e `operator` executam comandos e criam links. Operadores autenticados leem o dashboard, enquanto notificações só permitem atualização das colunas `read_at` e `archived_at`. `anon` não recebe policies.

## Contrato de ingestão

`POST /functions/v1/ingest-product-event`

Headers:

```text
x-korven-product: wagoo | 2avendas
x-korven-timestamp: epoch em segundos (ou data ISO)
x-korven-signature: sha256=<hex HMAC-SHA256>
```

A assinatura é calculada sobre `<timestamp>.<corpo JSON bruto>`. A janela é de cinco minutos. Corpo mínimo:

```json
{
  "event_id": "evt_produto_123",
  "event_type": "user.first_login",
  "occurred_at": "2026-09-09T12:00:00Z",
  "user": {
    "external_user_id": "usr_123",
    "email": "pessoa@exemplo.com",
    "display_name": "Pessoa",
    "organization_id": "org_123",
    "status": "active",
    "role": "member",
    "plan": "pro"
  }
}
```

`event_id` é único por produto. `user.first_login`, `payment.succeeded` e `payment.failed` geram notificações.

## Contrato Stripe

Configure o endpoint em `stripe-webhook`. A função valida todos os valores `v1` de `Stripe-Signature` sobre `<t>.<corpo bruto>`, com tolerância de cinco minutos. Os objetos processados devem incluir:

```json
{
  "metadata": {
    "product": "wagoo",
    "external_user_id": "usr_123",
    "organization_id": "org_123",
    "plan": "pro"
  }
}
```

Entregas e pagamentos são deduplicados pelo ID do evento Stripe. Eventos `customer.subscription.*` atualizam o espelho de assinatura.

## Contrato de comando

`POST /functions/v1/admin-command`, com JWT Supabase de operador:

```json
{
  "product": "2avendas",
  "external_user_id": "usr_123",
  "organization_id": "org_123",
  "action": "status.set",
  "idempotency_key": "cmd_123",
  "params": { "status": "inactive" }
}
```

Ações: `role.set`, `status.set`, `plan.set`, `access.grant`, `user.delete`. A função envia `POST /api/admin/commands` à API do produto, com Bearer secret e `x-idempotency-key`. O espelho local só muda após resposta 2xx.

`access-link` usa `POST /api/admin/access-links`, com `kind` igual a `promo` ou `complimentary`. As APIs devem retornar `{ "url": "https://...", "expires_at": "..." }`.

`reconcile` exige `x-cron-secret` e aceita corpo vazio, ambos os produtos, ou `{ "product": "wagoo" }`. Consulta `GET /api/admin/users?limit=100&cursor=...`, aceitando listas em `users`, `items` ou `data` e `next_cursor`.

## Desenvolvimento e validação local

```bash
npx supabase start
npx supabase db reset
npx supabase functions serve --env-file supabase/.env.local
```

Não versione `supabase/.env.local`. Rode testes de assinatura, idempotência, RLS por papel e falhas/retentativas das APIs antes do cutover.

## Cutover sugerido

1. Aplicar a migration em ambiente de teste e criar operadores.
2. Configurar secrets e adaptar Wagoo/2AVendas aos contratos acima.
3. Rodar reconciliação inicial e comparar métricas com o Express.
4. Ativar ingestão e Stripe em paralelo, observando deduplicação.
5. Migrar leituras do dashboard gradualmente para views/RPC/Realtime.
6. Manter o Express até validar paridade; removê-lo apenas em mudança posterior.

Os paths das APIs dos produtos são contratos iniciais e precisam ser alinhados com cada backend antes da produção. Não há transação distribuída entre PostgREST e APIs externas; idempotência e reconciliação tratam reenvios e convergência.
