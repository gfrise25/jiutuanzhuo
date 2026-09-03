import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { useAnonSession } from "@/hooks/useAnonSession";
import { supabase } from "@/integrations/supabase/client";
import {
  closeTable,
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
    </section>
  );
}
