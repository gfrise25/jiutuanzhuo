import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Minus, Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAnonSession } from "@/hooks/useAnonSession";
import {
  fetchMenu,
  fetchTableOrders,
  formatDeadline,
  isClosed,
  submitOrder,
  twd,
  type OrderItem,
} from "@/lib/group-order";

export const Route = createFileRoute("/t/$tableId/")({
  head: () => ({
    meta: [
      { title: "我要點餐 — 揪團桌" },
      { name: "description", content: "選你的油庫口蚵仔麵線品項與數量，直接加入這一桌團購。" },
      { property: "og:title", content: "我要點餐 — 揪團桌" },
      { property: "og:description", content: "選品項、填數量，一鍵加入這桌麵線團購。" },
      { property: "og:type", content: "website" },
    ],
  }),
  component: JoinTablePage,
});

function JoinTablePage() {
  const { tableId } = Route.useParams();
  const queryClient = useQueryClient();
  const { data: uid } = useAnonSession();

  const [personName, setPersonName] = useState("");
  const [note, setNote] = useState("");
  const [qtys, setQtys] = useState<Record<number, number>>({});
  const [submitting, setSubmitting] = useState(false);

  const menuQuery = useQuery({
    queryKey: ["menu"],
    queryFn: fetchMenu,
    enabled: Boolean(uid),
  });

  const tableQuery = useQuery({
    queryKey: ["table-orders", tableId],
    queryFn: () => fetchTableOrders(tableId),
    enabled: Boolean(uid),
  });

  const menu = menuQuery.data ?? [];
  const data = tableQuery.data;
  const closed = data ? isClosed(data.table) : false;
  const myOrders = data && data.is_host === false ? data.my_orders : [];

  const itemName = useMemo(
    () => Object.fromEntries(menu.map((m) => [m.id, m.name])),
    [menu],
  );

  const total = useMemo(
    () => menu.reduce((sum, m) => sum + m.price * (qtys[m.id] ?? 0), 0),
    [menu, qtys],
  );

  function bump(id: number, delta: number) {
    setQtys((prev) => {
      const next = Math.min(20, Math.max(0, (prev[id] ?? 0) + delta));
      return { ...prev, [id]: next };
    });
  }

  async function handleSubmit() {
    const items: OrderItem[] = menu
      .filter((m) => (qtys[m.id] ?? 0) > 0)
      .map((m) => ({ item_id: m.id, qty: qtys[m.id] }));

    if (!personName.trim()) {
      toast.error("先填你的名字");
      return;
    }
    if (items.length === 0) {
      toast.error("至少要點一樣東西");
      return;
    }

    setSubmitting(true);
    try {
      const res = await submitOrder({
        tableId,
        name: personName.trim(),
        items,
        note: note.trim(),
      });
      toast.success(`已加入，這單 ${twd(res.amount ?? total)}`);
      setQtys({});
      setNote("");
      await queryClient.invalidateQueries({ queryKey: ["table-orders", tableId] });
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSubmitting(false);
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

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-5 px-5 py-8">
      <header className="space-y-1">
        <p className="text-sm font-medium text-primary">油庫口蚵仔麵線</p>
        <h1 className="text-2xl font-bold tracking-tight">
          {data?.table.name ?? "載入中…"}
        </h1>
        {data ? (
          <p className="text-base text-muted-foreground">
            團主 {data.table.host_name}・{data.table.pickup}・取餐 {formatDeadline(data.table.deadline)}
          </p>
        ) : null}
      </header>

      {closed ? (
        <p className="rounded-xl bg-destructive/10 p-4 text-base font-medium text-destructive">
          這桌已經截止，不能再加點了。
        </p>
      ) : null}

      <section className="space-y-3 rounded-2xl bg-card p-5 shadow-sm">
        <h2 className="text-lg font-semibold">菜單</h2>
        {menu.map((m) => (
          <div key={m.id} className="flex items-center justify-between gap-3 border-b border-border py-3 last:border-b-0">
            <div>
              <p className="text-base font-medium">{m.name}</p>
              <p className="text-sm text-muted-foreground">{twd(m.price)}</p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-11"
                aria-label={`減少 ${m.name}`}
                disabled={closed || (qtys[m.id] ?? 0) === 0}
                onClick={() => bump(m.id, -1)}
              >
                <Minus className="size-5" />
              </Button>
              <span className="w-8 text-center text-lg font-semibold tabular-nums">
                {qtys[m.id] ?? 0}
              </span>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-11"
                aria-label={`增加 ${m.name}`}
                disabled={closed}
                onClick={() => bump(m.id, 1)}
              >
                <Plus className="size-5" />
              </Button>
            </div>
          </div>
        ))}
        {menuQuery.isLoading ? <p className="text-base text-muted-foreground">菜單載入中…</p> : null}
      </section>

      <section className="space-y-4 rounded-2xl bg-card p-5 shadow-sm">
        <div className="space-y-2">
          <Label htmlFor="person" className="text-base">
            你的名字
          </Label>
          <Input
            id="person"
            value={personName}
            onChange={(e) => setPersonName(e.target.value)}
            placeholder="例：阿宏"
            maxLength={20}
            className="h-12 text-base"
            disabled={closed}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="note" className="text-base">
            備註（可不填）
          </Label>
          <Textarea
            id="note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="不要香菜、多辣…"
            maxLength={50}
            className="min-h-20 text-base"
            disabled={closed}
          />
        </div>
        <div className="flex items-center justify-between text-lg font-semibold">
          <span>這單金額</span>
          <span className="tabular-nums">{twd(total)}</span>
        </div>
        <Button
          className="h-14 w-full text-lg font-semibold"
          disabled={closed || submitting}
          onClick={handleSubmit}
        >
          {submitting ? "送出中…" : "送出我的餐點"}
        </Button>
      </section>

      <section className="space-y-3 rounded-2xl bg-card p-5 shadow-sm">
        <h2 className="text-lg font-semibold">我的訂單</h2>
        {myOrders.length === 0 ? (
          <p className="text-base text-muted-foreground">你還沒點東西。</p>
        ) : (
          myOrders.map((o) => (
            <div key={o.id} className="border-b border-border py-3 last:border-b-0">
              <div className="flex items-center justify-between">
                <span className="text-base font-medium">{o.person_name}</span>
                <span className="text-base font-semibold tabular-nums">{twd(o.amount)}</span>
              </div>
              <p className="text-base text-muted-foreground">
                {o.items.map((i) => `${itemName[i.item_id] ?? `#${i.item_id}`} × ${i.qty}`).join("、")}
              </p>
              {o.note ? <p className="text-sm text-muted-foreground">備註：{o.note}</p> : null}
            </div>
          ))
        )}
      </section>
    </main>
  );
}
