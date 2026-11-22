# Documentary photo upload: Pastor Dr. Martin Appiah

**The Church of Pentecost, Jesse Port Elizabeth Assembly**

A simple page where church members upload photos for the pastor's documentary. Every photo goes straight into one private Google Drive folder. Visitors don't sign in or give their name. They choose photos and press upload.

- **Laptop:** drag and drop, or browse.
- **Phone:** choose from the gallery, or take a photo of a printed picture.
- Many people can upload at the same time, and each person can send hundreds of photos at once (3 upload in parallel, with automatic retries).
- Hosted on Vercel (free plan is fine). No database. No third-party libraries.

---

## How it works

```
Visitor's phone/laptop ──(1) "I want to upload 12 photos"──▶ Vercel API (holds the Google key)
                       ◀─(2) one-time upload link per photo─┘        │
        │                                                           └─ creates each file in the Drive folder
        └──(3) sends the photo itself straight to Google Drive ──▶ Google Drive (private folder)
```

The photos never pass through Vercel, so Vercel's 4.5 MB request limit doesn't apply and big uploads stay fast.

## Security features

| Protection | What it does |
|---|---|
| **Upload-only** | The site can only *add* photos. There is no way, through the site, to list, view, download or delete anything in Drive. |
| **Smallest possible Google permission** | The app uses the `drive.file` permission. It can only touch files it created itself, not the rest of the Google account's Drive, Gmail or Photos. |
| **Secrets stay on the server** | The Google key lives only in Vercel environment variables. It is never sent to visitors' browsers or stored in GitHub. |
| **One-time upload links** | Each link uploads exactly one photo of the declared size into the folder, and nothing else. |
| **Only your site can use the API** | Requests from any other website are refused (`ALLOWED_ORIGINS`). |
| **Photos only** | Only JPG, PNG, HEIC, WEBP and GIF are accepted, with a size limit (default 25 MB). File names are cleaned and renamed on the server. |
| **Anonymous, signed sessions** | Each visit gets a random reference (e.g. `7F3A9C21`), signed by the server and valid for 3 hours. No names, no cookies, no tracking. |
| **Bot and spam protection** | Optional free Cloudflare Turnstile check, plus a per-visitor rate limit. |
| **Browser hardening** | Strict Content-Security-Policy, HTTPS only (HSTS), no embedding in other sites, no referrer leaks, `noindex` so search engines don't list it. |

---

## Setup (about 20 minutes, done once)

### 1. Use a dedicated Google account (recommended)

Create a Google account just for this project (e.g. `copjesse.documentary@gmail.com`). It comes with 15 GB free, which is shared across Gmail, Drive and Photos. Using a separate account keeps the pastor's or your personal Drive completely apart from this. You can buy more storage (Google One) if needed.

### 2. Create the Google key

Signed in as that account:

1. Go to <https://console.cloud.google.com/> → **Select a project → New project** → name it `COP Documentary Upload` → **Create**.
2. **APIs & Services → Library** → search **Google Drive API** → **Enable**.
3. **Google Auth Platform** (or **OAuth consent screen**) → **Get started**:
   - App name: `COP Documentary Upload`, support email: the account's email.
   - Audience: **External** → finish.
4. **Audience → Publish app** → status becomes **In production**.
   ⚠️ This is important: while an app is in "Testing", Google's sign-in expires after **7 days** and uploads would stop working.
5. **Clients** (or **Credentials → Create credentials → OAuth client ID**) → Application type **Desktop app** → **Create**. Copy the **Client ID** and **Client secret**.

### 3. Get the refresh token and create the folder

On your computer (needs [Node.js 20+](https://nodejs.org)):

```bash
git clone https://github.com/<your-account>/cop-documentary-upload.git
cd cop-documentary-upload
npm run setup-google
```

Paste the Client ID and secret when asked. A browser opens, and you sign in with the **project Google account**. Google may warn that the app "isn't verified". That's expected for your own app: click **Advanced → Go to COP Documentary Upload**.

The script creates the folder **"Pastor Dr. Martin Appiah – Documentary Photos"** and prints 5 lines (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`, `DRIVE_FOLDER_ID`, `SESSION_SECRET`). Treat them like passwords.

### 4. Add the settings in Vercel

Vercel → **cop-documentary-upload** → **Settings → Environment Variables**. Copy the 5 lines and paste them into the first **Key** box (Vercel splits them up for you). Tick **Production**, then **Save**.

`ALLOWED_ORIGINS` (`https://cop-documentary-upload.vercel.app`) and `MAX_FILE_MB` (`25`) are already set. If you add your own domain later, add it to `ALLOWED_ORIGINS`, separated by a comma.

Then **Deployments → ⋯ (on the top one) → Redeploy**, so the settings take effect.

### 5. Recommended extra protection

- **Bot check (free):** create a Turnstile widget at <https://dash.cloudflare.com/?to=/:account/turnstile> for your Vercel domain. Add `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY` in Vercel, then redeploy. Most visitors never see a puzzle.
- **Hard rate limit:** Vercel → project → **Firewall → Rules → Add rule**: if *Request path* starts with `/api/`, **rate limit** 60 requests per minute per IP.
- **Lock the GitHub repo:** keep it **private**.
- **Google account:** turn on 2-step verification for the project Google account.

### 6. Let the media team see the photos

In Google Drive (project account) → right-click the folder → **Share** → add the media team's emails. Give **Viewer** to people who only download, and **Editor** only to people who organise. Never choose "Anyone with the link".

---

## Finding photos in Drive

Files are named like `2026-11-22_1432_7F3A9C21_03_IMG-0042.jpg`:
date and time (South Africa) · upload reference · number · original name.
Everything one person sent in one visit shares the same reference. If someone calls the media team about their photos, they can read out the reference shown on their thank-you screen.

## If something goes wrong

| Symptom | Fix |
|---|---|
| "Uploads are temporarily unavailable" | The Google sign-in stopped working. Check the app is **In production** (step 2.4), run `npm run setup-google` again, update `GOOGLE_REFRESH_TOKEN` in Vercel and redeploy. |
| "Requests are only accepted from the official upload page" | `ALLOWED_ORIGINS` doesn't exactly match the address in the browser bar. |
| "The photo folder is full" | The Google account ran out of space. Free up space or buy Google One storage. |
| Errors in general | Vercel → project → **Logs** shows the details. |

## Project layout

```
public/            the page (index.html, styles.css, app.js, logo)
api/config.js      public settings for the page
api/session.js     starts an anonymous upload session (+ bot check)
api/upload-url.js  checks photos and creates one-time Google Drive upload links
api/_lib.js        shared security and Google Drive code
scripts/setup-google.mjs   one-time Google sign-in and folder creation
vercel.json        security headers
```

Run the tests with `npm test`.
