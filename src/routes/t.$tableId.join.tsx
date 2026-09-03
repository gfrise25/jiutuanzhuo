import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { useAnonSession } from "@/hooks/useAnonSession";
import {
  fetchMenu,
  fetchTableOrders,
  formatDeadline,
  isClosed,
  submitOrder,
  twd,
  type MenuItem,
  type TableInfo,
} from "@/lib/group-order";
import { isWebMcpAvailable, registerWebMcpTools } from "@/lib/webmcp";

export const Route = createFileRoute("/t/$tableId/join")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "加入這桌 — 揪團桌" },
      { name: "description", content: "選餐點、填備註，加入這一桌的團購訂單。" },
      { property: "og:title", content: "加入這桌 — 揪團桌" },
      { property: "og:description", content: "選餐點、填備註，加入這一桌的團購訂單。" },
      { property: "og:type", content: "website" },
    ],
  }),
  component: JoinPage,
});

function JoinPage() {
  const { tableId } = Route.useParams();
  const navigate = useNavigate();
  const session = useAnonSession();
  const ready = !!session.data;

  const menu = useQuery({ queryKey: ["menu"], queryFn: fetchMenu, enabled: ready });
  const table = useQuery({
    queryKey: ["table", tableId],
    queryFn: () => fetchTableOrders(tableId),
    enabled: ready,
  });

  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [qty, setQty] = useState<Record<number, number>>({});
  const [sending, setSending] = useState(false);

  const subtotal = useMemo(
    () =>
      (menu.data ?? []).reduce((sum, m) => sum + m.price * (qty[m.id] ?? 0), 0),
    [menu.data, qty],
  );

  const info = table.data?.table;
  const closed = info ? isClosed(info) : false;

  function bump(id: number, delta: number) {
    setQty((q) => ({ ...q, [id]: Math.max(0, Math.min(20, (q[id] ?? 0) + delta)) }));
  }

  async function send(): Promise<{ ok: boolean; error?: string; amount?: number | undefined }> {
    const items = Object.entries(qty)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => ({ item_id: Number(k), qty: v }));
    if (!name.trim()) {
      toast.error("請填你的名字");
      return { ok: false, error: "請先填「你的名字」" };
    }
    if (items.length === 0) {
      toast.error("至少要點一樣東西");
      return { ok: false, error: "所有品項數量都是 0，至少要點一樣東西" };
    }
    setSending(true);
    try {
      const result = await submitOrder({ tableId, name: name.trim(), items, note: note.trim() });
      toast.success("已加入這桌");
      navigate({ to: "/t/$tableId", params: { tableId } });
      return { ok: true, amount: result.amount };
    } catch (e) {
      const msg = e instanceof Error ? e.message : "送出失敗";
      toast.error(msg);
      return { ok: false, error: msg };
    } finally {
      setSending(false);
    }
  }

  // ── 讓 WebMCP 工具讀到最新狀態 ─────────────────────
  const stateRef = useRef({
    menu: [] as MenuItem[],
    info: undefined as TableInfo | undefined,
    closed: false,
    name: "",
    note: "",
    qty: {} as Record<number, number>,
    subtotal: 0,
    send,
  });
  stateRef.current = {
    menu: menu.data ?? [],
    info,
    closed,
    name,
    note,
    qty,
    subtotal,
    send,
  };

  useEffect(() => {
    if (!isWebMcpAvailable()) {
      console.info("[揪團桌] 這個瀏覽器沒有 modelContext，略過 WebMCP 工具註冊。");
      return;
    }

    async function ensureMenu(): Promise<MenuItem[]> {
      if (stateRef.current.menu.length > 0) return stateRef.current.menu;
      return fetchMenu();
    }

    function resolveItem(menuList: MenuItem[], itemId?: unknown, itemName?: unknown) {
      if (typeof itemId === "number") return menuList.find((m) => m.id === itemId);
      const q = typeof itemName === "string" ? itemName.trim() : "";
      if (!q) return undefined;
      return menuList.find((m) => m.name === q) ?? menuList.find((m) => m.name.includes(q));
    }

    function currentOrder(menuList: MenuItem[]) {
      const items = menuList
        .filter((m) => (stateRef.current.qty[m.id] ?? 0) > 0)
        .map((m) => ({
          item_id: m.id,
          name: m.name,
          price: m.price,
          qty: stateRef.current.qty[m.id] ?? 0,
          subtotal: m.price * (stateRef.current.qty[m.id] ?? 0),
        }));
      return {
        items,
        subtotal: items.reduce((s, i) => s + i.subtotal, 0),
        user_content: { name: stateRef.current.name, note: stateRef.current.note },
      };
    }

    const dispose = registerWebMcpTools([
      {
        name: "get_table",
        description:
          "取得這一桌的資訊：桌名、桌主、狀態（收單中或已截止）、截止時間、取餐方式、tableId。",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true },
        execute: async () => {
          const t = stateRef.current.info;
          if (!t) return { ok: false, error: "桌況尚未載入" };
          return {
            ok: true,
            table_id: t.id,
            status: stateRef.current.closed ? "closed" : "open",
            status_text: stateRef.current.closed ? "已截止" : "收單中",
            deadline: t.deadline,
            pickup: t.pickup,
            user_content: { table_name: t.name, host_name: t.host_name },
          };
        },
      },
      {
        name: "list_menu_items",
        description: "列出這一桌可點的菜單品項，每項含 id、名稱、單價。",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true },
        execute: async () => {
          const list = await ensureMenu();
          return {
            ok: true,
            items: list.map((m) => ({ id: m.id, name: m.name, price: m.price })),
          };
        },
      },
      {
        name: "set_item_quantity",
        description:
          "設定某個品項的數量（0-20），畫面數字與小計會即時更新。可用 itemId 或 itemName 指定品項。",
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
        execute: async (raw) => {
          const args = (raw ?? {}) as { itemId?: number; itemName?: string; quantity?: number };
          if (stateRef.current.closed) return { ok: false, error: "這桌已結單，無法修改" };
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
          setQty((prev) => ({ ...prev, [item.id]: q }));
          stateRef.current.qty = { ...stateRef.current.qty, [item.id]: q };
          return {
            ok: true,
            item: { id: item.id, name: item.name, price: item.price, qty: q },
            subtotal: currentOrder(list).subtotal,
          };
        },
      },
      {
        name: "set_participant_name",
        description: "填入「你的名字」欄位。參數 name。",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          additionalProperties: false,
        },
        execute: async (raw) => {
          const value = String((raw as { name?: unknown } | null)?.name ?? "").trim();
          if (!value) return { ok: false, error: "name 不可以是空字串" };
          setName(value);
          stateRef.current.name = value;
          return { ok: true, user_content: { name: value } };
        },
      },
      {
        name: "set_note",
        description: "填入備註欄位（例如「不要香菜」）。參數 note。",
        inputSchema: {
          type: "object",
          properties: { note: { type: "string" } },
          required: ["note"],
          additionalProperties: false,
        },
        execute: async (raw) => {
          const value = String((raw as { note?: unknown } | null)?.note ?? "");
          setNote(value);
          stateRef.current.note = value;
          return { ok: true, user_content: { note: value } };
        },
      },
      {
        name: "get_current_order",
        description: "回傳目前表單狀態：名字、各品項數量、備註、小計金額。",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true },
        execute: async () => {
          const list = await ensureMenu();
          return { ok: true, ...currentOrder(list) };
        },
      },
      {
        name: "submit_order",
        description:
          "送出這張訂單，等同按下「送出，加入桌上」。名字空白或所有數量為 0 時會回傳錯誤而不送出。",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        execute: async () => {
          if (stateRef.current.closed) return { ok: false, error: "這桌已結單，無法送出" };
          if (!stateRef.current.name.trim()) return { ok: false, error: "請先填「你的名字」" };
          const total = Object.values(stateRef.current.qty).reduce((s, v) => s + (v ?? 0), 0);
          if (total <= 0) return { ok: false, error: "所有品項數量都是 0，至少要點一樣東西" };
          const result = await stateRef.current.send();
          return result.ok
            ? { ok: true, amount: result.amount, message: "已加入這桌" }
            : { ok: false, error: result.error ?? "送出失敗" };
        },
      },
    ]);

    return dispose;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableId]);

  return (
    <section className="stage">
      <div className="phone">
        <div className="hd">
          <div className="eyebrow">
            {info ? `${info.name} · 桌主 ${info.host_name}` : "揪團桌"}
          </div>
          <h1 className="serif">加入這桌</h1>
          {info ? (
            <div style={{ marginTop: 8 }}>
              <span className={`state${closed ? " closed" : ""}`}>
                {closed ? null : <i className="dot" />}
                {closed
                  ? "已結單，無法再點"
                  : `收單中 · ${formatDeadline(info.deadline)} 截止`}
              </span>
            </div>
          ) : null}
        </div>

        <div className="body">
          <label htmlFor="me">你的名字</label>
          <input
            id="me"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="小陳"
            disabled={closed}
          />

          <label>選餐點</label>
          <div className="menu">
            {(menu.data ?? []).map((m) => (
              <div className="item" key={m.id}>
                <div className="n">{m.name}</div>
                <div className="p">${m.price}</div>
                <div className="qty">
                  <button onClick={() => bump(m.id, -1)} disabled={closed} aria-label="減少">
                    −
                  </button>
                  <span>{qty[m.id] ?? 0}</span>
                  <button onClick={() => bump(m.id, 1)} disabled={closed} aria-label="增加">
                    +
                  </button>
                </div>
              </div>
            ))}
            {menu.isLoading ? <p className="note">菜單載入中…</p> : null}
          </div>

          <label htmlFor="note">備註</label>
          <input
            id="note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="不要香菜"
            disabled={closed}
          />
        </div>

        <div className="sticky">
          <div>
            <small style={{ color: "var(--jt-mute)" }}>我的小計</small>
            <br />
            <b>{twd(subtotal)}</b>
          </div>
          <button className="btn chili" onClick={send} disabled={sending || closed}>
            {closed ? "已結單" : sending ? "送出中…" : "送出，加入桌上"}
          </button>
        </div>
      </div>
    </section>
  );
}
