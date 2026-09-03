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

export type TableOrders =
  | {
      ok: true;
      is_host: true;
      table: TableInfo;
      total: number;
      people_count: number;
      orders: OrderRow[];
    }
  | {
      ok: true;
      is_host: false;
      table: TableInfo;
      total: number;
      people_count: number;
      summary: SummaryRow[];
      my_orders: OrderRow[];
    };

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
