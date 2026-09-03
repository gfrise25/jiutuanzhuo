import { supabase } from "@/integrations/supabase/client";

let pending: Promise<string> | null = null;

/** 確保有一個 Supabase 匿名 session，回傳 user id。 */
export function ensureAnonSession(): Promise<string> {
  if (!pending) {
    pending = (async () => {
      const { data } = await supabase.auth.getSession();
      if (data.session?.user) return data.session.user.id;

      const { data: signed, error } = await supabase.auth.signInAnonymously();
      if (error) {
        pending = null;
        throw error;
      }
      if (!signed.user) {
        pending = null;
        throw new Error("匿名登入失敗，請重新整理頁面");
      }
      return signed.user.id;
    })();
  }
  return pending;
}
