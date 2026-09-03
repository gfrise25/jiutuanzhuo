import { supabase } from "@/integrations/supabase/client";

export type MenuItem = {
  id: number;
  name: string;
  price: number;
  active: boolean | null;
};

export type OrderItem = { item_id: number; qty: number };

export type TableInfo = {
  id: string;
  name: string;
  host_name: string;
  deadline: string;
  pickup: string;
  status: string;
  updated_at: string;
};

export type OrderRow = {
  id: string;
  person_name: string;
  items: OrderItem[];
  note: string;
  amount: number;
  via_agent?: boolean;
  created_at: string;
};

export type SummaryRow = {
  item_id: number;
  name: string;
  qty: number;
  subtotal: number;
};

export type PersonTotal = { person_name: string; amount: number };

export type TableStats = {
  total: number;
  people_count: number;
  portions: number;
  people: PersonTotal[];
};

export type TableOrders =
  | ({
      ok: true;
      is_host: true;
      table: TableInfo;
      orders: OrderRow[];
    } & TableStats)
  | ({
      ok: true;
      is_host: false;
      table: TableInfo;
      summary: SummaryRow[];
      my_orders: OrderRow[];
    } & TableStats);


export type RpcFail = { ok: false; error: string };

export function twd(amount: number) {
  return `$${Math.round(amount).toLocaleString("zh-TW")}`;
}

export function formatDeadline(iso: string) {
  return new Date(iso).toLocaleString("zh-TW", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function isClosed(table: TableInfo) {
  return table.status === "closed" || new Date(table.deadline).getTime() < Date.now();
}

export async function fetchMenu(): Promise<MenuItem[]> {
  const { data, error } = await supabase
    .from("menu_items")
    .select("id,name,price,active")
    .eq("active", true)
    .order("id");
  if (error) throw new Error(error.message);
  return (data ?? []) as MenuItem[];
}

export async function fetchTableOrders(tableId: string): Promise<TableOrders> {
  const { data, error } = await supabase.rpc("list_table_orders", { p_table: tableId });
  if (error) throw new Error(error.message);
  const result = data as unknown as TableOrders | RpcFail;
  if (!result || result.ok !== true) {
    throw new Error((result as RpcFail)?.error ?? "讀取這一桌失敗");
  }
  return result;
}

export async function submitOrder(input: {
  tableId: string;
  name: string;
  items: OrderItem[];
  note: string;
  viaAgent?: boolean;
}) {
  const { data, error } = await supabase.rpc("add_order", {
    p_table: input.tableId,
    p_name: input.name,
    p_items: input.items as unknown as never,
    p_note: input.note,
    p_via_agent: input.viaAgent === true,
  });
  if (error) throw new Error(error.message);
  const result = data as unknown as { ok: boolean; error?: string; amount?: number };
  if (!result?.ok) throw new Error(result?.error ?? "送出失敗");
  return result;
}

export async function closeTable(tableId: string) {
  const { data, error } = await supabase.rpc("close_table", { p_table: tableId });
  if (error) throw new Error(error.message);
  const result = data as unknown as { ok: boolean; error?: string };
  if (!result?.ok) throw new Error(result?.error ?? "關團失敗");
  return result;
}

/** 「油庫口團」→「油庫口團（第 2 團）」→「（第 3 團）」 */
export function nextRoundName(name: string) {
  const m = name.match(/^(.*)（第\s*(\d+)\s*團）$/);
  if (m) return `${m[1]}（第 ${Number(m[2]) + 1} 團）`;
  return `${name}（第 2 團）`;
}

export type ReopenResult = { id: string; name: string; deadline: string; pickup: string };

/**
 * 結單後再開一桌：沿用原桌設定另外建立一筆新的 tables 資料，
 * 舊桌與它的訂單完全不動，歷史紀錄保留。
 */
export async function reopenTable(input: {
  sourceTableId: string;
  hours?: number;
}): Promise<ReopenResult> {
  const { data: userRes } = await supabase.auth.getUser();
  const uid = userRes.user?.id;
  if (!uid) throw new Error("尚未登入");

  const { data: src, error: readErr } = await supabase
    .from("tables")
    .select("name,host_name,host_uid,pickup")
    .eq("id", input.sourceTableId)
    .single();
  if (readErr) throw new Error(readErr.message);
  if (!src) throw new Error("找不到這一桌");
  if (src.host_uid !== uid) throw new Error("只有桌主可以再開一桌");

  const hours = input.hours && input.hours > 0 ? Math.min(input.hours, 72) : 2;
  const deadline = new Date(Date.now() + hours * 3600_000).toISOString();
  const name = nextRoundName(src.name);

  const { data, error } = await supabase
    .from("tables")
    .insert({
      name,
      host_uid: uid,
      host_name: src.host_name,
      deadline,
      pickup: src.pickup,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return { id: data.id, name, deadline, pickup: src.pickup };
}

export type PurgeResult = {
  ok: true;
  deleted_count: number;
  deleted: { order_id: string; person_name: string; amount: number }[];
  keyword: string;
};

/** 受限清理：只有團主、未結單、只刪 Agent 代點且名字含關鍵字的訂單，並留稽核紀錄 */
export async function purgeTestOrders(input: {
  tableId: string;
  keyword?: string;
  reason?: string;
}): Promise<PurgeResult> {
  const { data, error } = await supabase.rpc("purge_test_orders", {
    p_table: input.tableId,
    p_keyword: input.keyword ?? "測試",
    p_reason: input.reason ?? "WebMCP 測試資料清理",
  });
  if (error) throw new Error(error.message);
  const result = data as unknown as PurgeResult | RpcFail;
  if (!result || result.ok !== true) {
    throw new Error((result as RpcFail)?.error ?? "清理失敗");
  }
  return result;
}
