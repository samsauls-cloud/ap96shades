alter table public.vendor_credits
  add column if not exists reference text;
comment on column public.vendor_credits.reference is
  'Vendor-issued document number backing this entry: RA #, credit memo #, payment/remittance doc #.';

alter table public.vendor_credits
  add column if not exists reversed_credit_id uuid references public.vendor_credits(id);
comment on column public.vendor_credits.reversed_credit_id is
  'When this row voids a prior vendor_credits row, points to it. Used to prevent double-voids and badge originals as Reversed.';

create index if not exists vendor_credits_reversed_credit_idx
  on public.vendor_credits(reversed_credit_id)
  where reversed_credit_id is not null;

create or replace view public.vendor_credit_balances as
with alias_lookup as (
  select lower(trim(vendor_name)) as alias, vendor_id, vendor_name
    from public.vendor_alias_map
  union
  select lower(trim(a)) as alias, vendor_id, vendor_name
    from public.vendor_alias_map, unnest(aliases) a
),
keyed as (
  select vc.*,
         coalesce(al.vendor_id, lower(trim(vc.vendor))) as vendor_key,
         coalesce(al.vendor_name, vc.vendor)            as canonical_name
  from public.vendor_credits vc
  left join alias_lookup al on al.alias = lower(trim(vc.vendor))
)
select vendor_key,
       min(canonical_name)                              as vendor_name,
       coalesce(sum(amount), 0)::numeric(12,2)          as balance,
       max(occurred_on)                                 as last_activity_on,
       count(*)::int                                    as ledger_entries
from keyed
group by vendor_key;

grant select on public.vendor_credit_balances to anon, authenticated;