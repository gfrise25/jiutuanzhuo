import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAnonSession } from "@/hooks/useAnonSession";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "揪團桌 — 油庫口蚵仔麵線團購" },
      {
        name: "description",
        content: "三十秒開一桌油庫口蚵仔麵線團購，分享連結給同事點餐，自動統計品項與金額。",
      },
      { property: "og:title", content: "揪團桌 — 油庫口蚵仔麵線團購" },
      {
        property: "og:description",
        content: "開一桌、丟連結、大家自己點，金額總數自動算好。",
      },
      { property: "og:type", content: "website" },
    ],
  }),
  component: CreateTablePage,
});

function defaultDeadline() {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  d.setSeconds(0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function CreateTablePage() {
  const navigate = useNavigate();
  const { data: uid, isLoading: sessionLoading, error: sessionError } = useAnonSession();

  const [name, setName] = useState("");
  const [hostName, setHostName] = useState("");
  const [deadline, setDeadline] = useState(defaultDeadline);
  const [pickup, setPickup] = useState("外送");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!uid) {
      toast.error("還在準備身分，請稍等一下再試");
      return;
    }
    if (!name.trim() || !hostName.trim()) {
      toast.error("團名和團主名字都要填");
      return;
    }
    const when = new Date(deadline);
    if (Number.isNaN(when.getTime())) {
      toast.error("取餐時間格式怪怪的");
      return;
    }

    setSubmitting(true);
    const { data, error } = await supabase
      .from("tables")
      .insert({
        name: name.trim(),
        host_uid: uid,
        host_name: hostName.trim(),
        deadline: when.toISOString(),
        pickup: pickup.trim() || "外送",
      })
      .select("id")
      .single();
    setSubmitting(false);

    if (error || !data) {
      toast.error(error?.message ?? "開團失敗，請再試一次");
      return;
    }
    toast.success("開團成功！把連結丟到群組吧");
    navigate({ to: "/t/$tableId/host", params: { tableId: data.id } });
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-md flex-col gap-6 px-5 py-8">
      <header className="space-y-2">
        <p className="text-sm font-medium text-primary">油庫口蚵仔麵線</p>
        <h1 className="text-3xl font-bold tracking-tight">揪團桌</h1>
        <p className="text-base text-muted-foreground">
          開一桌、把連結丟到群組，大家自己點，金額自動算。
        </p>
      </header>

      {sessionError ? (
        <p className="rounded-lg bg-destructive/10 p-4 text-base text-destructive">
          身分準備失敗：{(sessionError as Error).message}
        </p>
      ) : null}

      <form onSubmit={handleSubmit} className="space-y-5 rounded-2xl bg-card p-5 shadow-sm">
        <div className="space-y-2">
          <Label htmlFor="table-name" className="text-base">
            團名
          </Label>
          <Input
            id="table-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例：週三下午茶麵線團"
            className="h-12 text-base"
            maxLength={30}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="host-name" className="text-base">
            團主名字
          </Label>
          <Input
            id="host-name"
            value={hostName}
            onChange={(e) => setHostName(e.target.value)}
            placeholder="例：小美"
            className="h-12 text-base"
            maxLength={20}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="deadline" className="text-base">
            取餐時間（同時也是截止時間）
          </Label>
          <Input
            id="deadline"
            type="datetime-local"
            value={deadline}
            onChange={(e) => setDeadline(e.target.value)}
            className="h-12 text-base"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="pickup" className="text-base">
            取餐方式
          </Label>
          <Input
            id="pickup"
            value={pickup}
            onChange={(e) => setPickup(e.target.value)}
            placeholder="外送 / 自取 / 三樓茶水間"
            className="h-12 text-base"
            maxLength={30}
          />
        </div>

        <Button
          type="submit"
          className="h-14 w-full text-lg font-semibold"
          disabled={submitting || sessionLoading}
        >
          {submitting ? "開團中…" : "開一桌"}
        </Button>
      </form>
    </main>
  );
}
