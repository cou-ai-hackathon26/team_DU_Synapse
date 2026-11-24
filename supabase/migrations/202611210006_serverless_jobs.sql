create function public.sp_claim_job(jid uuid) returns jsonb
language plpgsql set search_path=public as $$
declare j jobs;
begin
  select q.* into j from jobs q join cases c on c.id=q.case_id
    join case_members m on m.case_id=q.case_id and m.user_id=q.actor
    where q.id=jid and not c.deleting and m.role='reviewer'
    and ((q.state='queued' and q.available_at<=now()) or (q.state='running' and q.lease_until<now()))
    for update of q skip locked;
  if not found then return null; end if;
  update jobs set state='running',lease=gen_random_uuid(),lease_until=now()+interval '3 minutes',
    attempts=attempts+1,error=null where id=jid returning * into j;
  if j.run_id is not null then update verification_runs set status='running' where id=j.run_id; end if;
  return to_jsonb(j);
end $$;

create function public.sp_yield_job(jid uuid,ticket uuid) returns void
language plpgsql set search_path=public as $$
begin
  update jobs set state='queued',lease=null,lease_until=null,available_at=now(),
    attempts=greatest(0,attempts-1)
    where id=jid and state='running' and lease=ticket;
  if not found then raise exception 'Job lease expired' using errcode='PT409'; end if;
end $$;

revoke all on function public.sp_claim_job(uuid), public.sp_yield_job(uuid,uuid) from public, anon, authenticated;
grant execute on function public.sp_claim_job(uuid), public.sp_yield_job(uuid,uuid) to service_role;
