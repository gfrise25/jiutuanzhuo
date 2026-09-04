/**
 * 加入點餐（/t/:tableId/join）的 WebMCP 工具。
 *
 * 只註冊兩個工具：submit_order（一步完成代點）與 get_table（桌況＋菜單）。
 * 註冊在模組載入時就完成，不等菜單或桌資料抓完。
 */

import {
  fetchMenu,
  fetchTableOrders,
  isClosed,
  itemNameEn,
  submitOrder,
  type MenuItem,
  type TableInfo,
} from "@/lib/group-order";
import {
  isWebMcpAvailable,
  registerWebMcpTools,
  type ToolDescriptor,
} from "@/lib/webmcp";

export type JoinBridge = {
  getName: () => string;
  getNote: () => string;
  getQty: () => Record<number, number>;
  setName: (value: string) => void;
  setNote: (value: string) => void;
  setQty: (id: number, value: number) => void;
  afterSubmit?: () => void;
};

/** join 頁 mount 時掛上，unmount 時拆掉；沒掛也能運作 */
export const joinBridge: { current: JoinBridge | null } = { current: null };

export function attachJoinBridge(bridge: JoinBridge) {
  joinBridge.current = bridge;
  return () => {
    if (joinBridge.current === bridge) joinBridge.current = null;
  };
}

function currentTableId(): string | null {
  if (typeof window === "undefined") return null;
  const m = window.location.pathname.match(/\/t\/([^/]+)/);
  return m?.[1] ?? null;
}

let menuPromise: Promise<MenuItem[]> | null = null;
function ensureMenu(): Promise<MenuItem[]> {
  if (!menuPromise) menuPromise = fetchMenu();
  return menuPromise;
}

let tableCache: { tableId: string; expiresAt: number; promise: Promise<TableInfo> } | null = null;

async function ensureTable(): Promise<
  { ok: true; tableId: string; table: TableInfo } | { ok: false; error: string }
> {
  const tableId = currentTableId();
  if (!tableId) return { ok: false, error: "目前不在某一桌的頁面，沒有 tableId" };
  try {
    if (!tableCache || tableCache.tableId !== tableId || tableCache.expiresAt < Date.now()) {
      tableCache = {
        tableId,
        expiresAt: Date.now() + 10_000,
        promise: fetchTableOrders(tableId).then((data) => data.table),
      };
    }
    return { ok: true, tableId, table: await tableCache.promise };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "讀取這桌資料失敗" };
  }
}

const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "");

/** 英文／簡稱別名，讓英文 agent 也能用自然語言指定品項 */
const EN_ALIASES: Record<string, string[]> = {
  蚵仔麵線: ["oyster", "oystervermicelli", "oysternoodle", "oysternoodles", "oystermisua"],
  大腸麵線: ["porkintestine", "intestine", "porkintestinevermicelli", "intestinenoodle"],
  綜合麵線: ["combo", "combovermicelli", "mixed", "mixednoodle", "combination"],
  碳烤香腸: ["sausage", "grilledsausage", "bbqsausage", "grilledporksausage"],
};

function aliasesFor(item: MenuItem): string[] {
  const en = itemNameEn(item.name);
  return [
    norm(item.name),
    ...(en ? [norm(en)] : []),
    ...(EN_ALIASES[item.name] ?? []).map(norm),
  ];
}

/** 寬鬆模糊比對（中英皆可）：精準 → 別名 → 包含；多筆取名稱最短 */
function resolveItem(menuList: MenuItem[], itemId?: unknown, itemName?: unknown) {
  if (typeof itemId === "number") {
    const byId = menuList.find((m) => m.id === itemId);
    if (byId) return byId;
  }
  const q = norm(typeof itemName === "string" ? itemName : "");
  if (!q) return undefined;
  const exact = menuList.find((m) => aliasesFor(m).some((a) => a === q));
  if (exact) return exact;
  const matches = menuList.filter((m) =>
    aliasesFor(m).some((a) => a.includes(q) || q.includes(a)),
  );
  if (matches.length === 0) return undefined;
  return matches.sort((a, b) => a.name.length - b.name.length)[0];
}

const menuPayload = (list: MenuItem[]) =>
  list.map((m) => ({
    id: m.id,
    name: m.name,
    name_en: itemNameEn(m.name),
    price: m.price,
    price_display: `NT$${m.price}`,
    currency: "TWD",
  }));


let disposed: (() => void) | null = null;

/** App 載入時呼叫一次（client-only）。重複呼叫不會重複註冊。 */
export function registerJoinWebMcpTools() {
  if (typeof window === "undefined") return () => {};
  if (disposed) return disposed;
  if (!isWebMcpAvailable()) {
    console.info("[揪團桌] 這個瀏覽器沒有 modelContext，略過 WebMCP 工具註冊。");
    return () => {};
  }

  const tools: ToolDescriptor[] = [
    {
      name: "submit_order",
      title: "送出訂單",
      description:
        "代點下單唯一步驟：直接帶 name 與 items 呼叫即可完成送出，不需先呼叫其他工具、不需先查菜單。itemName 支援模糊比對（例：香腸→碳烤香腸）。",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          note: { type: "string" },
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                itemId: { type: "integer", minimum: 1 },
                itemName: { type: "string" },
                quantity: { type: "integer", minimum: 0, maximum: 20 },
              },
              required: ["quantity"],
              additionalProperties: false,
            },
          },
        },
        required: ["name", "items"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, idempotentHint: false, untrustedContentHint: true },
      execute: async (raw) => {
        const args = (raw ?? {}) as {
          name?: string;
          note?: string;
          items?: { itemId?: number; itemName?: string; quantity?: number }[];
        };
        const tableId = currentTableId();
        if (!tableId) return { ok: false, error: "目前不在某一桌的頁面，沒有 tableId" };

        const finalName = typeof args.name === "string" ? args.name.trim() : "";
        if (!finalName) return { ok: false, error: "請帶 name（訂餐者名字）" };
        if (!Array.isArray(args.items) || args.items.length === 0) {
          return { ok: false, error: "請帶 items（至少一個品項與數量）" };
        }

        const list = await ensureMenu();
        const resolved: {
          id: number;
          name: string;
          name_en: string | null;
          price: number;
          qty: number;
          subtotal: number;
        }[] = [];
        for (const entry of args.items) {
          const item = resolveItem(list, entry?.itemId, entry?.itemName);
          if (!item) {
            return { ok: false, error: "找不到這個品項", menu: menuPayload(list) };
          }
          const q = Number(entry?.quantity);
          if (!Number.isInteger(q) || q < 0 || q > 20) {
            return { ok: false, error: "quantity 必須是 0 到 20 的整數", menu: menuPayload(list) };
          }
          if (q > 0) {
            resolved.push({
              id: item.id,
              name: item.name,
              name_en: itemNameEn(item.name),
              price: item.price,
              qty: q,
              subtotal: item.price * q,
            });
          }
        }
        if (resolved.length === 0) {
          return { ok: false, error: "所有品項數量都是 0，至少要點一樣東西" };
        }

        const note = typeof args.note === "string" ? args.note.trim() : "";
        try {
          // 單一寫入：不先查、不等畫面更新
          await submitOrder({
            tableId,
            name: finalName,
            items: resolved.map((r) => ({ item_id: r.id, qty: r.qty })),
            note,
            viaAgent: true,
          });
          // 畫面更新非同步進行，不擋住回傳
          queueMicrotask(() => joinBridge.current?.afterSubmit?.());
          return {
            ok: true,
            name: finalName,
            items: resolved,
            subtotal: resolved.reduce((s, r) => s + r.subtotal, 0),
            currency: "TWD",
            tableId,
          };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : "送出失敗" };
        }
      },
    },
    {
      name: "get_table",
      title: "這桌資訊",
      description:
        "只有在需要顯示菜單或桌況時才呼叫；代點下單不需要先呼叫此工具。回傳桌名、桌主、收單狀態、截止時間、tableId 與完整菜單。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: async () => {
        const [t, list] = await Promise.all([ensureTable(), ensureMenu()]);
        if (!t.ok) return { ok: false, error: t.error };
        const closed = isClosed(t.table);
        return {
          ok: true,
          table_id: t.tableId,
          status: closed ? "closed" : "open",
          status_text: closed ? "已截止" : "收單中",
          deadline: t.table.deadline,
          pickup: t.table.pickup,
          menu: menuPayload(list),
          user_content: { table_name: t.table.name, host_name: t.table.host_name },
        };
      },
    },
  ];

  const dispose = registerWebMcpTools(tools);

  // 預抓填快取，fire-and-forget
  void ensureMenu().catch(() => {});
  if (currentTableId()) void ensureTable().catch(() => {});

  disposed = dispose;
  return dispose;
}

// 模組載入即同步註冊；SSR 由 window guard 略過。
if (typeof window !== "undefined") registerJoinWebMcpTools();
