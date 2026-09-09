-- PostgREST não consegue usar um índice único parcial como alvo de ON CONFLICT.
-- Valores NULL continuam podendo se repetir em um índice único comum.

drop index if exists public.integration_events_external_uidx;

create unique index integration_events_external_uidx
  on public.integration_events (product_id, external_event_id);

