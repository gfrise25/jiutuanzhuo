import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { useAnonSession } from "@/hooks/useAnonSession";
import { supabase } from "@/integrations/supabase/client";
import { fetchMenu } from "@/lib/group-order";
import { isWebMcpAvailable, registerWebMcpTool } from "@/lib/webmcp";
import { useI18n } from "@/lib/i18n";

export const Route = createFileRoute("/")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "揪團桌 — 開一桌，大家一起點（OpenAI WebMCP 比賽作品）" },
      {
        name: "description",
        content:
          "油庫口蚵仔麵線的團購工具：開一桌、丟連結進群組，同事各自點餐，桌況即時更新。這是參加 OpenAI WebMCP 的比賽網站。",
      },
      {
        property: "og:title",
        content: "揪團桌 — 開一桌，大家一起點（OpenAI WebMCP 比賽作品）",
      },
      {
        property: "og:description",
        content:
          "油庫口蚵仔麵線的團購工具：開一桌、丟連結進群組，同事各自點餐，桌況即時更新。這是參加 OpenAI WebMCP 的比賽網站。",
      },
      { property: "og:type", content: "website" },
    ],
  }),
  component: OpenTablePage,
});

/** 產生今天幾個常見的截止時間選項 */
function deadlineOptions(todayLabel: string, tomorrowLabel: string) {
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
    const day = d.toDateString() === now.toDateString() ? todayLabel : tomorrowLabel;
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
  const { t } = useI18n();
  const options = deadlineOptions(t("day.today"), t("day.tomorrow"));

  const [name, setName] = useState("");
  const [hostName, setHostName] = useState("");
  const [deadline, setDeadline] = useState(options[0]!.value);
  const [pickup, setPickup] = useState("店家外送（滿 600 免運）");
  const [saving, setSaving] = useState(false);
  const [confirmBox, setConfirmBox] = useState<{
    title: string;
    lines: string[];
    resolve: (ok: boolean) => void;
  } | null>(null);

  const askRef = useRef((title: string, lines: string[]) =>
    new Promise<boolean>((resolve) => setConfirmBox({ title, lines, resolve })),
  );
  const sessionRef = useRef(session.data);
  sessionRef.current = session.data;

  // ── 開桌頁的 WebMCP 工具 ───────────────────────────
  useEffect(() => {
    if (!isWebMcpAvailable()) {
      console.info("[揪團桌] 這個瀏覽器沒有 document.modelContext，略過 WebMCP 工具註冊。");
      return;
    }
    const disposers: Array<(() => void) | null> = [];

    disposers.push(
      registerWebMcpTool({
        name: "get_menu",
        description: "讀取目前可點的菜單品項，回傳 id、名稱、價格。加點時的 item_id 由這裡取得。",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true },
        execute: async () => {
          const menu = await fetchMenu();
          return {
            ok: true,
            menu: menu.map((m) => ({ id: m.id, name: m.name, price: m.price })),
          };
        },
      }),
    );

    disposers.push(
      registerWebMcpTool({
        name: "create_table",
        description:
          "在揪團桌開一桌並前往桌況頁。參數：table_name（桌名）、host_name（桌主名字）、deadline（截止時間 ISO 字串，可省略，預設下一個時段）、pickup（取餐方式，可省略）。",
        inputSchema: {
          type: "object",
          properties: {
            table_name: { type: "string" },
            host_name: { type: "string" },
            deadline: { type: "string" },
            pickup: { type: "string" },
          },
          required: ["table_name", "host_name"],
          additionalProperties: false,
        },
        execute: async (raw) => {
          const args = (raw ?? {}) as {
            table_name?: string;
            host_name?: string;
            deadline?: string;
            pickup?: string;
          };
          const tableName = (args.table_name ?? "").trim();
          const host = (args.host_name ?? "").trim();
          if (!tableName || !host) {
            return { ok: false, error: "缺少 table_name 或 host_name" };
          }
          const dl = args.deadline && !Number.isNaN(Date.parse(args.deadline))
            ? new Date(args.deadline).toISOString()
            : options[0]!.value;
          const pk = (args.pickup ?? "店家外送（滿 600 免運）").trim();
          const ok = await askRef.current("要開一桌嗎？", [
            `桌名：${tableName}`,
            `桌主：${host}`,
            `截止：${new Date(dl).toLocaleString("zh-TW")}`,
            `取餐：${pk}`,
          ]);
          if (!ok) return { ok: false, error: "使用者取消" };
          try {
            const uid =
              sessionRef.current ?? (await (await import("@/lib/session")).ensureAnonSession());
            const { data, error } = await supabase
              .from("tables")
              .insert({
                name: tableName,
                host_uid: uid,
                host_name: host,
                deadline: dl,
                pickup: pk,
              })
              .select("id")
              .single();
            if (error) throw new Error(error.message);
            navigate({ to: "/t/$tableId", params: { tableId: data.id } });
            return {
              ok: true,
              table_id: data.id,
              share_url:
                typeof window !== "undefined"
                  ? `${window.location.origin}/t/${data.id}/join`
                  : null,
              user_content: { table_name: tableName, host_name: host },
            };
          } catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : "開桌失敗" };
          }
        },
      }),
    );

    return () => disposers.forEach((d) => d?.());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit() {
    if (!name.trim() || !hostName.trim()) {
      toast.error(t("home.err.required"));
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
      toast.error(e instanceof Error ? e.message : t("home.err.failed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="stage">
      <div className="phone">
        <div className="hd">
          <div className="eyebrow">{t("home.eyebrow")}</div>
          <h1 className="serif">{t("home.title")}</h1>
        </div>
        <div className="body">
          <label htmlFor="tname">{t("home.tableName")}</label>
          <input
            id="tname"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("home.tableName.ph")}
          />

          <label htmlFor="hname">{t("home.hostName")}</label>
          <input
            id="hname"
            value={hostName}
            onChange={(e) => setHostName(e.target.value)}
            placeholder={t("home.hostName.ph")}
          />

          <label htmlFor="dl">{t("home.deadline")}</label>
          <select id="dl" value={deadline} onChange={(e) => setDeadline(e.target.value)}>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>

          <label htmlFor="pk">{t("home.pickup")}</label>
          <select id="pk" value={pickup} onChange={(e) => setPickup(e.target.value)}>
            <option value="店家外送（滿 600 免運）">{t("home.pickup.delivery")}</option>
            <option value="自取">{t("home.pickup.self")}</option>
          </select>

          <button
            className="btn chili"
            onClick={submit}
            disabled={saving || session.isLoading}
          >
            {saving ? t("home.submitting") : t("home.submit")}
          </button>
          <p className="note">{t("home.note")}</p>
          {session.isError ? (
            <p className="note" style={{ color: "var(--jt-chili)" }}>
              {t("home.authError")}
            </p>
          ) : null}
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
