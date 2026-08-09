# Task Master — Test Notes (companion to test.html)

The harness in `test.html` is self-contained: it loads the real `script.js` in
test mode (`window.__TM_TEST__ = true`), injects a mock Supabase client and a
stub DOM, then runs ~70 assertions across the suites below.

## Running

- Open `test.html` in a browser, click **Run tests**, or open with `?run=auto`
  to auto-run.
- No server, no build, no npm required. Works from `file://`.

## Suites covered

| Suite | What it verifies |
| --- | --- |
| Crypto & Storage | AES round-trip, wrong-uid returns null, malformed ciphertext returns null, encrypted `localStorage` get/set |
| Auth | Registration validation (blank/invalid email/short password), duplicate registration rejected, login with bad password rejected, missing fields rejected, successful login/logout |
| Tasks CRUD | Upsert/persist/find/remove, blank and invalid titles rejected, invalid due dates nulled, missing-task remove returns false |
| 7-day purge | Completed > 7 days hard-deleted with no recovery, < 7 days survives, unchecking clears `completedAt`, re-completion resets the timer, boundary at exactly 7 days survives |
| Sorting & views | `dueAsc` ordering with no-date last, priority ordering, group buckets (Overdue / No subject), dashboard metrics (total, overdue, completion %, upcoming 7-day) |
| Recurrence | Series materializes instances, single-instance edit isolates (siblings untouched), overrides survive regeneration, series edit propagates to all instances, series delete removes all, instance delete removes one |
| Attachments | 5 MB per-task limit enforced at staging, size accounting, IndexedDB blob put/get/delete round-trip, storage estimate resolves |
| Export | CSV includes active + completed with 7-day window, excludes purged, size guard throws with clear message, encrypted backup succeeds |
| Templates | Defaults seeded, add/remove persist |
| Friends | Request to existing user, duplicate blocked (unique constraint simulation), self-request blocked, unknown user fails gracefully, accept → friendship visible, friend list organized |
| Help requests | Multi-recipient send, duplicate per friend per task blocked, sender sees all rows, recipient delivery (`sent`→`delivered`), read flips to `read`, optional reply flips to `replied` |
| Presence | Channel per friend, simulated online event flips presence, active in-app notification fires when an offline friend with a pending help request comes online |
| Sync (LWW) | Dirty tasks pushed, self-echo ignored, newer remote edit wins silently, conflict case (dirty + newer remote) resolves newest-version and emits a conflict notification |
| Account deletion | Confirm button disabled until encrypted backup downloaded, then enabled; demo-path deletion wipes all local tasks |
| Connectivity | Offline creations persist locally, `syncNow` safe offline |
| Renderers | Calendar month+week include tasks by due date, group view buckets, task item HTML escaping |

## Real-BaaS tests (manual, two browsers)

Covered by the README test matrix: register two accounts (browser A/B), add
each other, send help requests, confirm delivery/read/reply and presence
notifications against the live Supabase project. These cannot run in the
harness because they exercise the actual network + Row Level Security.