# Renewonomics — Credentials Checklist

This file tracks what still needs to be filled in before the site is fully live.
Items marked ✅ are already done. Items marked ⬜ still need your action.

---

## 1. Netlify Environment Variables ✅ DONE
Set in: **Netlify dashboard → Project configuration → Environment variables**

| Variable | Status |
|---|---|
| `RW_ADMIN_KEY` | ✅ Set |
| `SUPER_ADMIN_EMAIL` | ✅ Set |
| `ADMIN_EMAILS` | Optional — add if you want other admins |

> After any env var change, trigger a manual redeploy from the Netlify dashboard.

---

## 2. Google AdSense Publisher ID ⬜ TODO
All AdSense script tags are currently **commented out** to prevent errors.
Replace `ca-pub-REPLACE_ME_WITH_YOUR_PUBLISHER_ID` with your real Publisher ID,
then uncomment the blocks in each file.

**Files to update:**
- `index.html` — lines 9–11 (uncomment the block)
- `feed.html` — lines 9–11 + `const AD_SLOTS` slot IDs (~line 398)
- `champions.html` — lines 9–11
- `impact.html` — lines 9–11
- `privacy.html` — lines 9–11 + inline ad unit (~line 78)
- `ads.txt` — replace `pub-REPLACE_ME_WITH_YOUR_PUBLISHER_ID`

---

## 3. EmailJS (Welcome Email on Sign-Up) ⬜ TODO
EmailJS is currently **disabled** with a no-op stub — sign-up works fine without it.
To enable welcome emails:

1. Uncomment the `<script src="...emailjs...">` tag in `login.html` (lines 12–15)
2. Replace the stub block with: `emailjs.init('YOUR_REAL_PUBLIC_KEY');`
3. Fill in `EMAILJS_SERVICE_ID` and `EMAILJS_TEMPLATE_ID` (~lines 372–373)

---

## 4. First-Deploy Verification Steps
1. Visit `/admin` → log in with your `SUPER_ADMIN_EMAIL`
2. Go to **Feed Manager → Add RSS Feed** → add a test URL (e.g. `https://electrek.co/feed/`)
3. Click **Test Feed** → should preview articles
4. Click **Save Feed Source** → then **Fetch All Now**
5. Visit `/feed` → articles should appear within seconds
6. Check **Netlify → Functions → fetch-feeds** — should show invocations every 30 min
