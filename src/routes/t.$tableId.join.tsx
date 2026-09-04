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
} from "@/lib/group-order";
import { attachJoinBridge } from "@/lib/join-tools";
import { useI18n } from "@/lib/i18n";

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
  const { t } = useI18n();
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

  // 表單真值：ref 為主，避免 React 重新渲染把 agent 剛寫入的值蓋掉
  const nameRef = useRef("");
  const noteRef = useRef("");
  const qtyRef = useRef<Record<number, number>>({});

  function applyName(value: string) {
    nameRef.current = value;
    setName(value);
  }
  function applyNote(value: string) {
    noteRef.current = value;
    setNote(value);
  }
  function applyQty(id: number, value: number) {
    qtyRef.current = { ...qtyRef.current, [id]: value };
    setQty({ ...qtyRef.current });
  }

  const subtotal = useMemo(
    () =>
      (menu.data ?? []).reduce((sum, m) => sum + m.price * (qty[m.id] ?? 0), 0),
    [menu.data, qty],
  );

  const info = table.data?.table;
  const closed = info ? isClosed(info) : false;

  function bump(id: number, delta: number) {
    applyQty(id, Math.max(0, Math.min(20, (qtyRef.current[id] ?? 0) + delta)));
  }

  async function send(opts?: {
    viaAgent?: boolean;
  }): Promise<{ ok: boolean; error?: string; amount?: number | undefined }> {
    const items = Object.entries(qtyRef.current)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => ({ item_id: Number(k), qty: v }));
    if (!nameRef.current.trim()) {
      toast.error(t("join.err.name"));
      return { ok: false, error: "請先填「你的名字」" };
    }
    if (items.length === 0) {
      toast.error(t("join.err.items"));
      return { ok: false, error: "所有品項數量都是 0，至少要點一樣東西" };
    }
    setSending(true);
    try {
      const result = await submitOrder({
        tableId,
        name: nameRef.current.trim(),
        items,
        note: noteRef.current.trim(),
        viaAgent: opts?.viaAgent === true,
      });
      toast.success(t("join.ok"));
      navigate({ to: "/t/$tableId", params: { tableId } });
      return { ok: true, amount: result.amount };
    } catch (e) {
      const msg = e instanceof Error ? e.message : t("join.err.failed");
      toast.error(msg);
      return { ok: false, error: msg };
    } finally {
      setSending(false);
    }
  }

  // ── WebMCP 工具已在 App 載入時註冊（src/lib/join-tools.ts），
  //    這裡只把畫面表單接上去，讓 agent 的操作同步顯示在畫面上。
  useEffect(() => {
    return attachJoinBridge({
      getName: () => nameRef.current,
      getNote: () => noteRef.current,
      getQty: () => qtyRef.current,
      setName: (v) => applyName(v),
      setNote: (v) => applyNote(v),
      setQty: (id, v) => applyQty(id, v),
      afterSubmit: () => {
        toast.success(t("join.okAgent"));
        void navigate({ to: "/t/$tableId", params: { tableId } });
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tableId]);

  return (
    <section className="stage">
      <div className="phone">
        <div className="hd">
          <div className="eyebrow">
            {info ? `${info.name} · ${t("join.host")} ${info.host_name}` : t("join.brand")}
          </div>
          <h1 className="serif">{t("join.title")}</h1>
          {info ? (
            <div style={{ marginTop: 8 }}>
              <span className={`state${closed ? " closed" : ""}`}>
                {closed ? null : <i className="dot" />}
                {closed
                  ? t("join.closed")
                  : t("join.open", { deadline: formatDeadline(info.deadline) })}
              </span>
            </div>
          ) : null}
        </div>

        <div className="body">
          <label htmlFor="me">{t("join.yourName")}</label>
          <input
            id="me"
            value={name}
            onChange={(e) => applyName(e.target.value)}
            placeholder={t("join.yourName.ph")}
            disabled={closed}
          />

          <label>{t("join.pickItems")}</label>
          <div className="menu">
            {(menu.data ?? []).map((m) => (
              <div className="item" key={m.id}>
                <div className="n">{m.name}</div>
                <div className="p">${m.price}</div>
                <div className="qty">
                  <button onClick={() => bump(m.id, -1)} disabled={closed} aria-label={t("join.less")}>
                    −
                  </button>
                  <span>{qty[m.id] ?? 0}</span>
                  <button onClick={() => bump(m.id, 1)} disabled={closed} aria-label={t("join.more")}>
                    +
                  </button>
                </div>
              </div>
            ))}
            {menu.isLoading ? <p className="note">{t("join.menuLoading")}</p> : null}
          </div>

          <label htmlFor="note">{t("join.note")}</label>
          <input
            id="note"
            value={note}
            onChange={(e) => applyNote(e.target.value)}
            placeholder={t("join.note.ph")}
            disabled={closed}
          />
        </div>

        <div className="sticky">
          <div>
            <small style={{ color: "var(--jt-mute)" }}>{t("join.subtotal")}</small>
            <br />
            <b>{twd(subtotal)}</b>
          </div>
          <button className="btn chili" onClick={() => void send()} disabled={sending || closed}>
            {closed ? t("join.closedBtn") : sending ? t("join.submitting") : t("join.submit")}
          </button>
        </div>
      </div>
    </section>
  );
}
