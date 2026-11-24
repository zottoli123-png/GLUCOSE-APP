# Glucose Journal web app

The static application runs on HTTPS or localhost. It requires no build dependencies and sends no patient data to a server. It installs through Safari's Add to Home Screen or a supported Windows browser. Visit online once in the installed browser context, then verify offline access there before relying on it.

Each browser profile has separate encrypted data in IndexedDB. This is local to the browser installation. Download an encrypted backup to transfer to another browser and unlock it with the profile's original passphrase. Backups are app data, and CSV or PDF files are reports. Browser clearing and uninstalling can delete local records. This release supports restoration into an empty profile slot without overwriting. Keep backups outside browser storage.

The native and web apps have their own release cycles. Use an encrypted backup from the same platform while cross-platform restoration remains unverified. Optional web data, such as report templates, inventory and reminders, is not implemented by both platforms.

## Static deployment

Serve `dist/` from a stable HTTPS origin. Increment the app shell cache version in `dist/sw.js` when changing its assets. Do not change the production origin if local data continuity is expected. Load an approved evidence bundle at `dist/evidence.bundle.json` when one is available. Do not add any user data or secrets to these assets.

Run `node --test tests/core.test.mjs` with Node 22+. Browser experience checks should use sample data. On a desktop browser, use its print dialog to save a PDF. On an iPhone, printing and saving are managed by the Safari/Files share workflow. Calendar downloads schedule routine reminders after they are imported to the device's calendar. They are not sensor alerts.

## Optional encrypted sync pilot

The web app supports one encrypted journal per generated sync key. Open Settings on the first device, generate a key, save it in your password manager, and choose **Create cloud copy**. On another device, pick **Restore from cloud sync** and enter the key and original journal passphrase. For later edits, open the relevant profile and choose **Sync now**. Sync is manual. Local edits remain available offline. Conflicts preserve both copies, which can be downloaded as encrypted backups. Cloud deletion requires explicit confirmation and preserves the current local profile. A deleted key cannot create a new cloud copy.

The key is a random 256-bit bearer credential, stored on the server only as a SHA-256 digest. It grants access to the encrypted envelope and can authorize cloud deletion. Keep it private and use a strong, independent journal passphrase. The browser sends the sync key for authentication and never sends the journal passphrase. There is no email, recovery or sync-key rotation workflow in this pilot. The host serves the browser's code and must be trusted to deliver it. The API caps each upload at 1 MiB; larger journals can still use local storage and encrypted file backups.

Cloud sync defaults to disabled. For a sandbox deployment, create a dedicated D1 database, add binding `JOURNAL_SYNC` with `migrations_dir: "GlucoseWeb/worker/migrations"`, apply migrations, and set `SYNC_ENABLED` to the string `"true"` on the sandbox. Keep the public deployment disabled until account isolation, abuse controls, recovery, privacy obligations and operational deletion and retention are reviewed. D1 may retain historical versions according to the database's recovery settings. Cloud deletion removes the active snapshot.

Run `node --test GlucoseWeb/tests/*.test.mjs` from the repository root to check the Worker and SQLite queries with synthetic journals.
