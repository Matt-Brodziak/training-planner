# Training Planner: standalone setup

Your planner as a real web app:
- **Firebase Hosting** serves the app, which you can install on your iPhone home screen.
- **Firestore** holds your plans, library, workouts and sleep, and only your Google account can read it.
- **Cloud Functions** pull last night's sleep from your Garmin personal API every morning.

## Where everything goes

Unzip the folder anywhere you keep projects, for example `Documents/training-planner`. Keep the structure exactly as it is:

```
training-planner/
├── README.md                ← this file
├── firebase.json            ← Firebase project config (leave as is)
├── .firebaserc              ← STEP 4: put your Firebase project ID here
├── firestore.rules          ← security rules: only you can see your data
├── firestore.indexes.json
├── .gitignore               ← keeps your .env out of git
├── public/                  ← the app (what Hosting serves)
│   ├── index.html           ← the whole app: Today, Week, Calendar, Dashboard, Library
│   ├── firebase-config.js   ← STEP 4: paste your Firebase web config here
│   ├── manifest.webmanifest ← makes it installable on iPhone
│   └── icon-192.png, icon-512.png, apple-touch-icon.png
└── functions/               ← the backend
    ├── index.js             ← scheduled + "Sync now" Garmin sync (sleep, HRV, resting HR, load)
    ├── garmin.js            ← Garmin Personal API calls
    ├── readiness.js         ← readiness score (pure function) + readiness.test.js
    ├── readinessStore.js    ← computes and caches readiness per day in Firestore
    ├── scripts/seed-emulator.mjs ← fake data for local testing
    ├── test-garmin.mjs      ← optional: test your key locally
    ├── package.json
    └── .env.example         ← STEP 6: copy to .env and paste your user ID
```

**Your Garmin API key never goes in any file.** In step 7 you store it in Google Secret Manager with one command.

## Setup (about 20 minutes)

### 1. Install the tools
- Install **Node.js 22 LTS** from nodejs.org.
- In a terminal, run `npm install -g firebase-tools`, then `firebase login`.

### 2. Create the Firebase project
1. Go to https://console.firebase.google.com and choose **Add project**. Give it a name, for example `matt-training`, and note the **project ID**.
2. Switch the project to the **Blaze (pay-as-you-go)** plan. Cloud Functions and Secret Manager need it. One person's usage sits inside the free allowance, but set a **budget alert** (for example US$3) in the upgrade dialog to be safe.

### 3. Turn on the services
1. **Authentication → Get started → Sign-in method → Google → Enable.**
2. **Firestore Database → Create database → Production mode.** For the location, choose `africa-south1` (Johannesburg) if it's listed, otherwise `europe-west1`. You can't change this later.
3. **Project settings (gear) → General → Your apps → Web (`</>`)**. Register an app called "Training Planner" and **don't** tick Firebase Hosting here. Copy the `firebaseConfig` it shows you.

### 4. Paste your config
- In **`public/firebase-config.js`**, paste the values from step 3.3. Set `authDomain` to **`YOUR-PROJECT-ID.web.app`**, not `firebaseapp.com`, so sign-in works in the iPhone home-screen app.
- In **`.firebaserc`**, replace `YOUR-FIREBASE-PROJECT-ID` with your project ID.

### 5. Deploy the app and sign in
From the `training-planner` folder, run:
```
firebase deploy --only hosting,firestore
```
1. Open `https://YOUR-PROJECT-ID.web.app` and sign in with Google.
2. Tap the **gear icon → Settings → Your user ID → Copy**.

### 6. Tell the backend who you are
- Copy **`functions/.env.example`** to **`functions/.env`** in the same folder.
- Paste your user ID: `OWNER_UID=abc123...`

### 7. Add your Garmin key
1. Create a key at https://connect.garmin.com/app/settings/personalApiToken. Choose the **1 year** expiry, because Garmin only shows the key once.
2. Optionally, check it works first:
   ```
   cd functions
   npm install
   GARMIN_API_KEY="paste-key" node test-garmin.mjs 2026-11-05
   ```
   On Windows PowerShell, use `$env:GARMIN_API_KEY="paste-key"; node test-garmin.mjs 2026-11-05` instead. The test prints the fields Garmin returns and what the Home screen will show.
3. **Store the key as a secret.** This is the only place it goes. Run:
   ```
   firebase functions:secrets:set GARMIN_API_KEY
   ```
   Paste the key when prompted.

### 8. Deploy the backend
```
cd functions && npm install && cd ..
firebase deploy --only functions
```
Then, in the app, go to **Settings → Sync last 30 nights** to backfill your sleep history.

From now on, sleep syncs automatically at **07:15 and 10:15** (SAST). The second run catches mornings when your watch syncs late. The **Sync now** button on Home also works any time.

### 9. Bring over your data from the Claude version
1. In the Claude artifact, go to **Backup → Download .json**.
2. Here, go to **Settings → Restore or add from a backup** and choose that file. Records with the same IDs are replaced and nothing is duplicated.

### 10. Put it on your iPhone
1. Open `https://YOUR-PROJECT-ID.web.app` in **Safari** and tap **Share → Add to Home Screen**.
2. Open it from the home screen and sign in once. The home-screen app keeps its own sign-in, separate from Safari. It opens on **Today**: your readiness score, today's workout and the weather. **Week** has the week's planned volume, sleep and remaining sessions.

## Everyday use
- **Changing the app:** edit `public/index.html`, then run `firebase deploy --only hosting`. Your data is untouched.
- **Changing the backend:** edit the files in `functions/`, then run `firebase deploy --only functions`.
- **When your Garmin key expires:** Garmin emails you about a week before. Create a new key, run `firebase functions:secrets:set GARMIN_API_KEY` again, then **redeploy the functions** (`firebase deploy --only functions`) so they pick up the new value.
- **Weather** comes from Open-Meteo, which needs no key. It uses your phone's location when you allow it, otherwise your home location (Stellenbosch by default; change it in **Settings → Home location**). Forecasts are cached for an hour.

## Readiness score
Worked out once a day after the morning Garmin sync and saved in Firestore (`readiness/{date}`). It mixes five things, each scored 0–100:
last night's sleep score (25%), HRV against your 7-day baseline (25%), resting HR against your 7-day baseline (15%), the average sleep score of the last 3 nights (15%) and acute load, your 7-day load against your 28-day average (20%, best between 0.8 and 1.3).
Load is worked out from the heart-rate zones of your Garmin activities (Edwards TRIMP: minutes in zone 1 × 1 up to zone 5 × 5), because Garmin's own training load isn't available through its Personal API. If there are no Garmin activities in the last 28 days, your planned workout durations are used instead. If something is missing, the others are re-weighted. The scoring lives in `functions/readiness.js`; run its tests with `cd functions && npm test`.

## Trying changes locally (fake data, never your real account)
1. `firebase emulators:start --only auth,firestore,hosting --project demo-training`
2. In another terminal: `cd functions && npm run seed:emu`
3. Open `http://localhost:5000/?emu` and tap **Sign in**.

The `?emu` switch only works on localhost, so the deployed app always uses your real data.

## If something doesn't work
- **Sleep shows "Garmin rejected the API key":** the key expired or was deleted. Repeat step 7.3 and redeploy.
- **Readiness parts show “—”:** HRV and resting HR need at least 3 of the previous 7 days for a baseline, so run **Settings → Sync last 30 nights** once. If they're still blank, Garmin may have renamed a field: run `test-garmin.mjs` and compare with the `FIELD` names in `garmin.js`.
- **Sleep syncs but stages or score are blank:** Garmin doesn't publish its sleep response format, so `garmin.js` reads the usual Garmin Connect field names. Run `test-garmin.mjs` and adjust `normaliseSleep()`, or share the printed field names with Claude.
- **Can't sign in on iPhone:** check that `authDomain` in `firebase-config.js` is `YOUR-PROJECT-ID.web.app`, and that this domain is listed under **Authentication → Settings → Authorized domains**.
- **Function logs:** Firebase console → Functions → Logs, or run `firebase functions:log`.
