/**
 * 加入點餐（/t/:tableId/join）的 WebMCP 工具。
 *
 * 這些工具在 App 一載入就註冊（見 __root.tsx），不等 route mount、也不等資料抓完，
 * 所以導航後 agent 立刻就能拿到完整工具清單。
 * 實際狀態在呼叫當下才讀：tableId 從網址取，表單值走 bridge（join 頁掛上後同步畫面）。
 */

import {
  fetchMenu,
  fetchTableOrders,
  isClosed,
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

/** join 頁 mount 時掛上，unmount 時拆掉；沒掛也能運作（用內部草稿） */
export const joinBridge: { current: JoinBridge | null } = { current: null };

export function attachJoinBridge(bridge: JoinBridge) {
  joinBridge.current = bridge;
  return () => {
    if (joinBridge.current === bridge) joinBridge.current = null;
  };
}

const draft = { name: "", note: "", qty: {} as Record<number, number> };

function getName() {
  return joinBridge.current ? joinBridge.current.getName() : draft.name;
}
function getNote() {
  return joinBridge.current ? joinBridge.current.getNote() : draft.note;
}
function getQty() {
  return joinBridge.current ? joinBridge.current.getQty() : draft.qty;
}
function setName(value: string) {
  draft.name = value;
  joinBridge.current?.setName(value);
}
function setNote(value: string) {
  draft.note = value;
  joinBridge.current?.setNote(value);
}
function setQty(id: number, value: number) {
  draft.qty = { ...draft.qty, [id]: value };
  joinBridge.current?.setQty(id, value);
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

function resolveItem(menuList: MenuItem[], itemId?: unknown, itemName?: unknown) {
  if (typeof itemId === "number") return menuList.find((m) => m.id === itemId);
  const q = typeof itemName === "string" ? itemName.trim() : "";
  if (!q) return undefined;
  return menuList.find((m) => m.name === q) ?? menuList.find((m) => m.name.includes(q));
}

function currentOrder(menuList: MenuItem[]) {
  const qty = getQty();
  const items = menuList
    .filter((m) => (qty[m.id] ?? 0) > 0)
    .map((m) => ({
      item_id: m.id,
      name: m.name,
      price: m.price,
      qty: qty[m.id] ?? 0,
      subtotal: m.price * (qty[m.id] ?? 0),
    }));
  return {
    items,
    subtotal: items.reduce((s, i) => s + i.subtotal, 0),
    user_content: { name: getName(), note: getNote() },
  };
}

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
      name: "get_table",
      title: "這桌資訊",
      description: "取得桌名、桌主、收單狀態、截止時間、tableId 與完整菜單（含 id、名稱、單價）。",
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
          menu: list.map((m) => ({ id: m.id, name: m.name, price: m.price })),
          user_content: { table_name: t.table.name, host_name: t.table.host_name },
        };
      },
    },
    {
      name: "list_menu_items",
      title: "菜單",
      description: "列出品項的 id、名稱、單價。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: async () => {
        const list = await ensureMenu();
        return { ok: true, items: list.map((m) => ({ id: m.id, name: m.name, price: m.price })) };
      },
    },
    {
      name: "set_item_quantity",
      title: "填數量",
      description: "選用：只改品項數量（0-20），不送單。可用 itemId 或 itemName。",
      inputSchema: {
        type: "object",
        properties: {
          itemId: { type: "integer", minimum: 1 },
          itemName: { type: "string" },
          quantity: { type: "integer", minimum: 0, maximum: 20 },
        },
        required: ["quantity"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
      execute: async (raw) => {
        const args = (raw ?? {}) as { itemId?: number; itemName?: string; quantity?: number };
        const list = await ensureMenu();
        const item = resolveItem(list, args.itemId, args.itemName);
        if (!item) {
          return {
            ok: false,
            error: "找不到這個品項",
            items: list.map((m) => ({ id: m.id, name: m.name, price: m.price })),
          };
        }
        const q = Number(args.quantity);
        if (!Number.isInteger(q) || q < 0 || q > 20) {
          return { ok: false, error: "quantity 必須是 0 到 20 的整數" };
        }
        setQty(item.id, q);
        return {
          ok: true,
          item: { id: item.id, name: item.name, price: item.price, qty: q },
          subtotal: currentOrder(list).subtotal,
        };
      },
    },
    {
      name: "set_participant_name",
      title: "填名字",
      description: "選用：只填名字欄位，不送單。submit_order 可直接帶 name。",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, idempotentHint: true, untrustedContentHint: true },
      execute: async (raw) => {
        const value = String((raw as { name?: unknown } | null)?.name ?? "").trim();
        if (!value) return { ok: false, error: "name 不可以是空字串" };
        setName(value);
        return { ok: true, user_content: { name: value } };
      },
    },
    {
      name: "set_note",
      title: "填備註",
      description: "選用：只填備註欄位，不送單。submit_order 可直接帶 note。",
      inputSchema: {
        type: "object",
        properties: { note: { type: "string" } },
        required: ["note"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, idempotentHint: true, untrustedContentHint: true },
      execute: async (raw) => {
        const value = String((raw as { note?: unknown } | null)?.note ?? "");
        setNote(value);
        return { ok: true, user_content: { note: value } };
      },
    },
    {
      name: "get_current_order",
      title: "目前訂單",
      description: "回傳表單現況：名字、各品項數量、備註、小計。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: async () => {
        const list = await ensureMenu();
        return { ok: true, ...currentOrder(list) };
      },
    },
    {
      name: "submit_order",
      title: "送出訂單",
      description: "一步完成代點。帶 name 與 items（itemId 或 itemName ＋ quantity），note 選填。直接寫入資料庫並回傳金額。",
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
        const list = await ensureMenu();

        const directName = typeof args.name === "string" ? args.name.trim() : "";
        const directNote = typeof args.note === "string" ? args.note.trim() : "";
        let directItems: { item_id: number; qty: number }[] | null = null;
        if (Array.isArray(args.items)) {
          directItems = [];
          for (const entry of args.items) {
            const item = resolveItem(list, entry?.itemId, entry?.itemName);
            if (!item) {
              return {
                ok: false,
                error: "找不到這個品項",
                items: list.map((m) => ({ id: m.id, name: m.name, price: m.price })),
              };
            }
            const q = Number(entry?.quantity);
            if (!Number.isInteger(q) || q < 0 || q > 20) {
              return { ok: false, error: "quantity 必須是 0 到 20 的整數" };
            }
            if (q > 0) directItems.push({ item_id: item.id, qty: q });
          }
        }

        // 完整參數直接成為 RPC payload，不先更新 React state；這是最快送單路徑。
        const finalName = directName || getName().trim();
        const finalNote = typeof args.note === "string" ? directNote : getNote().trim();
        const finalItems =
          directItems ??
          Object.entries(getQty())
            .filter(([, v]) => (v ?? 0) > 0)
            .map(([k, v]) => ({ item_id: Number(k), qty: v as number }));
        if (!finalName) return { ok: false, error: "請先填「你的名字」" };
        if (finalItems.length === 0) {
          return { ok: false, error: "所有品項數量都是 0，至少要點一樣東西" };
        }

        try {
          const result = await submitOrder({
            tableId,
            name: finalName,
            items: finalItems,
            note: finalNote,
            viaAgent: true,
          });
          joinBridge.current?.afterSubmit?.();
          return {
            ok: true,
            amount: result.amount,
            via_agent: true,
            message: "已加入這桌（Agent 代點）",
          };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : "送出失敗" };
        }
      },
    },
  ];

  // 原生 WebMCP 會把註冊順序交給 agent。把完整送單入口放在讀桌況之後，
  // 避免 agent 先選到三個僅供同步畫面的預填工具而產生多輪往返。
  const priority = new Map([
    ["get_table", 0],
    ["submit_order", 1],
    ["list_menu_items", 2],
    ["get_current_order", 3],
    ["set_item_quantity", 4],
    ["set_participant_name", 5],
    ["set_note", 6],
  ]);
  tools.sort((a, b) => (priority.get(a.name) ?? 99) - (priority.get(b.name) ?? 99));
  const dispose = registerWebMcpTools(tools);

  // 註冊完立刻預抓菜單與桌況（fire-and-forget），填入既有快取，
  // 讓 agent 第一次呼叫工具時不必等首發 round trip。錯誤吞掉、不噴 console。
  void ensureMenu().catch(() => {});
  if (currentTableId()) void ensureTable().catch(() => {});

  disposed = dispose;
  return dispose;
}

// 模組載入即同步註冊；比 React useEffect 更早，避免 agent 在 hydration 前抓到空清單。
// SSR 會由函式內的 window guard 直接略過，瀏覽器端重複呼叫則由 disposed 防重。
if (typeof window !== "undefined") registerJoinWebMcpTools();
