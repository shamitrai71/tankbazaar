# Engineering Notes — Tankonomics Ecosystem

Patterns, gotchas, and near-misses discovered while building **Tankonomics** (hub),
**TankBazaar** (terminal facility data), **ASTSPARES** (parts catalogue),
**TankProtocol** (emissions calculator), and **TankWorldIndia** (engineering &
equipment directory). Every entry here is something that actually happened —
several are near-misses caught before shipping, one is a real incident that
reached production data. Read this before making bulk edits to any of the five
apps, and especially before writing a script that touches many records at once.

This file should live at the root of each of the five repos. If you fix a new
class of bug, add it here.

---

## 1. Data integrity — bulk edits across many records

### 1.1 A find-and-replace regex can silently cross record boundaries

**What happened:** A script updated 81 companies' Place IDs by matching each
company's slug, then searching forward with a non-greedy `.*?` for that
company's location object. For companies whose formatting didn't match the
expected pattern exactly (multi-line vs. single-line, extra whitespace), the
regex didn't fail — it kept searching *past* that company's own block and
matched the next company down the file that *did* fit the pattern. The first
company's data got silently written onto an unrelated second company.
**22 of 81 companies received another company's Place ID and address** before
this was caught by chance (a data entry looked visibly wrong on the page).

**The fix:** Never let a per-record edit search past that record's own
boundary. Isolate each record's own text first — split the source on the
boundary that starts every record (e.g. `\n  { id:\d+, slug:"` for this
project's JS arrays) — then search-and-replace *only within that isolated
substring*. If the pattern doesn't match inside the isolated block, that's a
loud, visible failure (the record goes on a "missing" list) instead of a
silent leak onto a neighbor.

```python
# WRONG — .*? can walk past the target record if its own text doesn't match
pattern = re.compile(r'(\{ id:\d+, slug:"' + slug + r'".*?)city:"([^"]*)"...')

# RIGHT — isolate the record first, then edit only inside it
parts = re.split(r'(?=\n  \{ id:\d+, slug:")', body)
for i, part in enumerate(parts):
    if part starts with this slug:
        # regex/replace operates on `part` only — cannot reach any other record
```

### 1.2 Never trust a bulk-edit script's own success report

**What happened:** The buggy script above printed `applied: 41, missing: []`
— a **false positive**. It had "succeeded" by matching and editing the wrong
records. The self-reported count was consistent with correctness but did not
prove it.

**The fix:** After any bulk edit, run an **independent audit** that re-parses
the actual resulting file and checks, for every intended target, that the
value is present *inside that specific record's own block* — not just
"present somewhere in the file." For this project that means: split into
per-record blocks the same safe way, then confirm the expected value is a
substring of the record with the matching slug, and *not* a substring of any
other record. Do this even when the edit script claims success.

### 1.3 When something looks wrong, stop and diff against a known-good state

**What happened:** Once the corruption was found, the recovery was not to
patch the 22 wrong records individually (high risk of missing one, or
introducing new mistakes under pressure). Instead: reset to the last file
copy from *before* the bulk edit began, and redo the entire operation with
the corrected, safe method — then re-run the same audit that caught the
original bug to prove the new pass was clean.

**The fix:** Keep a copy of the file before starting any bulk-edit script
that touches many records. If corruption is suspected, restoring to that
copy and redoing the whole operation safely is almost always less risky than
surgically patching individual records on top of an unknown-extent problem.

---

## 2. Field ownership — know which write path is authoritative for each field

### 2.1 A bulk re-seed can silently overwrite fields it doesn't actually own

**What happened (real incident, reached production):** TankWorldIndia's admin
panel has two ways to write a company's `logo` field: (a) the single-file or
batch **upload** flow, which writes a Storage URL directly to Firestore, and
(b) the **"Seed N companies → Firestore"** button, which pushes the in-page
JS array (`SEED_COMPANIES`) to Firestore. The seed payload always included
`logo: c.logo || null` — but the in-page array had *never* carried real logo
URLs (logos only ever lived in Firestore, from path (a)). Every re-seed —
including one run specifically to fix unrelated Place ID data — silently
overwrote every company's real logo back to `null`. All uploaded logos from
two full batch-upload sessions were wiped by a "just re-seed" instruction
that didn't account for this.

**The fix:** For any field with more than one write path, the bulk-seed path
must not blindly overwrite it with a stale or empty default. Either:
- Omit the field from the bulk-write payload entirely when the bulk source
  has no value for it (what was actually done — `...(c.logo ? {logo: c.logo} : {})`
  so the Firestore `updateMask` never touches `logo` unless the seed source
  genuinely has a value), or
- Treat that field as fully owned by its other write path and never include
  it in the bulk payload at all.

**Recovery, when this happens:** If the field's *underlying storage* (e.g.
Storage bucket files) wasn't touched — only the database pointer to it — the
fix is to relist the bucket and re-link each file to its record by filename
or path convention, **without re-uploading anything**. This project added a
"Relink logos from Storage" admin action for exactly this recovery path.

### 2.2 Before recommending "just re-seed," ask what else that seed touches

**The general lesson from 2.1:** any advice of the shape "just re-run the
bulk seed" needs to be checked against *everything* that seed's payload
writes, not just the field you're trying to fix. A seed operation is a full
overwrite of every field in its payload, not a targeted patch.

---

## 3. Deployed file vs. live database — these are two different things

### 3.1 A Hosting deploy updates the file; it does not update Firestore

**What happened, repeatedly:** TankWorldIndia's `CompanyStore.load()` fetches
from Firestore on every page load and *replaces* the in-page fallback array
with whatever Firestore returns, if Firestore has data. This means:
- Editing the in-page seed data and deploying the file changes nothing a
  visitor sees, until someone clicks "Seed N companies → Firestore" — the
  deployed file's new data is invisible until it's explicitly pushed.
- Conversely, once real data lives in Firestore, the in-page array only
  matters as a fallback for when Firestore is empty or unreachable.

This caused real confusion multiple times: a category filter returning zero
results (the *filter logic* was correct — the underlying data in Firestore
simply didn't have the tag yet, because a data-model fix in the seed file had
never been pushed with the seed button). A company page showing stale
address data after a "successful" deploy (same root cause, opposite
direction — Firestore had old data, the new deployed file's fallback was
irrelevant since Firestore wins).

**The fix / mental model:** treat **deploy** and **seed** as two genuinely
separate steps for any app in this ecosystem that uses a Firestore-backed
store with a JS/static fallback:
1. `firebase deploy --only hosting` — ships the new *code and fallback data*.
2. The in-app **Seed** button — pushes that fallback data into the *live
   database* that real visitors actually see.

Step 1 without step 2 means nothing changes for anyone. Always do both when
the change involves seed data, and check the browser console's
`[APPNAME] Firestore · N companies` log line to see which source is actually
being served.

### 3.2 Hosting caches aggressively — a real deploy can still look stale

Even after both steps above, a browser can serve a cached page. Diagnostic
order, cheapest first:
1. Hard refresh (Ctrl+F5), not a normal refresh.
2. Try in a genuinely different browser (not just an incognito window in the
   same browser — a lingering service worker can survive incognito).
3. Bypass the browser entirely and check the server response directly:
   ```powershell
   (Invoke-WebRequest -Uri "https://PROJECT.web.app/" -UseBasicParsing).Content -match "expected text"
   ```
   (`curl` in PowerShell is secretly aliased to `Invoke-WebRequest`, which
   prompts about script execution unless you pass `-UseBasicParsing`.)
4. If the direct HTTP response has the fix but the rendered page doesn't —
   the deploy is fine and the problem is client-side (cache, service worker)
   or is actually the Firestore-vs-deployed-file issue in §3.1, not caching
   at all. Don't assume caching without checking §3.1 first.
5. If a custom domain shows stale data but the raw `*.web.app` URL doesn't,
   the custom domain's edge cache is the lagging layer — it typically clears
   on its own within minutes to an hour.

---

## 4. Firestore rules

### 4.1 A CEL syntax trap that only fails at runtime

```
data.keys().contains('field')     ❌ INVALID — compiles with only a warning, fails at runtime
'field' in data.keys()            ✅ correct
```

The compiler does not hard-error on the wrong form, so this can sit
unnoticed until a rule using it actually runs and rejects a legitimate
write.

### 4.2 A new Firestore collection needs an explicit rule, or it's silently blocked

Every ruleset in this ecosystem has a global deny-all default (`match
/{document=**} { allow read, write: if false }`). Adding a new collection in
code — e.g. Tankonomics' `pageCopy` collection for editable page headers —
does **nothing** for permissions on its own. Without an explicit `match
/collectionName/{id} { allow read...; allow write...; }` block, every read
and write to that collection fails under the deny-all default, and the
failure mode is a permissions error at the exact moment someone tries to use
the new feature — not at deploy time.

**The fix:** whenever a new collection is introduced, add its rule in the
same change, and deploy rules and code together
(`firebase deploy --only firestore:rules` is separate from
`firebase deploy --only hosting` — neither implies the other).

### 4.3 Storage rules are separate from Firestore rules

"Firestore writes work but file uploads fail" is the tell that Storage has
its own, un-deployed ruleset. `storage.rules` needs its own explicit deploy
and its own admin-only / size / content-type constraints — copying
Firestore's rules file does nothing for Storage.

### 4.4 A wrong Firestore database ID returns empty results, not an error

If a project uses a **named** database (e.g. TankBazaar's `"tankbazaar"`,
set via a `FIRESTORE_DB_ID` constant) rather than `"(default)"`, reading with
the wrong ID doesn't throw — it just returns nothing, which looks exactly
like "the collection is empty." Always confirm which database ID a given
app actually uses before assuming empty data means empty data.

---

## 5. Cross-app identity and modeling

### 5.1 Slug is the shared identity key — never change it after seeding

The slug is the Firestore document ID and the join key every other app in
the ecosystem uses to link to a record (Tankonomics ↔ TankBazaar ↔
ASTSPARES ↔ TankWorldIndia). Renaming a company after it's live means the
old document is orphaned and every cross-app link pointing at the old slug
breaks. Renaming is only safe **before** a record has been seeded anywhere.

### 5.2 A subsidiary is a separate legal entity, not a "location" of its parent

Early modeling collapsed foreign subsidiaries into their parent's card as if
they were just another office. This is factually wrong even for a
wholly-owned subsidiary: Protego India Private Limited has its own
incorporation, its own filings, its own liability — it is not a site
belonging to the German parent. The corrected rule: **one card per
separately incorporated legal entity**, with an explicit `parent: { name,
slug, relationship }` field to express the real relationship (subsidiary,
joint-venture, affiliate, owned-by) without merging two real companies into
one record. Ownership is not identity — a majority shareholder (e.g.
Rosneft in Nayara Energy) doesn't make the owned company a location of the
owner either.

The one real exception: a business unit that is **not separately
incorporated** (e.g. "Emerson Automation Solutions" inside Emerson Electric
Co.) is not a company at all and should not get its own card — that one
genuinely does fold into its parent.

### 5.3 A found location's country can conflict with the record's stored country

Global companies sometimes have a legal domicile in one country and their
actual operational hub in another (nVent: UK-domiciled, Minneapolis-run;
Petrofac: India in the roster's country field, global HQ found in Sharjah).
When a location lookup's country doesn't match what's already stored, flag
it for a human decision rather than silently picking one — both "facts" can
be simultaneously true depending on what the field is meant to represent.

---

## 6. Google Places data

### 6.1 The shorthand Maps URL format is unreliable on mobile

```
https://www.google.com/maps/place/?q=place_id:X                                    ❌ can route through generic
                                                                                        search instead of Maps on
                                                                                        some Android configurations
https://www.google.com/maps/search/?api=1&query=NAME&query_place_id=X               ✅ Google's documented Search
                                                                                        Action format; includes a
                                                                                        text fallback alongside the ID
```

A Place ID that is completely valid can still appear to "not resolve" if the
link format doesn't deep-link reliably — verify the underlying Place ID
independently (search by name + address, compare) before assuming stored
data is wrong.

### 6.2 Mainland China has thin Google Places coverage

Repeatedly, searches for real, large Chinese companies returned no result at
all, or a zero-review low-confidence match. This isn't a data quality
problem on our end — treat China-based facilities as "verify with lower
expectations" and prefer leaving a Place ID blank (with the app's
maps-search fallback) over forcing a weak match.

### 6.3 Never silently guess a Place ID match — flag anything uncertain

Several categories of uncertain match came up repeatedly enough to name:
- **Wrong entity, right family** — a search for a subsidiary returns the
  parent's HQ instead (or vice versa). Caught once by cross-checking the
  result's address against the specific entity being searched for.
- **Zero reviews / thin metadata** — a name match with no reviews and a
  vague address is weaker evidence than a name match with hundreds of
  reviews describing the actual business. Apply, but flag for a spot-check.
- **A result that's a different, unrelated business** — a search can return
  a plausible-looking but wrong top result (e.g. a search for a specific
  contractor returning an unrelated tank-cleaning company). Cross-check the
  name in the result against the intended target before applying.

---

## 7. Windows / PowerShell environment notes

- **Dotfiles** (`.gitignore`, `.firebaserc`) cannot be reliably created via
  Windows Explorer — it silently refuses or mangles them. Always create them
  from PowerShell (`Out-File`) or a text editor with "All Files" selected.
- `firebase deploy` without a working `.firebaserc` requires
  `--project <project-id>` on every command. If this keeps being necessary,
  check `Test-Path .firebaserc` — it may never have actually been created.
- **`curl` in PowerShell is an alias for `Invoke-WebRequest`**, not the real
  curl — it prompts about script-execution risk on HTML responses unless you
  pass `-UseBasicParsing`.
- Git's `LF will be replaced by CRLF` warning is cosmetic line-ending
  normalization — harmless, not a sign of a problem.
- Cloud Build (Tankonomics' deploy pipeline) runs on Linux and is
  case-sensitive on file paths and imports, even though local Windows
  development is not — a change that builds locally can still fail in Cloud
  Build over a casing mismatch. Run a full `npm run build` locally after any
  file-casing or import-path change, not just a dev-server check.

---

## 8. Safe patterns worth keeping

Not everything here is a mistake to avoid — some of these are working
patterns worth reusing deliberately:

- **Syntax-check every inline `<script>` block after editing a single-file
  HTML app** (`node --check`) before treating an edit as done. This has
  caught several real bugs (a dropped closing brace, a stray double comma
  creating an array hole) that would otherwise only surface at runtime in
  the browser.
- **Array elisions are a real risk in hand-edited JS arrays.** `[{a}, ,
  {b}]` (a doubled comma) creates a `null` hole that `JSON.stringify` turns
  into a genuine null, silently breaking anything that iterates the array
  and reads a field off each element. Worth a `.filter(Boolean)` as cheap
  insurance on any array assembled by repeated text-append operations, and
  worth checking with `Array.isArray` / length assertions after any
  programmatic edit.
- **A merge-based seed (`setDoc(..., {merge: true})` / an explicit
  `updateMask`) is idempotent and safe to re-run** — re-seeding shouldn't
  duplicate records if the document ID (slug) is stable. The failure mode to
  watch for is not duplication, it's §2's silent-overwrite problem on fields
  the bulk source doesn't actually own.
- **When a person reports "X doesn't work," verify the actual current state
  before proposing a fix** — check the deployed file's content directly
  (`Get-Content` / `Invoke-WebRequest`), not just the description of the
  symptom. Several issues in this project turned out to be "the fix is
  correct but was never actually deployed" or "deployed but not seeded"
  rather than a code defect.
