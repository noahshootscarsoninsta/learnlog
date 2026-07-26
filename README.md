# LearnLog

A simple, offline-first PWA for tracking skills you want to learn, are learning, and can already do. No account, no login, no server — everything lives on your device.

## What's new in this version

Latest round of additions:

- **Category icons.** Every category (default and custom) now has a small emoji icon, shown on the Categories page, in Search filter chips, and as the fallback thumbnail on any skill card without a photo/video. Rename a category to change its icon.
- **Restore default categories.** A link at the bottom of Categories re-adds any of the eight built-in categories you've deleted or renamed away, without touching anything else.
- **Favorites filter on Search.** A "★ Favorites" chip next to "All" narrows results to favorited skills only, combinable with a category filter and the text search.
- **Duplicate skill.** The skill detail sheet has a "Duplicate" button that clones a skill (name, category, notes, photo/video) as "<name> copy" and opens it for editing.
- **Swipe-to-delete.** Swipe a skill card left on Home or in Search to reveal a Delete action, in addition to the existing delete button inside the detail/edit sheets.
- **Recently Deleted.** Deleting a skill (any way — swipe, detail sheet, edit sheet) moves it to Settings → Recently Deleted for 24 hours before it's gone for good, alongside the existing instant "Undo" toast. Both use the same restore, so either path brings back the exact same record.
- **Share a skill / share your whole list.** The detail sheet has a "Share" button for a single skill; Settings → Backup & Restore has "Share your list" for a plain-text summary of everything. Both use the device share sheet where available, or copy to clipboard otherwise.
- **Backup reminder.** Settings now shows when you last exported a backup file, so it's easy to notice if it's been a while.
- **Install banner (Android/Chrome).** On Android/Chrome, LearnLog shows its own "Install LearnLog" banner on Home once the browser decides the app is installable, instead of relying only on the browser's built-in prompt. iOS has no equivalent event, so this banner never appears there — Share → Add to Home Screen remains the only iOS install path (see section 3 below).
- **Version line.** Settings → About now shows the running app version, matching the service worker's cache version.

Earlier round:

- **Undo after delete.** Deleting a skill shows a few-second "Undo" toast that brings it straight back, photo/video included.
- **Backup preview before restoring.** Picking a backup file now shows exactly what's in it (skill count, category count, how many have media, export date) before you commit to overwriting your current data.
- **Auto theme.** Settings → Appearance now has a third option, Auto, which follows your iPhone's system Dark/Light setting and updates live if you switch it mid-session.
- **Camera shortcut.** The Add/Edit Skill sheet now has two buttons — "Choose from Library" and "Take Photo" — instead of one generic picker.
- **Automatic photo compression.** Photos over ~350KB are downscaled to a max of 1600px on the long edge and re-encoded before saving, so a phone full of skill photos doesn't quietly eat storage. Videos and GIFs are left untouched.
- **Real drag-to-reorder.** Manual sort mode now has an actual drag handle you pick up and drag, instead of up/down arrow buttons. It also works from the keyboard: focus the handle and use the arrow keys.
- **Haptic feedback.** Small vibrations on add/delete/move/favorite/reorder actions.
- **Screen reader support.** Tabs, the bottom nav, sheets, the favorite switch, and the toast now carry proper ARIA roles, and focus moves into and back out of dialogs correctly, including nested ones (e.g. "Delete this skill?" opened from the detail sheet).

Two honest platform caveats, both outside my control:
- **Haptics are Android/Chrome only.** iOS Safari doesn't expose the vibration API to web pages at all, so on iPhone this is a silent no-op — everything else about the action still works normally.
- **The camera shortcut is a hint, not a guarantee.** The `capture="environment"` attribute asks iOS Safari to jump straight to the camera; on some iOS versions it still shows a small chooser between camera and library instead of skipping straight to the camera. Either way, both options remain reachable.

## 1. File structure

```
LearnLog/
├── index.html              App shell — all four screens live in this one HTML file
├── manifest.webmanifest     PWA metadata (name, icons, theme colors, install behavior)
├── sw.js                    Service worker — caches the app shell for offline use
├── README.md
├── css/
│   └── style.css            All styling (dark theme default + light theme)
├── js/
│   ├── db.js                IndexedDB layer: skills, categories, settings, backup/restore
│   └── app.js                UI logic, rendering, event handling
└── icons/
    ├── icon.svg              Master app icon (source of truth)
    ├── icon-maskable.svg     Safe-zone source for Android adaptive icons
    ├── icon-192.png          Android/Chrome home-screen icon
    ├── icon-512.png          Android/Chrome install + splash icon
    ├── icon-180.png          iOS home-screen icon
    ├── icon-32.png           Favicon
    ├── icon-maskable-512.png Android adaptive icon
    └── generate-icons.html   Regenerates the PNGs above from the SVGs if you ever redesign the mark
```

There's no build step and no dependencies. It's plain HTML/CSS/JS. All the icon PNGs are already generated and committed — nothing to do before installing on iPhone or Android. If you ever change the SVG source, reopen `icons/generate-icons.html` in a browser and re-export.

## 2. How offline storage works

LearnLog uses **IndexedDB**, a database built into the browser, for everything: skill entries, categories, settings (theme, sort order), and the actual photo/video files (stored as Blobs). None of this touches the network — there is no server and no sync.

Because IndexedDB is disk-backed browser storage (not memory, not a cache), your data survives:
- closing the app or browser tab
- refreshing the page
- switching apps or tabs
- losing your internet connection
- turning the device off and back on later

Every add/edit/delete/move action writes straight to IndexedDB immediately — there's no "save" step to remember and nothing is held only in memory.

## 3. How PWA installation works

Two files make LearnLog installable:
- **`manifest.webmanifest`** tells the browser the app's name, icon, and that it should open full-screen (`standalone`) instead of inside browser chrome.
- **`sw.js`** (the service worker) intercepts network requests and serves cached files instead, so the app keeps working with no signal at all after the first visit.

**On iPhone:** open the site in Safari → tap the Share icon → **Add to Home Screen**. It'll appear as its own "LearnLog" icon and open full-screen like a native app.

**On Android/Chrome:** you'll see an "Install" prompt in the address bar, or Menu → **Install app**.

The service worker only activates over HTTPS (or `localhost` for local testing) — this is a browser security requirement, not something specific to LearnLog.

## 4. How to run and test it

You just need to serve the folder over HTTP (opening `index.html` directly via `file://` will break the service worker and IndexedDB in some browsers). Any static server works:

```bash
cd LearnLog
python3 -m http.server 8080
# then open http://localhost:8080
```

or, with Node installed:

```bash
npx serve .
```

Open it on your phone by visiting your computer's local IP address (e.g. `http://192.168.1.20:8080`) from the same Wi-Fi network, or just test in a desktop browser at a narrow window width — the layout is mobile-first.

## 5. How to test it offline

1. Load the app once over HTTP while online (this lets the service worker cache everything).
2. Add a couple of skills so you have data to check.
3. Now go offline — either turn on Airplane Mode on your phone, or in desktop Chrome DevTools go to the **Network** tab and switch the throttling dropdown to **Offline**.
4. Reload the page. It should load instantly from cache and show your skills exactly as before.
5. Try adding, editing, and deleting a skill while still offline — it all keeps working because IndexedDB doesn't need a network connection.

## 6. How to publish it on Netlify

**Easiest way (drag and drop):**
1. Go to [app.netlify.com](https://app.netlify.com) and log in.
2. Drag the whole `LearnLog` folder onto the Netlify dashboard ("Deploys" → drag-and-drop area).
3. Netlify gives you a live HTTPS URL immediately — PWA install will work right away since Netlify serves over HTTPS.

**Git-based (recommended if you'll update it later):**
1. Push this folder to a GitHub/GitLab repo.
2. In Netlify: **Add new site → Import an existing project**, connect the repo.
3. Leave the build command blank and set the publish directory to the repo root (or wherever `index.html` lives).
4. Deploy. Future pushes to the repo auto-deploy.

No environment variables, build tools, or backend config needed.

## 7. How to update the app later without deleting saved user data

This is the important part to get right, so here's the short version: **IndexedDB (all your skills, categories, notes, and media) is completely separate from the service worker's file cache.** Deploying new files, or the service worker fetching a new version of the app, never touches IndexedDB. Your data is safe through any update.

To ship a code update:
1. Make your changes to the HTML/CSS/JS files.
2. Open `sw.js` and bump the cache name at the top (it's currently `"learnlog-v5"` — the next update would be `"learnlog-v6"`, and so on). Also update `APP_VERSION` at the top of `js/app.js` to match, so Settings → About shows the right number:
   ```js
   const CACHE_VERSION = "learnlog-v6"; // was "learnlog-v5"
   ```
   This step matters — without it, users' browsers may keep serving the old cached files indefinitely.
3. Redeploy (re-drag the folder onto Netlify, or push to your connected repo).
4. When a user reopens LearnLog, the browser downloads the new service worker in the background, caches the new files under the new version name, deletes the old cache, and takes over. Their skills, categories, and settings in IndexedDB are untouched throughout.

One thing to avoid: don't change the IndexedDB schema (store names, key structure) in `db.js` without also writing a migration in the `onupgradeneeded` handler — otherwise older saved records may not match a changed shape. For simple changes (new optional field, new default category, etc.) this isn't a concern.

---

**What's intentionally not in this app:** XP, levels, streaks, progress percentages, graphs, attempt counts, and rankings. LearnLog only ever asks three questions: what you want to learn, what you're learning, and what you can already do.
