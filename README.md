# Task Master

A production-grade **schoolwork tracker** for students: tasks, attachments,
recurring assignments, calendar, dashboard analytics, friends, and one-way
help requests — built with plain HTML, CSS, and JavaScript (zero build tools,
zero frameworks) and deployable to any free static host.

- **Auth, friends, help requests, presence & realtime** → Supabase (free tier, via CDN)
- **Tasks & settings** → encrypted `localStorage` (AES-256 via CryptoJS)
- **File attachments** → IndexedDB (5 MB per task, 80% quota warning)
- **Works fully offline**, syncs silently with last-write-wins conflict resolution

---

## What it does

- Add/edit/delete tasks with title, due date, subject (predefined + custom),
  priority (high/medium/low), and attachments (files, links, notes)
- Complete/uncomplete tasks; completed tasks **auto-delete after 7 days**
  (permanent, no recovery); unchecking and re-completing **resets the timer**
- Recurring tasks (daily/weekly/bi-weekly/monthly) with **instance vs. series**
  editing and deletion
- Views: **List**, **Group** (by subject/priority/due/status), **Calendar**
  (month + week), **Dashboard** (completion rate, upcoming 7-day workload,
  overdue count)
- Sorting & filtering by due date, subject, priority, status
- **Templates & quick-add chips** for common homework patterns
- **CSV/JSON export** (includes active + completed tasks inside the 7-day
  window; size/memory guards) and **encrypted local backups**
- **Friends** (mutual acceptance) and **help requests** (multiple friends per
  task, one active request per friend per task, delivery/read status, optional
  reply, offline delivery with online notification)
- In-app + browser notifications for due dates and friend presence
- **Account deletion** that *requires* an encrypted backup download first
- Multi-student friendly: persistent login + explicit logout (one device,
  many students)

---

## Project structure

```
index.html           App shell: auth view, list/group/calendar/dashboard panes,
                     task editor, friends & help modals, notifications, delete flow
style.css            White + blue theme, responsive, priority stripes, calendar grid
script.js            All logic (TM.* modules), no build step
config.example.js    Copy to config.js with your Supabase URL + anon key
config.js            YOUR KEYS (gitignored — never commit)
test.html            Self-contained test harness (mock BaaS + stub DOM)
tests.md             Companion notes for the harness
netlify.toml         Netlify deployment config
vercel.json          Vercel deployment config
package.json         Metadata only (no dependencies)
```

---

## Run locally

1. Download/clone this repo.
2. Copy `config.example.js` → `config.js` and fill in your Supabase URL +
   anon key (see "Supabase setup").
3. Open `index.html` in a browser. That's it — no server, no build, no install.

> Without `config.js` the app runs in **demo mode**: register/log in locally,
> and everything except friends/help/cross-device sync works.

---

## Supabase setup (free tier)

1. Create a project at https://supabase.com (free plan is fine).
2. Open **SQL Editor** and run the schema below.
3. Open **Project Settings → API** and copy **Project URL** and **anon public**
   key into `config.js`.
4. **Database → Realtime**: enable replication for `friends`, `help_requests`,
   `task_sync` (Supabase realtime comes on by default for new projects; if
   tables show `Off`, click the toggle).

### Schema — paste into SQL Editor

```sql
-- Profiles (mirror of auth.users)
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  email text,
  created_at timestamptz default now()
);
alter table public.profiles enable row level security;

-- Friendships: sender sends, recipient accepts -> mutual
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

-- Help requests: one-way clarification, per friend per task
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
-- One active request per friend per task (duplicate prevention at DB level too)
create unique index if not exists help_once_per_friend_task
  on public.help_requests (sender_id, recipient_id, task_id)
  where status in ('sent','delivered','read');

-- Cross-device task sync (last-write-wins)
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

-- Account deletion: removes auth user + cascades profile/friends/help
create or replace function public.delete_own_user() returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from public.profiles where id = auth.uid();
  delete from auth.users where id = auth.uid();
end;
$$;
```

### Row Level Security policies

```sql
-- Profiles: everyone can read (needed for usernames), user edits own
create policy "profiles_select"   on public.profiles for select using (true);
create policy "profiles_insert"   on public.profiles for insert with check (auth.uid() = id);
create policy "profiles_update"   on public.profiles for update using (auth.uid() = id);

-- Trigger keeps profiles in sync when creating the account via UI (optional but recommended)
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username, email)
  values (new.id, coalesce(new.raw_user_meta_data->>'username', 'user_' || substr(new.id::text,1,8)), new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Friends
create policy "friends_visible_to_participants" on public.friends
  for select using (auth.uid() = sender_id or auth.uid() = recipient_id);
create policy "friends_insert_sender" on public.friends
  for insert with check (auth.uid() = sender_id and status = 'pending');
create policy "friends_update_recipient" on public.friends
  for update using (auth.uid() = recipient_id or auth.uid() = sender_id);

-- Help requests
create policy "help_visible_to_participants" on public.help_requests
  for select using (auth.uid() = sender_id or auth.uid() = recipient_id);
create policy "help_insert_sender" on public.help_requests
  for insert with check (auth.uid() = sender_id and status = 'sent');
create policy "help_update_recipient" on public.help_requests
  for update using (auth.uid() = recipient_id);
create policy "help_update_sender" on public.help_requests
  for update using (auth.uid() = sender_id and status in ('sent','delivered','read'));

-- Task sync
create policy "sync_own_rows" on public.task_sync
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

---

## Deploy to a free static host

### Netlify

1. **Drag & drop** the project folder onto https://app.netlify.com/drop
   (zero config — `netlify.toml` is included), **or**
2. Push to GitHub → New site → Import → select repo → Deploy.

### Vercel

1. Push to GitHub.
2. vercel.com → **Add New → Project** → import the repo (static).

### GitHub Pages

1. Push, then Settings → Pages → deploy from `main` branch root.

`config.js` is gitignored — after deploying, create the live version by adding
your keys in the host's dashboard or committing your own `config.js` copy
(anon keys are public by design; RLS protects the data).

---

## Tests

Two layers:

1. **Automated harness** — open `test.html` (or `test.html?run=auto`), click
   **Run tests**. ~70 assertions run the real `script.js` with a mocked
   Supabase client + stub DOM (no network, no setup). See `tests.md` for the
   suite map.
2. **Manual matrix (live BaaS)** — the list below, run against a real Supabase
   project with two browsers:

| # | Scenario | Expected |
| --- | --- | --- |
| 1 | Register account A (browser 1) | Session persists across reload |
| 2 | Register account B (browser 2) | Separate task list from A |
| 3 | Log out of A | B still logged in; A can re-login |
| 4 | Add task with due date + subject + priority | Appears in list/group/calendar/dashboard |
| 5 | Edit task title/subject/priority | Persists after reload |
| 6 | Complete a task | Shows auto-delete countdown; uncheck → timer resets; re-check → fresh timestamp |
| 7 | Set a task's `completedAt` 8 days old (devtools) | Purged on next reload (permanent, no recovery) |
| 8 | Create recurring weekly task (10 occurrences) | Instances generated; horizontal lazily |
| 9 | Edit ONE instance (title) | Other instances unchanged; override survives re-materialize |
| 10 | Edit series (title) | All instances update |
| 11 | Delete one instance vs. whole series | Only instance removed vs. all removed |
| 12 | Sort by due/priority, group by subject/priority/status, filter by status | Ordering/buckets correct |
| 13 | Toggle calendar month ↔ week; navigate prev/next | Tasks rendered by due date; boundary capped at ±1 month/±4 weeks |
| 14 | Use a quick-add template | Task/series created from template; templates manageable |
| 15 | Export CSV & JSON | Active + completed-within-7-days included; purged excluded |
| 16 | Force export above size limit (devtools, small fixture) | Clear error message, no download |
| 17 | Attach file < 5 MB | Stored in IndexedDB, reused after reload |
| 18 | Attach 6 MB file | Rejected with size warning |
| 19 | Fill IndexedDB past 80% | Quota warning toast appears; upload blocked when exceeding |
| 20 | A sends friend request to B | B sees pending; B accepts → mutual friendship |
| 21 | A sends help request for a task to B (and C) | Both rows created; status `sent` |
| 22 | Duplicate help request to B for same task | Blocked (`23505`) + warning |
| 23 | B (offline) later logs in | A's requests flip to `delivered`; B sees them |
| 24 | B opens the request | Flips to `read`; A sees `read` live (realtime) |
| 25 | B replies (optional) | Status `replied`, reply visible to A |
| 26 | B comes online while A has pending request | A gets an active notification + toast |
| 27 | Delete account without backup | Blocked: must download encrypted backup first |
| 28 | Backup downloaded → delete account | Local + IndexedDB + profile + auth user removed everyone logged out |
| 29 | Go offline, edit tasks, go online | Changes sync silently; no toast unless conflict |
| 30 | Edit same task on two devices offline (both newer) | LWW: newest wins; conflict notification once |
| 31 | Due-date reminder | In-app notification that morning; browser notification if enabled |

---

## Edge cases & how they're handled

- **Invalid dates / empty fields** — validated on input; blank titles rejected,
  malformed dates nulled
- **Recurring single-instance vs series** — instance edits store
  `instanceOverrides` (siblings untouched); series edits propagate; deletion
  prompts per scope; overrides survive regeneration
- **7-day purge timer** — resets on re-completion; purge is permanent, runs on
  load, visibility change, and every 10 minutes
- **Attachments** — 5 MB per task enforced at staging *and* at write;
  IndexedDB estimated quota warns at 80% and blocks overflow
- **Export limits** — > 25 MB or heap > 80% aborts with a clear error, no
  download
- **Help duplicates** — client-side pre-check + DB partial unique index
  (server-side backstop) for one active request per friend per task
- **Help to unknown users** — username lookup fails gracefully
- **Offline delivery** — requests persist in Supabase with `sent`; recipient's
  login flips to `delivered`; sender gets an active notification when the
  friend comes online
- **Presence failures** — best-effort; UI never blocks on presence
- **Sync conflicts** — last-write-wins by `updatedAt`; silent merge unless a
  change clashes with an unsynced local edit, then one notification
- **Account deletion** — encrypted backup mandatory; profiles/friends/help
  cascade-delete; `delete_own_user` RPC removes the auth user
- **Demo mode** (no `config.js`) — auth local-only; friends/help/sync politely
  point to README setup

---

## Known limitations

- **Task sharing/co-editing is not supported** — tasks belong to one student.
- **No assignment submission or teacher feedback** — task tracking only.
- **Help requests are clarification-only**, one-way with an optional text
  reply — not chat, not group coordination.
- **No external integrations** — nothing connects to Google Calendar, LMS
  platforms, or email.
- **encrypted localStorage has storage limits** (~5–10 MB before browsers
  evict) — large payloads belong in IndexedDB (attachments). Encryption
  overhead inflates stored size slightly; the app caps notification history at
  200 entries for this reason.
- **Calendar rendering is capped** at the current month ±1 (month view) and
  ±4 weeks (week view) to bound DOM cost.
- **Presence is best-effort** — a friend's status may be stale if their
  browser killed the transport; realtime re-syncs on reconnect.
- **Account hard-delete requires the included `delete_own_user` RPC**; without
  it, local data and the profile row are removed but the auth user remains.
- **Supabase free tier** may throttle realtime channels under heavy use;
  listeners auto-resubscribe.
- **IndexedDB quota** varies by browser/OS — the 80% warning uses
  `navigator.storage.estimate()`.

## Security notes

- Only the **anon (public)** key is shipped — never the service_role key.
- All RLS policies restrict data to the owning user / participants.
- Task data, settings, friend cache, and help cache in `localStorage` are
  AES-256-encrypted with a per-user key derived from the account id + salt.
- Credentials are handled exclusively by Supabase Auth; they never touch
  `localStorage`.

## License

MIT — use it, teach with it, ship it.