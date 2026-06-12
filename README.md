# TANK BAZAAR — Global Tank Storage Intelligence

A single-file web platform for tank terminal intelligence: geo-tagged terminal
map, benchmarking, market-share analysis, AIS ship tracking, product-flow
analytics, an admin panel, and a full multi-provider login system.

---

## 1. Deploy to Netlify via GitHub

1. Create a new GitHub repository and upload these files:
   - `index.html`  (the app)
   - `netlify.toml`  (Netlify config)
   - `firestore.rules`  (database security rules)
   - `README.md`
2. On [Netlify](https://app.netlify.com) → **Add new site → Import an existing project**.
3. Pick your GitHub repo. No build command is needed — publish directory is `.`.
4. Deploy. Your site goes live at `https://<your-site>.netlify.app`.

> You can also drag-and-drop the folder onto Netlify, but the GitHub route gives
> you continuous deploys on every push.

---

## 2. Set up Authentication (Google / Apple / Microsoft / Email)

The login system uses **Firebase Authentication** (free tier is plenty).

### a. Create the Firebase project
1. Go to <https://console.firebase.google.com> → **Add project**.
2. Inside the project, **Build → Authentication → Get started**.
3. Under **Sign-in method**, enable each provider you want:
   - **Email/Password** — works immediately.
   - **Google** — one click to enable.
   - **Microsoft** — needs an [Azure app registration](https://portal.azure.com)
     (free); paste its Application (client) ID + secret into Firebase.
   - **Apple** — needs an [Apple Developer account](https://developer.apple.com)
     ($99/yr): create a Services ID + key, paste into Firebase.
4. **Authentication → Settings → Authorized domains** → add your Netlify domain
   (e.g. `tankbazaar.netlify.app`) and any custom domain.

### b. Create the database
1. **Build → Firestore Database → Create database** (Production mode).
2. **Rules** tab → paste the contents of `firestore.rules` → Publish.

### c. Connect the app
1. Firebase **Project settings → General → Your apps → Web app** (`</>`).
2. Copy the `firebaseConfig` object.
3. Open `index.html`, find `FIREBASE_CONFIG` near the top, and paste your values:

```js
const FIREBASE_CONFIG = {
  apiKey: "...",
  authDomain: "your-project.firebaseapp.com",
  projectId: "your-project",
  storageBucket: "your-project.appspot.com",
  messagingSenderId: "...",
  appId: "..."
};
```

4. Set your admin emails just below:

```js
const SUPER_ADMIN_EMAIL = "esraigroup@gmail.com";
const ADMIN_EMAILS = ["esraigroup@gmail.com"];  // add more as needed
```

Commit and push — Netlify redeploys automatically.

> **Without** a Firebase config the site still loads in **Preview Mode**: you can
> browse all the data, but sign-in is disabled.

---

## 3. Roles & access

| Role        | How it's assigned                              | Can do |
|-------------|------------------------------------------------|--------|
| Super Admin | email matches `SUPER_ADMIN_EMAIL`              | Everything, incl. manage admins & security |
| Admin       | email in `ADMIN_EMAILS`, or granted in panel  | Data entry, users, mail, settings |
| Member      | any signed-in user                            | View data, edit own profile |

Roles are evaluated on every login, so adding an email to `ADMIN_EMAILS`
promotes that user the next time they sign in. There are **no hardcoded user
accounts** — every user is a real Firebase account.

---

## 4. Connect live data (optional)

In **Admin → Site Settings → Data & API** you can plug in live endpoints for:
- **Terminals** (JSON array)
- **Ships / AIS** (e.g. a MarineTraffic / aisstream proxy)
- **Product flows** (JSON array)

Until configured, clearly-labeled demo data is shown. Add your **Google Maps API
key** in the same place to switch the main map from OpenStreetMap to Google Maps.

---

## 5. User analytics

Each profile captures: name, company, job title, country, segment, company size,
products & regions of interest, plus auto-tracked sign-up date, login count, and
page views. These power the **Admin → Dashboard** and **User Profiles** analytics.
