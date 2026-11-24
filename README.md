# Glucose Journal project

This package contains the web app, native iPhone project, maintenance-side research system and validation workflow. Patient records and passphrases belong only in the installed app. Use synthetic data when debugging.

| Component | Entry point |
|---|---|
| Web app | Serve GlucoseWeb/dist over HTTPS. See GlucoseWeb/README.md. |
| iPhone source | Open GlucoseJournal/GlucoseJournal.xcodeproj. See GlucoseJournal/README.md. |
| Research system | Run glucose-evidence/research.py. See glucose-evidence/README.md. |
| CI | The included workflow runs local data tests and an unsigned iOS simulator compile when installed in a GitHub repository. It does not sign or publish. |

Keep the website origin stable across updates. Increment the service worker cache version when changing web assets. Do not change the native bundle ID after releasing a build. For patient-facing educational content, generate a reviewed evidence bundle using the research tool and place it in both apps' documented resource locations.

Release verification should cover loss of power during a write, concurrent edits, multiple profiles, old backups, wrong credentials, browser storage eviction, phone recovery, locale and timezone changes, large type, keyboard navigation and VoiceOver. Test vendor integrations per model, OS and data route before listing compatibility. Avoid using device exports from real patients as shared test fixtures.

The web experience and the native experience have different device capabilities. The cloud-hosted site serves only static assets. The web app keeps the encrypted database in the browser. The native app keeps its encrypted database on the device. Patient records are not part of a release or a research query.
