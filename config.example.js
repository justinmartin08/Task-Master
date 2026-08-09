// Task Master — configuration template
//
// 1. Copy this file to `config.js` (in the same directory).
// 2. Replace the placeholder values below with your own Supabase project URL
//    and anon (public) key. Find these in your Supabase dashboard:
//       Project Settings → API → Project URL  (SUPABASE_URL)
//       Project Settings → API → anon public (SUPABASE_ANON_KEY)
// 3. config.js is gitignored so your keys never get committed.
//
// SECURITY: Theanon key is *public* by design — it is safe to ship in a static
// site so long as you have configured Row Level Security (RLS) policies on
// every table. See README.md → "Supabase setup". NEVER ship the service_role
// key in this file.

window.SUPABASE_URL = "https://YOUR-PROJECT.supabase.co";
window.SUPABASE_ANON_KEY = "YOUR-ANON-PUBLIC-KEY";

// Optional override: salt added to the per-user localStorage encryption key
// derivation. Leave empty to use the built-in default (a hash of the user id
// combined with the project URL). Changing this after data has been stored
// will make existing encrypted localStorage unreadable — only change before
// first use.
window.TM_CRYPTO_SALT = "";
