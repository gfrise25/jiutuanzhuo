import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Copy } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useAnonSession } from "@/hooks/useAnonSession";
import { supabase } from "@/integrations/supabase/client";
import {
  closeTable,
  fetchMenu,
  fetchTableOrders,
  formatDeadline,
  isClosed,
  twd,
} from "@/lib/group-order";

export const Route = createFileRoute("/t/$tableId/host")({
  head: () => ({
    meta: [
      { title: "團主看板 — 揪團桌" },
      { name: "description", content: "看每個人點了什麼、各品項總數與總金額，一鍵關團結帳。" },
      { property: "og:title", content: "團主看板 — 揪團桌" },
      { property: "og:description", content: "即時彙整這桌麵線團購的訂單與金額。" },
      { property: "og:type", content: "website" },
    ],
  }),
  component: HostBoardPage,
});

function HostBoardPage() {
  const { tableId } = Route.useParams();
  const queryClient = useQueryClient();
  const { data: uid } = useAnonSession();
  const [copied, setCopied] = useState(false);
  const [closing, setClosing] = useState(false);

  const tableQuery = useQuery({
    queryKey: ["table-orders", tableId],
    queryFn: () => fetchTableOrders(tableId),
    enabled: Boolean(uid),
  });
  const menuQuery = useQuery({ queryKey: ["menu"], queryFn: fetchMenu, enabled: Boolean(uid) });

  useEffect(() => {
    const channel = supabase
      .channel(`orders-${tableId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "orders", filter: `table_id=eq.${tableId}` },
        () => {
          queryClient.invalidateQueries({ queryKey: ["table-orders", tableId] });
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [tableId, queryClient]);

  const data = tableQuery.data;
  const menu = menuQuery.data ?? [];
  const itemName = useMemo(() => Object.fromEntries(menu.map((m) => [m.id, m.name])), [menu]);

  const orders = data && data.is_host ? data.orders : [];
  const closed = data ? isClosed(data.table) : false;

  const itemTotals = useMemo(() => {
    const map = new Map<number, number>();
    for (const o of orders) {
      for (const i of o.items) map.set(i.item_id, (map.get(i.item_id) ?? 0) + i.qty);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [orders]);

  const shareUrl = typeof window === "undefined" ? "" : `${window.location.origin}/t/${tableId}`;

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      toast.success("參加連結已複製");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("複製失敗，請長按網址手動複製");
    }
  }

  async function handleClose() {
    setClosing(true);
    try {
      await closeTable(tableId);
      toast.success("已關團，這桌不能再加點了");
      await queryClient.invalidateQueries({ queryKey: ["table-orders", tableId] });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setClosing(false);
    }
  }

  if (tableQuery.error) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 px-5 text-center">
        <h1 className="text-2xl font-bold">打不開這一桌</h1>
        <p className="text-base text-muted-foreground">{(tableQuery.error as Error).message}</p>
        <Link to="/" className="text-base font-medium text-primary underline">
          回首頁開一桌
        </Link>
      </main>
    );
  }

  if (data && !data.is_host) {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 px-5 text-center">
        <h1 className="text-2xl font-bold">你不是這桌的團主</h1>
        <Link
          to="/t/$tableId"
          params={{ tableId }}
          className="text-base font-medium text-primary underline"
        >
          去點餐頁
        </Link>
      </main>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-5 px-5 py-8">
      <header className="space-y-1">
        <p className="text-sm font-medium text-primary">團主看板</p>
        <h1 className="text-2xl font-bold tracking-tight">{data?.table.name ?? "載入中…"}</h1>
        {data ? (
          <p className="text-base text-muted-foreground">
            {data.table.pickup}・取餐 {formatDeadline(data.table.deadline)}
          </p>
        ) : null}
      </header>

      <section className="space-y-3 rounded-2xl bg-card p-5 shadow-sm">
        <h2 className="text-lg font-semibold">參加連結</h2>
        <p className="break-all rounded-lg bg-muted p-3 text-base">{shareUrl}</p>
        <Button variant="outline" className="h-12 w-full text-base" onClick={copyLink}>
          {copied ? <Check className="size-5" /> : <Copy className="size-5" />}
          {copied ? "已複製" : "複製連結"}
        </Button>
      </section>

      {closed ? (
        <p className="rounded-xl bg-destructive/10 p-4 text-base font-medium text-destructive">
          這桌已關團，看板為唯讀狀態。
        </p>
      ) : null}

      <section className="grid grid-cols-2 gap-3">
        <div className="rounded-2xl bg-card p-5 text-center shadow-sm">
          <p className="text-sm text-muted-foreground">總金額</p>
          <p className="text-2xl font-bold tabular-nums">{twd(data?.total ?? 0)}</p>
        </div>
        <div className="rounded-2xl bg-card p-5 text-center shadow-sm">
          <p className="text-sm text-muted-foreground">參加人數</p>
          <p className="text-2xl font-bold tabular-nums">{data?.people_count ?? 0}</p>
        </div>
      </section>

      <section className="space-y-2 rounded-2xl bg-card p-5 shadow-sm">
        <h2 className="text-lg font-semibold">品項總數</h2>
        {itemTotals.length === 0 ? (
          <p className="text-base text-muted-foreground">還沒有人點餐。</p>
        ) : (
          itemTotals.map(([id, qty]) => (
            <div key={id} className="flex items-center justify-between py-2 text-base">
              <span>{itemName[id] ?? `#${id}`}</span>
              <span className="font-semibold tabular-nums">× {qty}</span>
            </div>
          ))
        )}
      </section>

      <section className="space-y-3 rounded-2xl bg-card p-5 shadow-sm">
        <h2 className="text-lg font-semibold">每個人點了什麼</h2>
        {orders.length === 0 ? (
          <p className="text-base text-muted-foreground">還沒有訂單。</p>
        ) : (
          orders.map((o) => (
            <div key={o.id} className="border-b border-border py-3 last:border-b-0">
              <div className="flex items-center justify-between">
                <span className="text-base font-medium">{o.person_name}</span>
                <span className="text-base font-semibold tabular-nums">{twd(o.amount)}</span>
              </div>
              <p className="text-base text-muted-foreground">
                {o.items
                  .map((i) => `${itemName[i.item_id] ?? `#${i.item_id}`} × ${i.qty}`)
                  .join("、")}
              </p>
              {o.note ? <p className="text-sm text-muted-foreground">備註：{o.note}</p> : null}
            </div>
          ))
        )}
      </section>

      {!closed ? (
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive" className="h-14 w-full text-lg font-semibold" disabled={closing}>
              {closing ? "處理中…" : "關團結帳"}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>確定要關團嗎？</AlertDialogTitle>
              <AlertDialogDescription>
                關團後大家就不能再加點了，目前共 {data?.people_count ?? 0} 人、
                {twd(data?.total ?? 0)}。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>再等等</AlertDialogCancel>
              <AlertDialogAction onClick={handleClose}>確定關團</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </main>
  );
}
