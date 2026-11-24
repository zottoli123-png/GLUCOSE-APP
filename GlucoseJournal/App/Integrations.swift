import HealthKit
import PhotosUI
import SwiftUI
import UserNotifications
import Vision

struct JournalReminder: Codable, Identifiable {
    var id = UUID()
    var label: String
    var when: Date
    var repeatMode: Repeat

    enum Repeat: String, Codable, CaseIterable, Identifiable {
        case once = "Once", daily = "Daily", weekly = "Weekly", monthly = "Monthly"
        var id: Self { self }

        var components: Set<Calendar.Component> {
            switch self {
            case .once: [.year, .month, .day, .hour, .minute]
            case .daily: [.hour, .minute]
            case .weekly: [.weekday, .hour, .minute]
            case .monthly: [.day, .hour, .minute]
            }
        }
    }
}

enum LocalReminders {
    static func identifier(_ profile: UUID, _ id: UUID) -> String {
        "Journal.\(profile.uuidString).\(id.uuidString)"
    }

    static func schedule(_ reminder: JournalReminder, for profile: UUID) async throws {
        let center = UNUserNotificationCenter.current()
        guard try await center.requestAuthorization(options: [.alert, .sound]) else {
            throw IntegrationIssue.message("Enable notifications in iPhone Settings to schedule a reminder.")
        }
        let date = Calendar.current.dateComponents(reminder.repeatMode.components, from: reminder.when)
        let trigger = UNCalendarNotificationTrigger(dateMatching: date, repeats: reminder.repeatMode != .once)
        guard let next = trigger.nextTriggerDate(), next > .now else {
            throw IntegrationIssue.message("Choose a future time.")
        }
        let notification = UNMutableNotificationContent()
        notification.title = "Journal reminder"
        notification.body = "Open Glucose Journal to see your reminder."
        notification.sound = .default
        let request = UNNotificationRequest(identifier: identifier(profile, reminder.id),
                                            content: notification, trigger: trigger)
        try await center.add(request)
    }

    static func remove(_ ids: [UUID], from profile: UUID) {
        let identifiers = ids.map { identifier(profile, $0) }
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: identifiers)
        center.removeDeliveredNotifications(withIdentifiers: identifiers)
    }
}

enum IntegrationIssue: LocalizedError {
    case message(String)
    var errorDescription: String? {
        switch self { case .message(let text): text }
    }
}

struct ReminderPage: View {
    @ObservedObject var session: Session
    let journal: Journal
    @State private var label = ""
    @State private var when = Date.now.addingTimeInterval(3600)
    @State private var repeatMode: JournalReminder.Repeat = .once
    @State private var working = false

    var body: some View {
        Form {
            Section("New reminder") {
                TextField("Label", text: $label)
                DatePicker("Time", selection: $when)
                Picker("Repeat", selection: $repeatMode) {
                    ForEach(JournalReminder.Repeat.allCases) { mode in Text(mode.rawValue).tag(mode) }
                }
                Button("Schedule reminder") { add() }
                    .disabled(working || label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            Section("Saved reminders") {
                ForEach(session.journal?.reminders ?? journal.reminders ?? []) { reminder in
                    VStack(alignment: .leading) {
                        Text(reminder.label)
                        Text(reminder.when.formatted(date: .abbreviated, time: .shortened) + " · " + reminder.repeatMode.rawValue)
                            .font(.caption)
                    }
                    .swipeActions(allowsFullSwipe: false) {
                        Button(role: .destructive) { remove(reminder) } label: { Label("Remove", systemImage: "trash") }
                    }
                }
                Text("Notifications show a generic message. Check system notification settings if a reminder is missed. Restored reminders need to be scheduled again.")
                    .font(.footnote)
            }
        }
        .navigationTitle("Reminders")
        .disabled(working || session.busy)
    }

    private func add() {
        guard let profile = session.profileID else { return }
        let reminder = JournalReminder(label: label, when: when, repeatMode: repeatMode)
        working = true
        Task {
            defer { working = false }
            do {
                try await LocalReminders.schedule(reminder, for: profile)
                guard session.profileID == profile, var next = session.journal else {
                    LocalReminders.remove([reminder.id], from: profile)
                    return
                }
                next.reminders = (next.reminders ?? []) + [reminder]
                if await session.update(next) { label = "" }
                else { LocalReminders.remove([reminder.id], from: profile) }
            } catch { if session.profileID == profile { session.message = error.localizedDescription } }
        }
    }

    private func remove(_ reminder: JournalReminder) {
        guard let profile = session.profileID else { return }
        working = true
        Task {
            defer { working = false }
            guard var next = session.journal else { return }
            next.reminders?.removeAll { $0.id == reminder.id }
            if await session.update(next) { LocalReminders.remove([reminder.id], from: profile) }
        }
    }
}

@MainActor
final class HealthImport: ObservableObject {
    private let store = HKHealthStore()

    func glucose(since: Date) async throws -> [Entry] {
        guard HKHealthStore.isHealthDataAvailable(),
              let glucose = HKQuantityType.quantityType(forIdentifier: .bloodGlucose) else {
            throw IntegrationIssue.message("Apple Health blood glucose is unavailable on this device.")
        }
        try await store.requestAuthorization(toShare: [], read: [glucose])
        let sinceDate = HKQuery.predicateForSamples(withStart: since, end: .now, options: .strictStartDate)
        let predicate = HKSamplePredicate.quantitySample(type: glucose, predicate: sinceDate)
        let query = HKSampleQueryDescriptor(predicates: [predicate],
            sortDescriptors: [SortDescriptor(\HKQuantitySample.startDate, order: .reverse)], limit: 10_001)
        let samples = try await query.result(for: store)
        guard samples.count <= 10_000 else {
            throw IntegrationIssue.message("This import exceeds 10,000 readings. Choose a more recent start date.")
        }
        let unit = HKUnit(from: "mg/dL")
        return samples.compactMap { sample in
            let value = sample.quantity.doubleValue(for: unit)
            guard value.isFinite && value > 0 else { return nil }
            return Entry(id: sample.uuid, kind: .glucose, measuredAt: sample.startDate,
                         values: [value], source: sample.sourceRevision.source.name + " via Apple Health")
        }
    }
}

struct HealthPage: View {
    @ObservedObject var session: Session
    @StateObject private var importer = HealthImport()
    @State private var since = Date.now.addingTimeInterval(-7 * 86_400)
    @State private var candidates: [Entry] = []
    @State private var status = ""
    @State private var working = false

    var body: some View {
        Form {
            Section("Glucose import") {
                Text("Apple Health belongs to the person using this iPhone. Choose their journal profile before importing. Readings can arrive late.")
                DatePicker("Start date", selection: $since, in: ...Date.now, displayedComponents: .date)
                Button("Review Apple Health readings") { preview() }
                if !status.isEmpty { Text(status) }
            }
            if !candidates.isEmpty {
                Section("Import preview") {
                    ForEach(candidates.prefix(5)) { entry in
                        VStack(alignment: .leading) {
                            Text(entry.displayValues(mmol: session.journal?.useMMOL ?? false))
                            Text(entry.measuredAt.formatted() + " · " + entry.recordSource).font(.caption)
                        }
                    }
                    Button("Import \(candidates.count) readings into this profile") { commit() }
                }
            }
        }
        .navigationTitle("Apple Health")
        .disabled(working || session.busy)
    }

    private func preview() {
        guard let profile = session.profileID else { return }
        working = true
        candidates = []
        Task {
            defer { working = false }
            do {
                let readings = try await importer.glucose(since: Calendar.current.startOfDay(for: since))
                guard session.profileID == profile, let journal = session.journal else { return }
                let existing = Set(journal.entries.map(\.id)).union(journal.removedImportIDs ?? [])
                candidates = readings.filter { !existing.contains($0.id) }
                status = candidates.isEmpty
                    ? "No new readings returned. Check the dates and your Apple Health read permission."
                    : "\(readings.count - candidates.count) previously seen readings skipped."
            } catch { if session.profileID == profile { status = error.localizedDescription } }
        }
    }

    private func commit() {
        guard var next = session.journal else { return }
        let seen = Set(next.entries.map(\.id)).union(next.removedImportIDs ?? [])
        next.entries += candidates.filter { !seen.contains($0.id) }
        working = true
        Task {
            defer { working = false }
            if await session.update(next) { candidates = []; status = "Readings imported." }
        }
    }
}

struct PhotoTextPage: View {
    @State private var selection: PhotosPickerItem?
    @State private var lines = ""
    @State private var working = false
    @State private var errorMessage = ""
    var body: some View {
        Form {
            Section("Meter display or nutrition label") {
                Text("Choose a photo to read its text on this device. Check every digit, unit and serving size against the original before entering it.")
                PhotosPicker("Choose photo", selection: $selection, matching: .images)
                if working { ProgressView("Reading photo…") }
                if !errorMessage.isEmpty { Text(errorMessage) }
            }
            if !lines.isEmpty {
                Section("Detected text") {
                    Text(lines).textSelection(.enabled)
                }
            }
        }
        .navigationTitle("Read a photo")
        .task(id: selection) {
            guard let item = selection else { return }
            working = true
            lines = ""
            errorMessage = ""
            defer { if !Task.isCancelled { working = false } }
            do {
                guard let bytes = try await item.loadTransferable(type: Data.self), bytes.count <= 32 * 1024 * 1024
                else { throw IntegrationIssue.message("Choose a supported photo smaller than 32 MB.") }
                let detected = try await Task.detached(priority: .userInitiated) {
                    let request = VNRecognizeTextRequest()
                    request.recognitionLevel = .accurate
                    try VNImageRequestHandler(data: bytes).perform([request])
                    return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
                }.value
                if !Task.isCancelled { lines = detected.isEmpty ? "No text detected." : detected }
            } catch {
                if !Task.isCancelled { errorMessage = error.localizedDescription }
            }
        }
    }
}
