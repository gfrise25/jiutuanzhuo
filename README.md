# 揪團桌 JiuTuanZhuo

**An agent-native group ordering table.** A web app where the page declares its own tools, so a browser agent and a human can do the same things through the same rules.

Built for the OpenAI WebMCP Challenge. Live preview: see the Devpost submission.

---

## The problem

Group food orders in Taiwan live in LINE chats. Someone drops a menu screenshot, twelve people reply in free text, and one person tallies it by hand. The organiser gets the total wrong, misses a "no cilantro", and chases payments individually. The friction is not the ordering — it is the transcription.

The obvious fix is to let an agent do it. The obvious failure mode is letting the agent drive a UI built for humans: it clicks the wrong button, submits twice, and nobody can tell which orders were placed by a person and which by a machine.

## The approach

JiuTuanZhuo is a normal web app that also declares tools to any agent in the page via `navigator.modelContext` (WebMCP). The agent does not scrape the DOM or simulate clicks. It calls the same operations the UI calls, hits the same server-side rules, and every write is attributed.

Three principles the codebase actually follows:

**The frontend is an interface, not a boundary.** Every price, every permission check, every validation is recomputed in Postgres. The browser never decides what an order costs. `add_order` takes item IDs and quantities; the amount comes from `menu_items` on the server. A crafted request cannot buy a $120 order for $1.

**Writes go through functions, not tables.** The `orders` table deliberately has no `INSERT` policy. There is no code path — UI or agent — that inserts an order directly. Everything goes through `add_order`, a `SECURITY DEFINER` function that validates the table is still open, resolves prices, and stamps the caller's `auth.uid()`.

**Agent actions are labelled.** `orders.via_agent` records whether a row came from a tool call or a human tapping a button. The table view renders agent-placed orders differently. When a group order goes wrong, you can see who — or what — placed it.

## Architecture

```
Browser page
├── UI (TanStack Start + React)
└── navigator.modelContext  ──┐
                              ├──► supabase-js (anon key, RLS enforced)
                              │         │
                              │         ▼
                              │   Postgres (Supabase)
                              │   ├── menu_items · tables · orders
                              │   └── SECURITY DEFINER RPCs
                              │       add_order · list_table_orders · close_table
                              └── same functions, same rules, either caller
```

### Data model

| Table | Purpose |
|---|---|
| `menu_items` | The shop's menu. Prices live here and only here. |
| `tables` | One group order. Name, host, deadline, pickup method, open/closed status. |
| `orders` | One person's order on a table. Items as JSONB, note, server-computed amount, `via_agent` flag. |

### Server functions

| Function | Who can call | What it does |
|---|---|---|
| `add_order` | Anyone with a table link | Validates the table is open, resolves prices from `menu_items`, computes the amount, stamps `auth.uid()`. |
| `list_table_orders` | Anyone with a table link | Returns the table plus statistics computed in one pass. Item-level detail is host-only; names and per-person subtotals are visible to everyone at the table. |
| `close_table` | Table host only | Closes the table. Both the host view and the join page go read-only. |

Statistics are deliberately computed in a single function rather than assembled in the browser. An earlier version counted people by distinct `auth.uid()`, which broke the common case of one person ordering for three colleagues on one phone — the fix belongs in the function, where every caller gets it.

### Identity

Supabase anonymous sign-in. Every visitor gets a real `auth.uid()` the moment the page loads, so RLS policies and `SECURITY DEFINER` functions work normally without asking anyone to create an account. The trade-off is deliberate and documented below.

## Running it

```bash
git clone <this repo>
cd jiutuanzhuo
bun install          # or npm install
cp .env.example .env # fill in your own Supabase project values
bun dev
```

You will need a Supabase project with the schema in `supabase/migrations/` applied and **anonymous sign-ins enabled** (Authentication → Sign In / Providers → Allow anonymous sign-ins). Without it the app loads but no one can be identified, and every write is refused.

## Security notes

Written down because an agent-callable surface deserves an explicit threat model, not because all of it is finished.

**In place:**

- Amounts, validation and permission checks are recomputed server-side in every RPC. The client is never trusted with money.
- `orders` has no `INSERT` policy. Writes exist only as function calls.
- Tool descriptions carry function and parameter documentation only — no instructions addressed to the agent. A tool description is not a place to put "always confirm with the user"; that belongs in the calling flow.
- User-generated content (table names, order notes) is returned as structured data fields, never interpolated into anything an agent would read as instruction.
- Agent-placed writes are flagged via `orders.via_agent`.

**Known gaps, deliberately deferred past the hackathon build:**

- **Cross-device identity.** Anonymous sign-in ties identity to a browser. Clear storage or switch phones and you lose your orders. Production wants phone OTP exchanged for a short-lived token; the RLS and RPC layer is already written against `auth.uid()` and would not change.
- **Rate limiting and idempotency.** No per-caller throttle, no idempotency key on `add_order`. A retrying agent can double-order.
- **Audit log.** `via_agent` records that a tool placed an order, not which tool call, with what arguments, at what time.
- **Kill switch.** Write tools should be behind a feature flag that can unregister them without a deploy.
- **CSP.** Third-party scripts on the page are not yet inventoried and no strict Content-Security-Policy is set.

## Stack

TanStack Start · React · TypeScript · Tailwind CSS · shadcn/ui · Supabase (Postgres, Auth, Realtime) · WebMCP via `navigator.modelContext`

Scaffolded and iterated with [Lovable](https://lovable.dev).

---

## 關於這個專案

揪團桌是給「同一件事，人可以做、agent 也可以做，而且走同一套規則」設計的團購工具。

台灣的團購長在 LINE 群裡：有人丟一張菜單截圖，十二個人用自由文字回覆，一個人手動加總，然後算錯金額、漏掉一句「不要香菜」。真正的摩擦不在點餐，在轉抄。

讓 agent 代勞是明顯的解法，明顯的失敗方式則是讓它去操作為人設計的介面——點錯按鈕、送出兩次，事後沒人分得出哪一筆是人點的、哪一筆是機器點的。

所以這裡的做法是：頁面自己宣告工具，agent 呼叫的是 UI 呼叫的同一批函式，撞的是同一套伺服器端規則，每一筆寫入都標記來源。金額一律在 Postgres 算，`orders` 刻意不給 `INSERT` policy，寫入只能走 `add_order`。前端是介面，不是邊界。

授權：MIT。
