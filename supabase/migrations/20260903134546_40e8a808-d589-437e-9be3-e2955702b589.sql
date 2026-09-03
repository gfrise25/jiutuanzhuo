CREATE TABLE public.order_deletion_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL,
  table_id uuid NOT NULL,
  person_name text NOT NULL,
  amount integer NOT NULL,
  via_agent boolean NOT NULL,
  order_snapshot jsonb NOT NULL,
  deleted_by uuid,
  reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.order_deletion_log TO authenticated;
GRANT ALL ON public.order_deletion_log TO service_role;

ALTER TABLE public.order_deletion_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "deletion log read host" ON public.order_deletion_log
FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.tables t
  WHERE t.id = order_deletion_log.table_id AND t.host_uid = auth.uid()
));

CREATE INDEX order_deletion_log_table_idx ON public.order_deletion_log (table_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.purge_test_orders(p_table uuid, p_keyword text DEFAULT '測試', p_reason text DEFAULT 'WebMCP 測試資料清理')
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_host uuid;
  v_status text;
  v_kw text;
  v_deleted json;
  v_count int;
begin
  v_kw := trim(coalesce(p_keyword, ''));
  if v_kw = '' or length(v_kw) < 2 then
    return json_build_object('ok', false, 'error', '關鍵字至少要 2 個字');
  end if;

  select host_uid, status into v_host, v_status from tables where id = p_table;
  if v_host is null then
    return json_build_object('ok', false, 'error', '找不到這一桌');
  end if;
  if v_host <> auth.uid() then
    return json_build_object('ok', false, 'error', '只有團主可以清理測試訂單');
  end if;
  if v_status = 'closed' then
    return json_build_object('ok', false, 'error', '已結單的桌子不能再清理');
  end if;

  with target as (
    select o.*
    from orders o
    where o.table_id = p_table
      and o.via_agent
      and o.person_name ilike '%' || v_kw || '%'
    order by o.created_at
    limit 50
  ), logged as (
    insert into order_deletion_log (order_id, table_id, person_name, amount, via_agent, order_snapshot, deleted_by, reason)
    select t.id, t.table_id, t.person_name, t.amount, t.via_agent, to_jsonb(t), auth.uid(), left(coalesce(p_reason, ''), 200)
    from target t
    returning order_id, person_name, amount
  ), removed as (
    delete from orders o
    where o.id in (select order_id from logged)
    returning o.id
  )
  select coalesce(json_agg(json_build_object('order_id', l.order_id, 'person_name', l.person_name, 'amount', l.amount)), '[]'::json),
         (select count(*) from removed)::int
    into v_deleted, v_count
  from logged l;

  update tables set updated_at = now() where id = p_table;

  return json_build_object('ok', true, 'deleted_count', v_count, 'deleted', v_deleted, 'keyword', v_kw);
end $function$;

REVOKE ALL ON FUNCTION public.purge_test_orders(uuid, text, text) FROM public;
GRANT EXECUTE ON FUNCTION public.purge_test_orders(uuid, text, text) TO authenticated;