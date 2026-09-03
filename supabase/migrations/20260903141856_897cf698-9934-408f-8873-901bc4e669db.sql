-- Lock down SECURITY DEFINER functions: no execution for unauthenticated (anon/PUBLIC)
REVOKE ALL ON FUNCTION public.add_order(uuid, text, jsonb, text, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.close_table(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_table_orders(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.purge_test_orders(uuid, text, text) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.add_order(uuid, text, jsonb, text, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.close_table(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_table_orders(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.purge_test_orders(uuid, text, text) TO authenticated, service_role;

-- Internal-only functions must not be callable through the API at all
REVOKE ALL ON FUNCTION public.bump_table_updated() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated;