create function public.sp_reviewer_request_decide(
  actor_id uuid, uid uuid, choice text, token_hash text
) returns void
language plpgsql set search_path=public as $$
begin
  perform 1 from account_profiles
    where id=actor_id and role='admin' and status='active' for share;
  if not found then
    raise exception 'Administrator access required.' using errcode='PT403';
  end if;

  if (choice is distinct from 'approve' and choice is distinct from 'reject')
    or (choice='approve' and token_hash is null) then
    raise exception 'Invalid reviewer request decision.' using errcode='PT422';
  end if;

  update account_profiles
    set status=case when choice='approve' then 'pending' else 'rejected' end
    where id=uid and role='reviewer' and status='pending_approval';
  if not found then
    raise exception 'This reviewer request is no longer awaiting approval.' using errcode='PT409';
  end if;

  if choice='approve' then
    perform sp_invite_issue(uid, token_hash);
  end if;
  insert into account_audit(actor,account_id,action) values(actor_id,uid,choice);
end $$;

revoke all on function public.sp_reviewer_request_decide(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.sp_reviewer_request_decide(uuid,uuid,text,text) to service_role;
