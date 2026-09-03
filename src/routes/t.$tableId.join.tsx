import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { useAnonSession } from "@/hooks/useAnonSession";
import {
  fetchMenu,
  fetchTableOrders,
  formatDeadline,
  isClosed,
  submitOrder,
  twd,
} from "@/lib/group-order";

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

  async function send() {
    const items = Object.entries(qty)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => ({ item_id: Number(k), qty: v }));
    if (!name.trim()) return toast.error("請填你的名字");
    if (items.length === 0) return toast.error("至少要點一樣東西");
    setSending(true);
    try {
      await submitOrder({ tableId, name: name.trim(), items, note: note.trim() });
      toast.success("已加入這桌");
      navigate({ to: "/t/$tableId", params: { tableId } });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "送出失敗");
    } finally {
      setSending(false);
    }
  }

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
