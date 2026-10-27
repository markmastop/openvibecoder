-- Run once in the SQL editor of your own Supabase project.
-- Only metadata for public tables the caller already has permission to access.
-- No table rows, additional table permissions, or SECURITY DEFINER.
create or replace function public.bim_studio_schema()
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, information_schema
as $$
  select jsonb_build_object('tables', coalesce(jsonb_agg(relation order by relation->>'name'), '[]'::jsonb))
  from (
    select jsonb_build_object(
      'name', t.table_name,
      'operations', to_jsonb(array_remove(array[
        case when has_table_privilege(current_user, format('%I.%I', t.table_schema, t.table_name), 'SELECT') then 'get' end,
        case when has_table_privilege(current_user, format('%I.%I', t.table_schema, t.table_name), 'INSERT') then 'post' end,
        case when has_table_privilege(current_user, format('%I.%I', t.table_schema, t.table_name), 'UPDATE') then 'patch' end,
        case when has_table_privilege(current_user, format('%I.%I', t.table_schema, t.table_name), 'DELETE') then 'delete' end
      ], null)),
      'columns', coalesce((
        select jsonb_agg(jsonb_build_object(
          'name', c.column_name,
          'type', c.data_type,
          'format', c.udt_name,
          'required', c.is_nullable = 'NO' and c.column_default is null and c.is_generated = 'NEVER' and c.is_identity = 'NO',
          'nullable', c.is_nullable = 'YES',
          'hasDefault', c.column_default is not null or c.is_identity = 'YES',
          'readOnly', c.is_generated <> 'NEVER' or coalesce(c.identity_generation, '') = 'ALWAYS'
        ) order by c.ordinal_position)
        from information_schema.columns c
        where c.table_schema = t.table_schema and c.table_name = t.table_name
      ), '[]'::jsonb)
    ) as relation
    from information_schema.tables t
    where t.table_schema = 'public'
      and t.table_type in ('BASE TABLE', 'VIEW', 'FOREIGN TABLE')
      and has_table_privilege(current_user, format('%I.%I', t.table_schema, t.table_name), 'SELECT,INSERT,UPDATE,DELETE')
  ) tables_with_access;
$$;
revoke all on function public.bim_studio_schema() from public;
grant execute on function public.bim_studio_schema() to anon, authenticated;
notify pgrst, 'reload schema';
