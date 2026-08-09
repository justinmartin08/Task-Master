-- ==========================================
-- TASK MASTER SUPABASE COMPLETE SETUP SCRIPT
-- ==========================================

-- 1. PROFILES (mirror of auth.users)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  email text,
  created_at timestamptz default now()
);
alter table public.profiles enable row level security;

-- 2. FRIENDSHIPS
create table if not exists public.friends (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','accepted','declined')),
  created_at timestamptz default now(),
  unique (sender_id, recipient_id),
  check (sender_id <> recipient_id)
);
alter table public.friends enable row level security;

-- 3. HELP REQUESTS
create table if not exists public.help_requests (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  task_id text not null,
  task_title text,
  message text,
  reply text,
  status text not null default 'sent'
    check (status in ('sent','delivered','read','replied')),
  sent_at timestamptz default now(),
  delivered_at timestamptz,
  read_at timestamptz,
  replied_at timestamptz
);
alter table public.help_requests enable row level security;

create unique index if not exists help_once_per_friend_task
  on public.help_requests (sender_id, recipient_id, task_id)
  where status in ('sent','delivered','read');

-- 4. CROSS-DEVICE TASK SYNC
create table if not exists public.task_sync (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  task_id text not null,
  payload jsonb not null,
  cli text,
  updated_at timestamptz default now(),
  unique (user_id, task_id)
);
alter table public.task_sync enable row level security;

-- 5. ACCOUNT DELETION FUNCTION
create or replace function public.delete_own_user() returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from public.profiles where id = auth.uid();
  delete from auth.users where id = auth.uid();
end;
$$;

-- 6. ROW LEVEL SECURITY POLICIES

-- Profiles policies
create policy "profiles_select"   on public.profiles for select using (true);
create policy "profiles_insert"   on public.profiles for insert with check (auth.uid() = id);
create policy "profiles_update"   on public.profiles for update using (auth.uid() = id);

-- Auto-profile creation trigger
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username, email)
  values (new.id, coalesce(new.raw_user_meta_data->>'username', 'user_' || substr(new.id::text,1,8)), new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Friends policies
create policy "friends_visible_to_participants" on public.friends
  for select using (auth.uid() = sender_id or auth.uid() = recipient_id);
create policy "friends_insert_sender" on public.friends
  for insert with check (auth.uid() = sender_id and status = 'pending');
create policy "friends_update_recipient" on public.friends
  for update using (auth.uid() = recipient_id or auth.uid() = sender_id);

-- Help requests policies
create policy "help_visible_to_participants" on public.help_requests
  for select using (auth.uid() = sender_id or auth.uid() = recipient_id);
create policy "help_insert_sender" on public.help_requests
  for insert with check (auth.uid() = sender_id and status = 'sent');
create policy "help_update_recipient" on public.help_requests
  for update using (auth.uid() = recipient_id);
create policy "help_update_sender" on public.help_requests
  for update using (auth.uid() = sender_id and status in ('sent','delivered','read'));

-- Task sync policies
create policy "sync_own_rows" on public.task_sync
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
