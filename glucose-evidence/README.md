# Glucose Tracker Evidence System

This is the maintainer-side research component for a free, offline-first tracker. It runs with Python 3.10+ and uses the public PubMed API for discovery. Patients need no account, server, AI subscription, or network connection to read the approved content once it is bundled into an app update.

## What is included

- `baseline.json` contains 15 editorial drafts with source links, study populations, limitations and proposed design implications. Drafts are maintainer material.
- `sample-search.json` contains candidate metadata from a live search. Candidate counts are query matches, and overlapping topics prevent adding the counts to obtain a unique total.
- `source-check.json` records PubMed publication notice checks for the baseline.
- `decisions.json` starts all cards pending. Keep decisions and prior versions in source control.
- `research.py` searches PubMed, checks referenced PMIDs and builds a JSON bundle from approved cards.
- `test_research.py` verifies release safeguards using synthetic records.

## Research and release

1. Discover candidates with the commands below. Split high-volume searches by date window and run population-specific passes. Record exclusions, conflicts, full-text availability and overlapping trial populations so an individual trial or follow-up is counted once. The search prioritizes guidelines, systematic reviews, randomized trials and notices. Use the broad pass for qualitative research about workload, access and caregiver experience. Check ADA, FDA, CDC, NIDDK and device makers separately for guidance, safety notices and compatibility changes. Read full texts where available and state when only the abstract supports an interpretation. Confirm reuse rights before redistributing source material.
2. An evidence reviewer checks study design, population, intervention, comparator, outcomes, follow-up, bias and clinical applicability. Add a short extraction with page or section references in version control for new cards. When strong sources disagree, capture the difference and identify who each source applies to. Run the notice check on every release and inspect corrections at the publisher as well.
3. Have a qualified reviewer approve the exact patient-facing text. Record an approval in `decisions.json` using the card ID and fields `status` set to `approved`, `reviewer`, `reviewed_on` (ISO date), and `digest` (from the hashes command). Keep approvals in a protected review process when moving to a shared repository. The hash detects changes to reviewed text. Repository permissions establish who can approve.
4. Build the versioned bundle. The app should load it as bundled read-only education, show its version and review dates, and keep patient data in separate on-device storage. Keep previous reviewed bundles for rollback. A correction or withdrawal should generate a reviewed replacement release. Devices that stay offline keep the installed version until their next update.

```sh
python3 research.py discover --since 2022-01-01 --limit 100
python3 research.py discover --population pregnancy --topic monitoring --output pregnancy.json
python3 research.py discover --broad --topic access-and-distress --output access.json
python3 research.py check-sources
python3 research.py hashes
python3 -m unittest -v
python3 research.py package --source-check source-check.json --version 1.0.0 --output evidence.bundle.json
```

Packaging exits with an error until a card has an exact matching approval. A PubMed source flagged for a notice requires editorial investigation and a new reviewed card with a resolved source. The release check relies on PubMed indexing and the canonical PubMed URLs used on cards. Review non-PubMed references manually.

## Where the baseline changes the app

| App area | First behavior to implement and test |
|---|---|
| History | Preserve measurement time, import time, original reading and source. A delayed import stays visibly delayed. |
| Graph and reports | Label meter results as counts of checks. For sensor summaries, show coverage and gaps. Keep lab A1C distinct from a sensor-derived estimate. |
| Medications | Display the last confirmed dose and its author. Keep the plan, reminder and confirmed event separate. |
| Care plans | Save the clinician's original instructions offline. Version targets and care plans with effective dates. |
| Supplies | Include links to education and financial help beside refill tracking. Allow an offline user to keep pharmacy contact info. |
| App updates | Bundle reviewed educational content with version history. Test using simulated readings, never patient records in debug reports or in literature queries. |

The intended runtime uses deterministic calculations for reports and clinician-supplied plans and targets. The evidence bundle supplies explanations and references. The code does not validate the clinical correctness of prose or perform approval on the reviewer's behalf. It does not deploy an app, send updates, or run on a schedule.
