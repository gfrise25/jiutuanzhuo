import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import { useAnonSession } from "@/hooks/useAnonSession";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "揪團桌 — 開一桌，大家一起點" },
      {
        name: "description",
        content: "油庫口蚵仔麵線的團購工具：開一桌、丟連結進群組，同事各自點餐，桌況即時更新。",
      },
      { property: "og:title", content: "揪團桌 — 開一桌，大家一起點" },
      {
        property: "og:description",
        content: "開一桌、丟連結進群組，同事各自點餐，桌況即時更新。",
      },
      { property: "og:type", content: "website" },
    ],
  }),
  component: OpenTablePage,
});

/** 產生今天幾個常見的截止時間選項 */
function deadlineOptions() {
  const out: { value: string; label: string }[] = [];
  const now = new Date();
  for (const [h, m] of [
    [11, 0],
    [11, 30],
    [12, 0],
    [12, 30],
    [17, 30],
    [18, 0],
  ] as const) {
    const d = new Date(now);
    d.setHours(h, m, 0, 0);
    if (d.getTime() < now.getTime()) d.setDate(d.getDate() + 1);
    const day = d.toDateString() === now.toDateString() ? "今天" : "明天";
    out.push({
      value: d.toISOString(),
      label: `${day} ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`,
    });
  }
  return out.sort((a, b) => a.value.localeCompare(b.value));
}

function OpenTablePage() {
  const navigate = useNavigate();
  const session = useAnonSession();
  const options = deadlineOptions();

  const [name, setName] = useState("");
  const [hostName, setHostName] = useState("");
  const [deadline, setDeadline] = useState(options[0]!.value);
  const [pickup, setPickup] = useState("店家外送（滿 600 免運）");
  const [saving, setSaving] = useState(false);

  async function submit() {
    if (!name.trim() || !hostName.trim()) {
      toast.error("桌名和你的名字都要填");
      return;
    }
    setSaving(true);
    try {
      const uid = session.data ?? (await import("@/lib/session")).ensureAnonSession();
      const hostUid = typeof uid === "string" ? uid : await uid;
      const { data, error } = await supabase
        .from("tables")
        .insert({
          name: name.trim(),
          host_uid: hostUid,
          host_name: hostName.trim(),
          deadline,
          pickup,
        })
        .select("id")
        .single();
      if (error) throw new Error(error.message);
      navigate({ to: "/t/$tableId", params: { tableId: data.id } });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "開桌失敗");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="stage">
      <div className="phone">
        <div className="hd">
          <div className="eyebrow">油庫口蚵仔麵線 · 揪團桌</div>
          <h1 className="serif">開一桌，大家一起點</h1>
        </div>
        <div className="body">
          <label htmlFor="tname">桌名</label>
          <input
            id="tname"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="業務部 週五午餐"
          />

          <label htmlFor="hname">你的名字（桌主）</label>
          <input
            id="hname"
            value={hostName}
            onChange={(e) => setHostName(e.target.value)}
            placeholder="Elsa"
          />

          <label htmlFor="dl">截止時間</label>
          <select id="dl" value={deadline} onChange={(e) => setDeadline(e.target.value)}>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>

          <label htmlFor="pk">取餐方式</label>
          <select id="pk" value={pickup} onChange={(e) => setPickup(e.target.value)}>
            <option>店家外送（滿 600 免運）</option>
            <option>自取</option>
          </select>

          <button
            className="btn chili"
            onClick={submit}
            disabled={saving || session.isLoading}
          >
            {saving ? "開桌中…" : "開桌，拿分享連結"}
          </button>
          <p className="note">開桌後會產生一條連結，丟進 LINE 群，同事點進去自己填。</p>
          {session.isError ? (
            <p className="note" style={{ color: "var(--jt-chili)" }}>
              匿名登入失敗，請確認 Supabase 已開啟 Anonymous sign-ins。
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
