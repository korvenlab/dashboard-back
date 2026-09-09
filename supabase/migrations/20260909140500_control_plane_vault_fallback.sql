-- Fallback para runtimes de Edge Functions que não receberam os project secrets.
-- O valor permanece criptografado no Vault e só pode ser lido pela service_role.

create or replace function public.get_control_plane_secret(p_name text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select decrypted_secret
  from vault.decrypted_secrets
  where name = p_name
  order by created_at desc
  limit 1
$$;

revoke all on function public.get_control_plane_secret(text) from public, anon, authenticated;
grant execute on function public.get_control_plane_secret(text) to service_role;

