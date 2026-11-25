# Glucose Journal web app

The static application runs on HTTPS or localhost. It requires no build dependencies and sends no patient data to a server. It installs through Safari's Add to Home Screen or a supported Windows browser. Visit online once in the installed browser context, then verify offline access there before relying on it.

Each browser profile has separate encrypted data in IndexedDB. This is local to the browser installation. Download an encrypted backup to transfer to another browser and unlock it with the profile's original passphrase. Backups are app data, and CSV or PDF files are reports. Browser clearing and uninstalling can delete local records. This release supports restoration into an empty profile slot without overwriting. Keep backups outside browser storage.

The native and web apps have their own release cycles. Use an encrypted backup from the same platform while cross-platform restoration remains unverified. Optional web data, such as report templates, inventory and reminders, is not implemented by both platforms.

## Static deployment

Serve `dist/` from a stable HTTPS origin. Increment the app shell cache version in `dist/sw.js` when changing its assets. Do not change the production origin if local data continuity is expected. Load an approved evidence bundle at `dist/evidence.bundle.json` when one is available. Do not add any user data or secrets to these assets.

Run `node --test tests/core.test.mjs` with Node 22+. Browser experience checks should use sample data. On a desktop browser, use its print dialog to save a PDF. On an iPhone, printing and saving are managed by the Safari/Files share workflow. Calendar downloads schedule routine reminders after they are imported to the device's calendar. They are not sensor alerts.

## Stay signed in on this device

The sign-in screen offers an unchecked option to remember an individual profile on this browser. When the browser has just one local profile and that profile opted in, it opens automatically on the next launch. When multiple profiles are present, select a profile and choose **Continue with saved sign-in** if that profile opted in. **Switch profile** returns to the selector. **Lock profile** removes the active profile's saved sign-in.

The browser retains the profile's non-exportable decryption key in its local database. It does not save the passphrase or include the key in encrypted backup files. Anyone able to use the same browser profile can open a remembered journal. Use this option only on a device you control.
