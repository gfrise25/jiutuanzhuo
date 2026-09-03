import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { useAnonSession } from "@/hooks/useAnonSession";
import { supabase } from "@/integrations/supabase/client";
import { registerWebMcpTool, isWebMcpAvailable } from "@/lib/webmcp";
import {
  closeTable,
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

  const menu = useQuery({ queryKey: ["menu"], queryFn: fetchMenu, enabled: ready });
  const data = useQuery({
    queryKey: ["table", tableId],
    queryFn: () => fetchTableOrders(tableId),
    enabled: ready,
  });

  const [flash, setFlash] = useState<Set<string>>(new Set());
  const seen = useRef<Set<string> | null>(null);
  const [closing, setClosing] = useState(false);
  const [confirmBox, setConfirmBox] = useState<{
    title: string;
    lines: string[];
    amount?: string | undefined;
    resolve: (ok: boolean) => void;
  } | null>(null);
  const [copied, setCopied] = useState(false);

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
  const closed = info?.status === "closed";

  const names = useMemo(
    () => new Map((menu.data ?? []).map((m) => [m.id, m.name])),
    [menu.data],
  );
  const portions = useMemo(
    () =>
      orders.reduce(
        (n, o) => n + (o.items ?? []).reduce((s, i) => s + (i.qty ?? 0), 0),
        0,
      ),
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

  // ── WebMCP 工具註冊 ─────────────────────────────
  const live = useRef({
    info: undefined as typeof info,
    orders: [] as OrderRow[],
    menu: [] as { id: number; name: string; price: number }[],
    total: 0,
    people: 0,
  });
  live.current = {
    info,
    orders,
    menu: (menu.data ?? []).map((m) => ({ id: m.id, name: m.name, price: m.price })),
    total,
    people,
  };

  const askConfirm = (title: string, lines: string[], amount?: string) =>
    new Promise<boolean>((resolve) => setConfirmBox({ title, lines, amount, resolve }));
  const askRef = useRef(askConfirm);
  askRef.current = askConfirm;

  useEffect(() => {
    if (!ready || !info) return;
    if (!isWebMcpAvailable()) {
      console.info("[揪團桌] 這個瀏覽器沒有 navigator.modelContext，略過 WebMCP 工具註冊。");
      return;
    }
    const disposers: Array<(() => void) | null> = [];

    disposers.push(
      registerWebMcpTool({
        name: "get_table_status",
        description:
          "讀取目前這一桌的資料：桌名、狀態、截止時間、菜單品項（id/名稱/價格）、每筆訂單（名字、品項、數量、小計、是否由 agent 代點）、整桌合計與人數。",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true },
        execute: async () => {
          const s = live.current;
          return {
            ok: true,
            status: s.info?.status ?? "unknown",
            deadline: s.info?.deadline ?? null,
            pickup: s.info?.pickup ?? null,
            user_content: { table_name: s.info?.name ?? "" },
            menu: s.menu,
            orders: s.orders.map((o) => ({
              items: (o.items ?? []).map((i) => ({ item_id: i.item_id, qty: i.qty })),
              amount: o.amount,
              via_agent: o.via_agent === true,
              user_content: { person_name: o.person_name, note: o.note ?? "" },
            })),
            total: s.total,
            people_count: s.people,
          };
        },
      }),
    );

    if (!closed) {
      disposers.push(
        registerWebMcpTool({
          name: "add_order",
          description:
            "替一位參加者在這一桌加點。item_id 請先用 get_table_status 取得。參數：person_name（參加者名字）、items（[{item_id, qty}]）、note（備註，可省略）。",
          inputSchema: {
            type: "object",
            properties: {
              person_name: { type: "string" },
              items: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    item_id: { type: "number" },
                    qty: { type: "number" },
                  },
                  required: ["item_id", "qty"],
                },
              },
              note: { type: "string" },
            },
            required: ["person_name", "items"],
            additionalProperties: false,
          },
          execute: async (raw) => {
            const args = (raw ?? {}) as {
              person_name?: string;
              items?: { item_id: number; qty: number }[];
              note?: string;
            };
            const personName = (args.person_name ?? "").trim();
            const items = (args.items ?? []).filter((i) => i && i.qty > 0);
            if (!personName || items.length === 0) {
              return { ok: false, error: "缺少 person_name 或 items" };
            }
            const s = live.current;
            const priced = items.map((i) => {
              const m = s.menu.find((x) => x.id === i.item_id);
              return {
                label: `${m?.name ?? `品項 ${i.item_id}`} ×${i.qty}`,
                sub: (m?.price ?? 0) * i.qty,
              };
            });
            const preview = priced.reduce((n, p) => n + p.sub, 0);
            const ok = await askRef.current(
              `要幫「${personName}」加點嗎？`,
              [...priced.map((p) => p.label), ...(args.note ? [`備註：${args.note}`] : [])],
              twd(preview),
            );
            if (!ok) return { ok: false, error: "使用者取消" };
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
                user_content: { person_name: personName, note: args.note ?? "" },
              };
            } catch (e) {
              return { ok: false, error: e instanceof Error ? e.message : "加點失敗" };
            }
          },
        }),
      );

      if (isHost) {
        disposers.push(
          registerWebMcpTool({
            name: "close_table",
            description: "把這一桌結單，結單後不能再加點。無參數。",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            execute: async () => {
              const s = live.current;
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
      }
    }

    return () => {
      disposers.forEach((d) => d?.());
    };
  }, [ready, !!info, closed, isHost, tableId, qc]);

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

  // 座位：自己看得到的訂單 + 其他人以匿名座位補齊
  const ghostSeats = Math.max(0, people - new Set(orders.map((o) => o.person_name)).size);
  const seatCount = orders.length + ghostSeats + (closed ? 0 : 1);

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
              {orders.map((o, i) => (
                <div
                  key={o.id}
                  className={`seat ${o.via_agent ? "agent" : "full"}${
                    flash.has(o.id) ? " flash" : ""
                  }`}
                  style={seatStyle(i, seatCount)}
                >
                  {o.via_agent ? `Agent\n${o.person_name}` : o.person_name}
                </div>
              ))}
              {Array.from({ length: ghostSeats }).map((_, i) => (
                <div
                  key={`g${i}`}
                  className="seat full"
                  style={seatStyle(orders.length + i, seatCount)}
                >
                  同事
                </div>
              ))}
              {!closed ? (
                <div className="seat" style={seatStyle(seatCount - 1, seatCount)}>
                  ＋
                </div>
              ) : null}
            </div>
          )}

          <div className="ledger">
            {orders.map((o) => (
              <div className={`row${flash.has(o.id) ? " new" : ""}`} key={o.id}>
                <div className="name">
                  {o.person_name}
                  {info && o.person_name === info.host_name ? "（桌主）" : ""}
                  {o.via_agent ? <span className="tag">Agent 代點</span> : null}
                </div>
                <div className="amt">{twd(o.amount)}</div>
                {!closed ? <div className="items">{itemsText(o, names)}</div> : null}
              </div>
            ))}
            {orders.length === 0 ? <p className="note">還沒有人點餐。</p> : null}
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

          {!isHost && orders.length < people ? (
            <p className="note">其他人的明細只有桌主看得到。</p>
          ) : null}

          {closed ? (
            <>
              <p className="note" style={{ marginTop: 14 }}>
                各自把錢轉給桌主{info ? ` ${info.host_name}` : ""}。這頁可以截圖丟群組。
              </p>
              <Link to="/" className="btn soy" style={{ textDecoration: "none" }}>
                再開一桌
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
