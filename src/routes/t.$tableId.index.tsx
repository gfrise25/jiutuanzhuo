import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { useAnonSession } from "@/hooks/useAnonSession";
import { supabase } from "@/integrations/supabase/client";
import { registerWebMcpTool, isWebMcpAvailable } from "@/lib/webmcp";
import {
  closeTable,
  purgeTestOrders,
  reopenTable,
  submitOrder,
  fetchMenu,
  fetchTableOrders,
  formatDeadline,
  twd,
  type OrderRow,
} from "@/lib/group-order";

export const Route = createFileRoute("/t/$tableId/")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "桌況即時 — 揪團桌" },
      { name: "description", content: "看看這桌現在有誰點了什麼，合計多少，即時更新。" },
      { property: "og:title", content: "桌況即時 — 揪團桌" },
      { property: "og:description", content: "看看這桌現在有誰點了什麼，合計多少，即時更新。" },
      { property: "og:type", content: "website" },
    ],
  }),
  component: TablePage,
});

/** 依座位數量把座位平均排在圓桌邊上 */
function seatStyle(i: number, total: number): React.CSSProperties {
  const r = 104;
  const a = (Math.PI * 2 * i) / Math.max(total, 1) - Math.PI / 2;
  return {
    left: 104 + r * Math.cos(a),
    top: 104 + r * Math.sin(a),
  };
}

function itemsText(order: OrderRow, names: Map<number, string>) {
  const parts = (order.items ?? []).map(
    (i) => `${names.get(i.item_id) ?? `品項 ${i.item_id}`} ×${i.qty}`,
  );
  return order.note ? `${parts.join("、")} · ${order.note}` : parts.join("、");
}

function TablePage() {
  const { tableId } = Route.useParams();
  const session = useAnonSession();
  const ready = !!session.data;
  const qc = useQueryClient();
  const navigate = useNavigate();

  const menu = useQuery({ queryKey: ["menu"], queryFn: fetchMenu, enabled: ready });
  const data = useQuery({
    queryKey: ["table", tableId],
    queryFn: () => fetchTableOrders(tableId),
    enabled: ready,
  });

  const [flash, setFlash] = useState<Set<string>>(new Set());
  const seen = useRef<Set<string> | null>(null);
  const [closing, setClosing] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [confirmBox, setConfirmBox] = useState<{
    title: string;
    lines: string[];
    amount?: string | undefined;
    resolve: (ok: boolean) => void;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [mcpReady, setMcpReady] = useState(false);
  const [mcpOpen, setMcpOpen] = useState(false);
  useEffect(() => setMcpReady(isWebMcpAvailable()), []);

  // realtime：orders / tables 有變動就重拉
  useEffect(() => {
    if (!ready) return;
    const channel = supabase
      .channel(`table-${tableId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "orders", filter: `table_id=eq.${tableId}` },
        () => qc.invalidateQueries({ queryKey: ["table", tableId] }),
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "tables", filter: `id=eq.${tableId}` },
        () => qc.invalidateQueries({ queryKey: ["table", tableId] }),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [ready, tableId, qc]);

  const info = data.data?.table;
  const isHost = data.data?.is_host === true;
  const orders: OrderRow[] = data.data
    ? data.data.is_host
      ? data.data.orders
      : data.data.my_orders
    : [];
  const total = data.data?.total ?? 0;
  const people = data.data?.people_count ?? 0;
  const portions = data.data?.portions ?? 0;
  const peopleList = data.data?.people ?? [];
  const closed = info?.status === "closed";

  const names = useMemo(
    () => new Map((menu.data ?? []).map((m) => [m.id, m.name])),
    [menu.data],
  );
  const itemsById = useMemo(
    () => new Map(orders.map((o) => [o.person_name, o])),
    [orders],
  );


  // 新訂單短暫反白
  useEffect(() => {
    const ids = orders.map((o) => o.id);
    if (seen.current === null) {
      seen.current = new Set(ids);
      return;
    }
    const fresh = ids.filter((id) => !seen.current!.has(id));
    if (fresh.length === 0) return;
    fresh.forEach((id) => seen.current!.add(id));
    setFlash(new Set(fresh));
    const t = setTimeout(() => setFlash(new Set()), 3000);
    return () => clearTimeout(t);
  }, [orders]);

  // ── WebMCP 工具註冊（mount 當下就註冊，不等資料） ──────
  const live = useRef({
    info: undefined as typeof info,
    orders: [] as OrderRow[],
    menu: [] as { id: number; name: string; price: number }[],
    total: 0,
    people: 0,
    portions: 0,
    isHost: false,
    closed: false,
    peopleList: [] as { person_name: string; amount: number }[],
  });
  live.current = {
    info,
    orders,
    menu: (menu.data ?? []).map((m) => ({ id: m.id, name: m.name, price: m.price })),
    total,
    people,
    portions,
    isHost,
    closed,
    peopleList,
  };

  const askConfirm = (title: string, lines: string[], amount?: string) =>
    new Promise<boolean>((resolve) => setConfirmBox({ title, lines, amount, resolve }));
  const askRef = useRef(askConfirm);
  askRef.current = askConfirm;

  useEffect(() => {
    if (!isWebMcpAvailable()) {
      console.info("[揪團桌] 這個瀏覽器沒有 document.modelContext，略過 WebMCP 工具註冊。");
      return;
    }

    /** 資料還沒到就等，最多 5 秒 */
    async function waitForTable() {
      const deadline = Date.now() + 5000;
      while (!live.current.info && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      return live.current.info;
    }

    async function currentMenu() {
      if (live.current.menu.length > 0) return live.current.menu;
      const fetched = await fetchMenu();
      return fetched.map((item) => ({ id: item.id, name: item.name, price: item.price }));
    }

    const loading = { ok: false as const, error: "資料載入中，請稍後再試" };

    const disposers: Array<(() => void) | null> = [];

    disposers.push(
      registerWebMcpTool({
        name: "get_table_status",
        title: "查看桌況",
        description:
          "讀取目前這一桌的資料：桌名、狀態、截止時間、菜單品項（id/名稱/價格）、每筆訂單（名字、品項、數量、小計、是否由 agent 代點）、整桌合計與人數。",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        execute: async () => {
          if (!(await waitForTable())) return loading;
          const s = live.current;
          const menuList = await currentMenu();
          return {
            ok: true,
            status: s.info?.status ?? "unknown",
            deadline: s.info?.deadline ?? null,
            pickup: s.info?.pickup ?? null,
            user_content: { table_name: s.info?.name ?? "" },
            menu: menuList,
            orders: s.orders.map((o) => ({
              items: (o.items ?? []).map((i) => ({ item_id: i.item_id, qty: i.qty })),
              amount: o.amount,
              via_agent: o.via_agent === true,
              user_content: { person_name: o.person_name, note: o.note ?? "" },
            })),
            orders_scope: s.isHost ? "all" : "own_only",
            people: s.peopleList.map((p) => ({
              amount: p.amount,
              user_content: { person_name: p.person_name },
            })),
            total: s.total,
            people_count: s.people,
            portions: s.portions,
          };
        },
      }),
    );

    disposers.push(
      registerWebMcpTool({
        name: "add_order",
        title: "代點加入訂單",
        description:
          "替一位參加者在這一桌加點。item_id 對應 get_table_status 回傳的菜單品項。參數：person_name（參加者名字）、items（[{item_id, qty}]）、note（備註，可省略）。成功後直接建立 Agent 代點訂單。",
        inputSchema: {
          type: "object",
          properties: {
            person_name: { type: "string" },
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  item_id: { type: "integer", minimum: 1 },
                  qty: { type: "integer", minimum: 1 },
                },
                required: ["item_id", "qty"],
                additionalProperties: false,
              },
              minItems: 1,
            },
            note: { type: "string" },
          },
          required: ["person_name", "items"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          idempotentHint: false,
          untrustedContentHint: true,
        },
        execute: async (raw) => {
          if (!(await waitForTable())) return loading;
          if (live.current.closed) return { ok: false, error: "這桌已結單，無法加點" };
          const args = (raw ?? {}) as {
            person_name?: string;
            items?: { item_id: number; qty: number }[];
            note?: string;
          };
          const personName = (args.person_name ?? "").trim();
          if (!personName || !Array.isArray(args.items) || args.items.length === 0) {
            return { ok: false, error: "缺少 person_name 或 items" };
          }
          const invalidItems = args.items.filter(
            (i) =>
              !i ||
              !Number.isInteger(i.item_id) ||
              !Number.isInteger(i.qty) ||
              i.item_id < 1 ||
              i.qty < 1,
          );
          if (invalidItems.length > 0) {
            return { ok: false, error: "item_id 與 qty 必須是大於 0 的整數" };
          }
          const items = args.items;
          const menuList = await currentMenu();
          const unknown = items.filter((i) => !menuList.some((m) => m.id === i.item_id));
          if (unknown.length > 0) {
            return {
              ok: false,
              error: `不存在的 item_id：${unknown.map((i) => i.item_id).join("、")}`,
              menu: menuList,
            };
          }
          try {
            const result = await submitOrder({
              tableId,
              name: personName,
              items,
              note: args.note ?? "",
              viaAgent: true,
            });
            qc.invalidateQueries({ queryKey: ["table", tableId] });
            return {
              ok: true,
              amount: (result as { amount?: number }).amount ?? null,
              items: items.map((item) => ({ item_id: item.item_id, qty: item.qty })),
              via_agent: true,
              user_content: { person_name: personName, note: args.note ?? "" },
            };
          } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : "加點失敗" };
          }
        },
      }),
    );

    disposers.push(
      registerWebMcpTool({
        name: "close_table",
        title: "結單",
        description: "把這一桌結單，結單後不能再加點。只有桌主可以執行。無參數。",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
        execute: async () => {
          if (!(await waitForTable())) return loading;
          const s = live.current;
          if (!s.isHost) return { ok: false, error: "只有桌主可以結單" };
          if (s.closed) return { ok: false, error: "這桌已經結單了" };
          const ok = await askRef.current(
            "確定要結單嗎？",
            [`${s.people} 人`, "結單後就不能再加點"],
            twd(s.total),
          );
          if (!ok) return { ok: false, error: "使用者取消" };
          try {
            await closeTable(tableId);
            qc.invalidateQueries({ queryKey: ["table", tableId] });
            return { ok: true, status: "closed", total: s.total, people_count: s.people };
          } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : "結單失敗" };
          }
        },
      }),
    );

    disposers.push(
      registerWebMcpTool({
        name: "reopen_table",
        title: "沿用設定再開一桌",
        description:
          "在這一桌已結單的狀態下，沿用同樣的桌名、桌主與取餐方式另外開一桌新的，原本這桌的訂單紀錄不會變動。只有桌主可以執行。參數：hours（新桌幾小時後截止，1 到 72，預設 2）。",
        inputSchema: {
          type: "object",
          properties: { hours: { type: "number" } },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false, idempotentHint: false, untrustedContentHint: true },
        execute: async (raw) => {
          if (!(await waitForTable())) return loading;
          const s = live.current;
          if (!s.isHost) return { ok: false, error: "只有桌主可以再開一桌" };
          if (!s.closed) return { ok: false, error: "這桌還沒結單" };
          const args = (raw ?? {}) as { hours?: number };
          const hours =
            Number.isFinite(args.hours) && (args.hours as number) > 0
              ? Math.min(args.hours as number, 72)
              : 2;
          const ok = await askRef.current("要沿用這桌的設定再開一桌嗎？", [
            `桌名：${s.info?.name ?? ""}（會自動加上團次）`,
            `取餐方式：${s.info?.pickup ?? ""}`,
            `截止時間：${hours} 小時後`,
            "這桌的訂單紀錄會完整保留",
          ]);
          if (!ok) return { ok: false, error: "使用者取消" };
          try {
            const next = await reopenTable({ sourceTableId: tableId, hours });
            navigate({ to: "/t/$tableId", params: { tableId: next.id } });
            return {
              ok: true,
              table_id: next.id,
              deadline: next.deadline,
              pickup: next.pickup,
              share_url:
                typeof window !== "undefined"
                  ? `${window.location.origin}/t/${next.id}/join`
                  : null,
              previous_table_id: tableId,
              user_content: { table_name: next.name },
            };
          } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : "再開一桌失敗" };
          }
        },
      }),
    );

    // 破壞性的測試資料清理只在開發環境註冊，正式站不對外提供。
    if (import.meta.env.DEV) {
      disposers.push(
        registerWebMcpTool({
          name: "cleanup_test_orders",
          title: "清理測試訂單（開發用）",
          description:
            "清理這一桌由 Agent 代點且名字含指定關鍵字的測試訂單，刪除前會保留稽核紀錄。只有桌主可以執行。參數：keyword（關鍵字，至少 2 個字，預設「測試」）、reason（清理原因，可省略）。單次最多 50 筆。",
          inputSchema: {
            type: "object",
            properties: {
              keyword: { type: "string" },
              reason: { type: "string" },
            },
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, destructiveHint: true, untrustedContentHint: true },
          execute: async (raw) => {
            if (!(await waitForTable())) return loading;
            const s = live.current;
            if (!s.isHost) return { ok: false, error: "只有桌主可以清理訂單" };
            if (s.closed) return { ok: false, error: "這桌已結單，無法清理" };
            const args = (raw ?? {}) as { keyword?: string; reason?: string };
            const keyword = (args.keyword ?? "測試").trim();
            if (keyword.length < 2) return { ok: false, error: "關鍵字至少要 2 個字" };
            const targets = s.orders.filter(
              (o) => o.via_agent === true && o.person_name.includes(keyword),
            );
            if (targets.length === 0) {
              return { ok: false, error: `沒有符合「${keyword}」的 Agent 測試訂單` };
            }
            const sum = targets.reduce((n, o) => n + o.amount, 0);
            const ok = await askRef.current(
              `要刪掉 ${targets.length} 筆測試訂單嗎？`,
              [
                ...targets.slice(0, 8).map((o) => `${o.person_name} · ${twd(o.amount)}`),
                ...(targets.length > 8 ? [`⋯ 共 ${targets.length} 筆`] : []),
                "刪除會保留稽核紀錄，無法復原",
              ],
              twd(sum),
            );
            if (!ok) return { ok: false, error: "使用者取消" };
            try {
              const result = await purgeTestOrders({
                tableId,
                keyword,
                reason: args.reason ?? "WebMCP 測試資料清理",
              });
              qc.invalidateQueries({ queryKey: ["table", tableId] });
              return {
                ok: true,
                deleted_count: result.deleted_count,
                keyword: result.keyword,
                deleted: result.deleted.map((d) => ({
                  order_id: d.order_id,
                  amount: d.amount,
                  user_content: { person_name: d.person_name },
                })),
              };
            } catch (e) {
              return { ok: false, error: e instanceof Error ? e.message : "清理失敗" };
            }
          },
        }),
      );
    }

    return () => {
      disposers.forEach((d) => d?.());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableId]);

  const shareUrl =
    typeof window !== "undefined" ? `${window.location.origin}/t/${tableId}/join` : "";

  async function onClose() {
    if (!window.confirm("確定要結單嗎？結單後就不能再加點。")) return;
    setClosing(true);
    try {
      await closeTable(tableId);
      toast.success("已結單");
      qc.invalidateQueries({ queryKey: ["table", tableId] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "結單失敗");
    } finally {
      setClosing(false);
    }
  }

  async function onReopen() {
    setReopening(true);
    try {
      const next = await reopenTable({ sourceTableId: tableId });
      toast.success(`已開新桌：${next.name}`);
      navigate({ to: "/t/$tableId", params: { tableId: next.id } });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "再開一桌失敗");
    } finally {
      setReopening(false);
    }
  }


  if (data.isError) {
    return (
      <section className="stage">
        <div className="phone">
          <div className="body">
            <p className="note">
              {data.error instanceof Error ? data.error.message : "讀取這一桌失敗"}
            </p>
          </div>
        </div>
      </section>
    );
  }

  // 座位與明細都以 RPC 回傳的每人金額清單為唯一資料來源
  const seatCount = peopleList.length + (closed ? 0 : 1);


  return (
    <section className="stage">
      <div className="phone">
        <div className="hd">
          <div className="eyebrow">{info?.name ?? "揪團桌"}</div>
          <h1 className="serif">
            {closed ? "這桌結單了" : `桌上現在有 ${people} 個人`}
          </h1>
          {info ? (
            <div style={{ marginTop: 8 }}>
              <span className={`state${closed ? " closed" : ""}`}>
                {closed ? null : <i className="dot" />}
                {closed
                  ? "已結單 · 店家已收到"
                  : `收單中 · ${formatDeadline(info.deadline)} 截止`}
              </span>
            </div>
          ) : null}
        </div>

        <div className="body">
          {closed ? (
            <div className="kpi">
              <div>
                <b>{people}</b>
                <span>人</span>
              </div>
              <div>
                <b>{portions}</b>
                <span>份</span>
              </div>
              <div>
                <b>{twd(total)}</b>
                <span>合計</span>
              </div>
            </div>
          ) : (
            <div className="jt-table">
              <div className="top">
                <b>{twd(total)}</b>
                <span>{info?.pickup ?? ""}</span>
              </div>
              {peopleList.map((p, i) => {
                const o = itemsById.get(p.person_name);
                return (
                  <div
                    key={p.person_name}
                    className={`seat ${o?.via_agent ? "agent" : "full"}${
                      o && flash.has(o.id) ? " flash" : ""
                    }`}
                    style={seatStyle(i, seatCount)}
                  >
                    {o?.via_agent ? `Agent\n${p.person_name}` : p.person_name}
                  </div>
                );
              })}
              {!closed ? (
                <div className="seat" style={seatStyle(seatCount - 1, seatCount)}>
                  ＋
                </div>
              ) : null}
            </div>
          )}

          <div className="ledger">
            {peopleList.map((p) => {
              const o = itemsById.get(p.person_name);
              return (
                <div
                  className={`row${o && flash.has(o.id) ? " new" : ""}`}
                  key={p.person_name}
                >
                  <div className="name">
                    {p.person_name}
                    {info && p.person_name === info.host_name ? "（桌主）" : ""}
                    {o?.via_agent ? <span className="tag">Agent 代點</span> : null}
                  </div>
                  <div className="amt">{twd(p.amount)}</div>
                  {!closed && o ? <div className="items">{itemsText(o, names)}</div> : null}
                </div>
              );
            })}
            {peopleList.length === 0 ? <p className="note">還沒有人點餐。</p> : null}
          </div>


          <div className="total">
            <span>整桌合計</span>
            <span>{twd(total)}</span>
          </div>
          <div className="count">
            <span>
              {people} 人 · {portions} 份
            </span>
            <span>{info?.pickup ?? ""}</span>
          </div>

          <div className="jt-mcp">
            <button
              className="jt-mcp-toggle"
              aria-expanded={mcpOpen}
              onClick={() => setMcpOpen((v) => !v)}
            >
              <span>AI 代點說明（WebMCP）</span>
              <span className="jt-mcp-state">
                {mcpReady ? "已註冊工具" : "此瀏覽器未支援"}
              </span>
            </button>
            {mcpOpen ? (
              <div className="jt-mcp-body">
                <p>
                  這一頁會在 <code>document.modelContext</code> 註冊工具，支援 WebMCP 的 AI
                  助理可以直接讀桌況、代點餐。add_order 通過品項與數量驗證後會直接送單；結單、清理與重開桌仍會先跳確認框。
                </p>
                <ul>
                  <li>
                    <b>get_table_status</b>（唯讀）：取得桌名、狀態、截止時間、菜單 id／名稱／價格、
                    訂單明細、整桌合計與人數。
                  </li>
                  <li>
                    <b>add_order</b>
                    {closed ? "（已結單，未註冊）" : ""}：替一位參加者加點，參數 person_name、
                    items（[{"{"} item_id, qty {"}"}]）、note。item_id 先用 get_table_status 取得，驗證成功後直接送單。
                  </li>
                  <li>
                    <b>close_table</b>
                    ：把這桌結單，無參數（執行時檢查桌主身分，並跳確認框）。
                  </li>
                  <li>
                    <b>cleanup_test_orders</b>
                    （僅開發環境註冊，正式站不提供）：刪除本桌由 Agent
                    代點且名字含關鍵字的測試訂單，參數 keyword、reason，會保留稽核紀錄。
                  </li>
                  <li>
                    <b>reopen_table</b>
                    ：已結單後由桌主沿用桌名、桌主與取餐方式
                    另外開一桌，參數 hours（幾小時後截止）。舊桌紀錄保留，新桌會自動註冊上面這些工具。
                  </li>
                </ul>

                <p className="note">
                  例句：「幫我看這桌現在點了什麼」「幫小美點大腸麵線一碗，少辣」。
                </p>
              </div>
            ) : null}
          </div>

          {!isHost && orders.length < people ? (
            <p className="note">其他人的明細只有桌主看得到。</p>
          ) : null}

          {closed ? (
            <>
              <p className="note" style={{ marginTop: 14 }}>
                各自把錢轉給桌主{info ? ` ${info.host_name}` : ""}。這頁可以截圖丟群組。
              </p>
              {isHost ? (
                <>
                  <button className="btn chili" onClick={onReopen} disabled={reopening}>
                    {reopening ? "開桌中…" : "沿用設定，再開一桌"}
                  </button>
                  <p className="note">
                    這桌的紀錄會完整保留，新桌是另一筆資料，截止時間預設兩小時後。
                  </p>
                </>
              ) : null}
              <Link to="/" className="btn soy" style={{ textDecoration: "none" }}>
                從頭開一桌
              </Link>
            </>

          ) : (
            <>
              <div className="share">
                <input value={shareUrl} readOnly />
                <button
                  className="btn ghost"
                  onClick={async () => {
                    await navigator.clipboard.writeText(shareUrl);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  }}
                >
                  {copied ? "已複製" : "複製連結"}
                </button>
              </div>
              <Link
                to="/t/$tableId/join"
                params={{ tableId }}
                className="btn ghost"
                style={{ textDecoration: "none" }}
              >
                我也要點
              </Link>
              {isHost ? (
                <button className="btn chili" onClick={onClose} disabled={closing}>
                  {closing ? "結單中…" : "結單"}
                </button>
              ) : null}
            </>
          )}
        </div>
      </div>

      {confirmBox ? (
        <div className="jt-confirm-backdrop" role="dialog" aria-modal="true">
          <div className="jt-confirm">
            <h2 className="serif">{confirmBox.title}</h2>
            <ul>
              {confirmBox.lines.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
            {confirmBox.amount ? (
              <div className="total">
                <span>金額</span>
                <span>{confirmBox.amount}</span>
              </div>
            ) : null}
            <div className="jt-confirm-actions">
              <button
                className="btn ghost"
                onClick={() => {
                  confirmBox.resolve(false);
                  setConfirmBox(null);
                }}
              >
                取消
              </button>
              <button
                className="btn chili"
                onClick={() => {
                  confirmBox.resolve(true);
                  setConfirmBox(null);
                }}
              >
                確認
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
