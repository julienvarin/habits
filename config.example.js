// Copy this file to config.js and fill in your credentials.
// config.js is gitignored — your keys stay out of the repo.
window.SUPABASE_URL = "REPLACE_ME_WITH_YOUR_SUPABASE_URL";
window.SUPABASE_ANON_KEY = "REPLACE_ME_WITH_YOUR_ANON_KEY";

// Google Calendar (Morning tab) is no longer configured here: the secret iCal
// URL lives on the Supabase `morning` function as the ICAL_URL secret, so it
// isn't published with the site. See README → "Morning tab function".

// Optional: Discogs integration — Record of the Day (Morning tab).
// Token: discogs.com → Settings → Developers → Generate new token
window.DISCOGS_USERNAME = "REPLACE_ME_WITH_YOUR_DISCOGS_USERNAME";
window.DISCOGS_TOKEN    = "REPLACE_ME_WITH_YOUR_DISCOGS_TOKEN";
