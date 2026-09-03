# 揪團桌 Roadmap

- [x] 建立 .env.local（Supabase 金鑰）並重啟 dev server
- [x] WebMCP 註冊層（原生 document.modelContext 優先，無原生時 polyfill）+ window.__jt 除錯入口
- [x] /t/:id/join 註冊 7 個工具（get_table、list_menu_items、set_item_quantity、set_participant_name、set_note、get_current_order、submit_order），卸載時解除
- [ ] Publish 正式站，並由使用者在 Chrome 執行 await document.modelContext.getTools() 驗證
- [ ] 連接 GitHub 並推上倉庫（需使用者在 Lovable + → GitHub → Connect project 授權）
