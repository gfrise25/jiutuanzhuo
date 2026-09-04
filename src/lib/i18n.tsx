import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type Lang = "zh" | "en";

const STORAGE_KEY = "jt-lang";

type Dict = Record<string, string>;

const zh: Dict = {
  "lang.switch": "EN",
  "lang.label": "切換語言",

  // 開桌頁
  "home.eyebrow": "油庫口蚵仔麵線 · 揪團桌",
  "home.title": "開一桌，大家一起點",
  "home.tableName": "桌名",
  "home.tableName.ph": "業務部 週五午餐",
  "home.hostName": "你的名字（桌主）",
  "home.hostName.ph": "Elsa",
  "home.deadline": "截止時間",
  "home.pickup": "取餐方式",
  "home.pickup.delivery": "店家外送（滿 600 免運）",
  "home.pickup.self": "自取",
  "home.submit": "開桌，拿分享連結",
  "home.submitting": "開桌中…",
  "home.note": "開桌後會產生一條連結，丟進 LINE 群，同事點進去自己填。",
  "home.authError": "匿名登入失敗，請確認 Supabase 已開啟 Anonymous sign-ins。",
  "home.err.required": "桌名和你的名字都要填",
  "home.err.failed": "開桌失敗",
  "day.today": "今天",
  "day.tomorrow": "明天",

  // 加入頁
  "join.title": "加入這桌",
  "join.brand": "揪團桌",
  "join.host": "桌主",
  "join.closed": "已結單，無法再點",
  "join.open": "收單中 · {deadline} 截止",
  "join.yourName": "你的名字",
  "join.yourName.ph": "小陳",
  "join.pickItems": "選餐點",
  "join.menuLoading": "菜單載入中…",
  "join.note": "備註",
  "join.note.ph": "不要香菜",
  "join.subtotal": "我的小計",
  "join.submit": "送出，加入桌上",
  "join.submitting": "送出中…",
  "join.closedBtn": "已結單",
  "join.err.name": "請填你的名字",
  "join.err.items": "至少要點一樣東西",
  "join.ok": "已加入這桌",
  "join.okAgent": "已加入這桌（Agent 代點）",
  "join.err.failed": "送出失敗",
  "join.less": "減少",
  "join.more": "增加",

  // 桌況頁
  "table.brand": "揪團桌",
  "table.closedTitle": "這桌結單了",
  "table.openTitle": "桌上現在有 {n} 個人",
  "table.closedState": "已結單 · 店家已收到",
  "table.openState": "收單中 · {deadline} 截止",
  "table.people": "人",
  "table.portions": "份",
  "table.total": "合計",
  "table.hostTag": "（桌主）",
  "table.agentTag": "Agent 代點",
  "table.empty": "還沒有人點餐。",
  "table.grandTotal": "整桌合計",
  "table.countLine": "{people} 人 · {portions} 份",
  "table.onlyHost": "其他人的明細只有桌主看得到。",
  "table.payNote": "各自把錢轉給桌主{host}。這頁可以截圖丟群組。",
  "table.reopen": "沿用設定，再開一桌",
  "table.reopening": "開桌中…",
  "table.reopenNote": "這桌的紀錄會完整保留，新桌是另一筆資料，截止時間預設兩小時後。",
  "table.newTable": "從頭開一桌",
  "table.copied": "已複製",
  "table.copy": "複製連結",
  "table.joinLink": "我也要點",
  "table.close": "結單",
  "table.closing": "結單中…",
  "table.confirmClose": "確定要結單嗎？結單後就不能再加點。",
  "table.closed.toast": "已結單",
  "table.close.err": "結單失敗",
  "table.reopen.err": "再開一桌失敗",
  "table.reopen.ok": "已開新桌：{name}",
  "table.loadErr": "讀取這一桌失敗",
  "table.unknownItem": "未知品項 #{id}",
  "mcp.toggle": "AI 代點說明（WebMCP）",
  "mcp.ready": "已註冊工具",
  "mcp.unsupported": "此瀏覽器未支援",
  "confirm.cancel": "取消",
  "confirm.ok": "確認",
  "confirm.amount": "金額",
};

const en: Dict = {
  "lang.switch": "中",
  "lang.label": "Switch language",

  "home.eyebrow": "Youkukou Oyster Noodles · Group Table",
  "home.title": "Open a table, order together",
  "home.tableName": "Table name",
  "home.tableName.ph": "Sales team Friday lunch",
  "home.hostName": "Your name (host)",
  "home.hostName.ph": "Elsa",
  "home.deadline": "Cut-off time",
  "home.pickup": "Pickup method",
  "home.pickup.delivery": "Store delivery (free over NT$600)",
  "home.pickup.self": "Self pickup",
  "home.submit": "Open table & get share link",
  "home.submitting": "Creating…",
  "home.note": "You'll get a link to drop in your group chat so everyone can order.",
  "home.authError": "Anonymous sign-in failed. Enable Anonymous sign-ins in Supabase.",
  "home.err.required": "Table name and your name are required",
  "home.err.failed": "Failed to open table",
  "day.today": "Today",
  "day.tomorrow": "Tomorrow",

  "join.title": "Join this table",
  "join.brand": "Group Table",
  "join.host": "Host",
  "join.closed": "Closed — no more orders",
  "join.open": "Open · closes {deadline}",
  "join.yourName": "Your name",
  "join.yourName.ph": "Chris",
  "join.pickItems": "Pick your items",
  "join.menuLoading": "Loading menu…",
  "join.note": "Note",
  "join.note.ph": "No cilantro",
  "join.subtotal": "My subtotal",
  "join.submit": "Submit & join the table",
  "join.submitting": "Sending…",
  "join.closedBtn": "Closed",
  "join.err.name": "Please enter your name",
  "join.err.items": "Pick at least one item",
  "join.ok": "You joined this table",
  "join.okAgent": "Joined this table (ordered by agent)",
  "join.err.failed": "Submit failed",
  "join.less": "Decrease",
  "join.more": "Increase",

  "table.brand": "Group Table",
  "table.closedTitle": "This table is closed",
  "table.openTitle": "{n} people at the table",
  "table.closedState": "Closed · sent to the store",
  "table.openState": "Open · closes {deadline}",
  "table.people": "people",
  "table.portions": "items",
  "table.total": "Total",
  "table.hostTag": " (host)",
  "table.agentTag": "Agent order",
  "table.empty": "No orders yet.",
  "table.grandTotal": "Table total",
  "table.countLine": "{people} people · {portions} items",
  "table.onlyHost": "Only the host can see everyone's details.",
  "table.payNote": "Send your share to the host{host}. Screenshot this page for the group.",
  "table.reopen": "Reopen with same settings",
  "table.reopening": "Creating…",
  "table.reopenNote":
    "This table's records stay intact. The new table is separate and closes in 2 hours by default.",
  "table.newTable": "Start a new table",
  "table.copied": "Copied",
  "table.copy": "Copy link",
  "table.joinLink": "I want to order too",
  "table.close": "Close table",
  "table.closing": "Closing…",
  "table.confirmClose": "Close this table? No more orders after that.",
  "table.closed.toast": "Table closed",
  "table.close.err": "Failed to close table",
  "table.reopen.err": "Failed to reopen",
  "table.reopen.ok": "New table created: {name}",
  "table.loadErr": "Failed to load this table",
  "table.unknownItem": "Unknown item #{id}",
  "mcp.toggle": "AI ordering (WebMCP)",
  "mcp.ready": "Tools registered",
  "mcp.unsupported": "Not supported in this browser",
  "confirm.cancel": "Cancel",
  "confirm.ok": "Confirm",
  "confirm.amount": "Amount",
};

const dicts: Record<Lang, Dict> = { zh, en };

type Ctx = {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
};

const I18nContext = createContext<Ctx | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>("zh");

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "zh" || saved === "en") setLangState(saved);
  }, []);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      window.localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* ignore */
    }
    document.documentElement.lang = l === "zh" ? "zh-Hant-TW" : "en";
  }, []);

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => {
      let s = dicts[lang][key] ?? dicts.zh[key] ?? key;
      if (vars) {
        for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
      }
      return s;
    },
    [lang],
  );

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used inside I18nProvider");
  return ctx;
}

export function LanguageToggle() {
  const { lang, setLang, t } = useI18n();
  return (
    <button
      type="button"
      className="jt-lang-toggle"
      aria-label={t("lang.label")}
      onClick={() => setLang(lang === "zh" ? "en" : "zh")}
    >
      {t("lang.switch")}
    </button>
  );
}
