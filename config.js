// Task Master — local configuration (gitignored — never commit)
//
// Values come from Supabase dashboard:
//   Project Settings → API → Project URL  (SUPABASE_URL)
//   Project Settings → API → anon public  (SUPABASE_ANON_KEY)

window.SUPABASE_URL = "https://hwxmuoxnpgsbqpfopqcz.supabase.co";
window.SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imh3eG11b3hucGdzYnFwZm9wcWN6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYyOTk1NDIsImV4cCI6MjEwMTg3NTU0Mn0.3uuubrk2Z98W3wzOYa5Y2TipCkmwPdkPVVKGa3qymHk";

// Optional override: salt added to the per-user localStorage encryption key
// derivation. Leave empty to use the built-in default.
window.TM_CRYPTO_SALT = "";