# Glucose Journal

Native iPhone and iPad source for an offline glucose diary. Requires iOS 17 or newer. The development build uses Apple's SDKs and no package dependencies.

## Run a development build

1. On a Mac, open `GlucoseJournal.xcodeproj` in Xcode 16 or newer.
2. Select the **GlucoseJournal** scheme and an iPhone simulator. Build and run.
3. For a personal iPhone, choose your signing team in **Signing & Capabilities** and set a unique bundle identifier, then select the phone as the run destination.
4. Use synthetic readings during device verification. Complete the checks below before using the app to store real history.

An unsigned simulator compilation can be started with:

```sh
xcodebuild -project GlucoseJournal.xcodeproj -scheme GlucoseJournal \
  -sdk iphonesimulator -configuration Debug CODE_SIGNING_ALLOWED=NO build
```

## Data and processing

- Each local profile gets a random ID, unique salt and its own passphrase-derived key. Profile names, preferences, notes and readings are inside an authenticated AES-256-GCM envelope. The database stores the opaque envelope, revision, random profile ID and update time.
- The key uses PBKDF2-HMAC-SHA256 with 600,000 rounds. The passphrase is not stored. Use a strong, unique passphrase. Losing it means recovery requires another readable copy of the records. Exports do not provide a passphrase reset.
- SQLite writes use bound statements and revision checks. The profile snapshot is serialized and encrypted off the UI actor before SQLite writes. iOS Complete Protection is requested for the vault directory and database. Automatic device backups exclude the vault directory. The app locks on background and covers its contents when inactive.
- A backup contains one encrypted profile, protected by that profile's passphrase. It restores onto a device where the profile ID is absent. Duplicate restore refuses to overwrite the existing journal. A newer and older backup do not merge. The current format caps encrypted profile payloads at 16 MiB. The snapshot model is for manual journaling. High-rate sensor imports need per-record encrypted storage and indexed paging before they are supported.
- Graph aggregation, unit display and report assembly are local. Date filtering uses local calendar days and PDF output spans multiple pages. CSV dates are ISO 8601. Exports are readable files after the user chooses where to save them. Exporting a report differs from making a restorable encrypted backup.
- The app uses no cloud database, credentials service, telemetry, paid AI or background network processing. Source links open on request.

## Features in this source build

Five tabs cover manual entry and editing, filtered reports, measurement graphs, medication and insulin history, and profile settings. The project includes 13 record types, glucose unit switching, editable care-plan and refill notes, visit questions, encrypted restore and deletion of an unlocked profile.

The Insights reader loads `Resources/evidence.bundle.json`. Use the separately delivered Glucose Tracker Evidence System to create an approved bundle. This build contains only the reader because the baseline drafts are pending qualified review. App updates can replace the bundle without writing to user storage.

This source includes opt-in, read-only Apple Health glucose import with a per-profile preview and UUID deduplication, local iOS reminders with generic notifications, and on-device text recognition for photos of labels and meter displays. Apple Health needs a supported iPhone and a signing profile with the HealthKit entitlement. Verify entitlement provisioning, data timestamps, reminders and Vision on an actual phone. Profile backup format differs in optional fields from the web app. Restore backups within the same platform until interoperability is tested.
 
Direct Bluetooth meters and manufacturer CGM connectors, visual food identification, HealthKit write-back, Watch support, cloud sync and shared caregiver permissions require further integration. Medication states are manual diary entries. The app leaves treatment decisions and device alarms to the established care plan and devices.

## Verification

`python3 Tests/check_storage.py` runs four tests against the SQLite statements from the shipped Swift file.

On an iPhone or simulator, verify these before distribution:

- Create two profiles with different passphrases, save different records, background the app, and verify neither profile opens with the other's passphrase or shows the other's entries.
- Verify all 13 record types and try invalid numeric input. Confirm that changing display units and editing a note preserve the saved glucose value.
- Within a profile, edit and delete entries. Filter an inclusive end date, review a multi-page PDF, and check CSV display in Files. Try an entry whose note starts with an equals sign.
- Back up a profile, try the wrong passphrase and a tampered copy, and restore the valid backup on another test device. Confirm duplicate restore exits without changing either local profile.
- Test a locked phone and app switcher previews, airplane mode, larger text and VoiceOver. Verify that reports and care notes remain available offline after unlocking.
