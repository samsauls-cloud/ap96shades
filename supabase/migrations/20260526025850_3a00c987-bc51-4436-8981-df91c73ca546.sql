CREATE OR REPLACE FUNCTION public.get_server_date()
 RETURNS date
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT CURRENT_DATE;
$function$;