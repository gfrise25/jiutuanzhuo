CREATE OR REPLACE FUNCTION public.list_table_orders(p_table uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_t record;
  v_is_host boolean;
  v_table json;
  v_total int;
  v_people int;
  v_portions int;
  v_people_list json;
  v_result json;
begin
  select * into v_t from tables where id = p_table;
  if v_t.id is null then
    return json_build_object('ok',false,'error','找不到這一桌');
  end if;
  v_is_host := (v_t.host_uid = auth.uid());

  v_table := json_build_object(
    'id', v_t.id, 'name', v_t.name, 'host_name', v_t.host_name,
    'deadline', v_t.deadline, 'pickup', v_t.pickup, 'status', v_t.status,
    'updated_at', v_t.updated_at);

  -- 統計全部由同一批訂單資料算出
  select coalesce(sum(o.amount),0)::int,
         count(distinct o.person_name)::int
    into v_total, v_people
  from orders o where o.table_id = p_table;

  select coalesce(sum((i->>'qty')::int),0)::int
    into v_portions
  from orders o
  cross join lateral jsonb_array_elements(o.items) i
  where o.table_id = p_table;

  select coalesce(json_agg(to_jsonb(x) order by x.person_name), '[]'::json)
    into v_people_list
  from (
    select o.person_name, sum(o.amount)::int as amount
    from orders o where o.table_id = p_table
    group by o.person_name
  ) x;

  if v_is_host then
    v_result := json_build_object(
      'ok', true, 'is_host', true, 'table', v_table,
      'total', v_total, 'people_count', v_people, 'portions', v_portions,
      'people', v_people_list,
      'orders', coalesce((
        select json_agg(json_build_object(
          'id', o.id, 'person_name', o.person_name, 'items', o.items,
          'note', o.note, 'amount', o.amount, 'via_agent', o.via_agent,
          'created_at', o.created_at) order by o.created_at)
        from orders o where o.table_id = p_table), '[]'::json));
  else
    v_result := json_build_object(
      'ok', true, 'is_host', false, 'table', v_table,
      'total', v_total, 'people_count', v_people, 'portions', v_portions,
      'people', v_people_list,
      'summary', coalesce((
        select json_agg(to_jsonb(x) order by x.item_id) from (
          select (i->>'item_id')::int as item_id,
                 m.name,
                 sum((i->>'qty')::int)::int as qty,
                 (sum((i->>'qty')::int) * m.price)::int as subtotal
          from orders o
          cross join lateral jsonb_array_elements(o.items) i
          join menu_items m on m.id = (i->>'item_id')::int
          where o.table_id = p_table
          group by (i->>'item_id')::int, m.name, m.price
        ) x), '[]'::json),
      'my_orders', coalesce((
        select json_agg(json_build_object(
          'id', o.id, 'person_name', o.person_name, 'items', o.items,
          'note', o.note, 'amount', o.amount, 'via_agent', o.via_agent,
          'created_at', o.created_at)
          order by o.created_at)
        from orders o where o.table_id = p_table and o.uid = auth.uid()), '[]'::json));
  end if;

  return v_result;
end $function$;