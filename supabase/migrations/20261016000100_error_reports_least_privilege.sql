-- error_reports was created while Supabase still granted every new table's privileges to the
-- service role by default, and the grant in its migration added to those rather than replacing
-- them. The backend only ever stores and reads reports, so the service role keeps just that.
revoke all on table public.error_reports from service_role;
grant select, insert on table public.error_reports to service_role;
