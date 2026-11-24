import Charts
import CryptoKit
import Foundation
import SwiftUI
import UniformTypeIdentifiers

@main
struct GlucoseJournalApp: App {
    var body: some Scene {
        WindowGroup { RootView() }
    }
}

@MainActor
final class Session: ObservableObject {
    private let vault = Vault()
    private var unlocked: (VaultEnvelope, SymmetricKey, Int64)?
    @Published private(set) var profiles: [Profile] = []
    @Published private(set) var journal: Journal?
    @Published private(set) var busy = false
    @Published var message: String?
    private var token = UUID()
    var profileID: UUID? { unlocked?.0.id }
    var profileCode: String? { unlocked.map { String($0.0.id.uuidString.prefix(8)) } }

    func refresh() async {
        do { profiles = try await vault.profiles() }
        catch { message = error.localizedDescription }
    }

    func lock() {
        token = UUID()
        unlocked = nil
        journal = nil
        message = nil
    }

    func open(id: UUID?, name: String, passphrase: String, restore: VaultEnvelope? = nil) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        let opening = token
        do {
            let envelope: VaultEnvelope
            let revision: Int64?
            if let restore {
                envelope = restore
                revision = nil
            } else if let id {
                let result = try await vault.load(id)
                envelope = result.0
                revision = result.1
            } else {
                guard passphrase.count >= 14, passphrase.utf8.count <= 1024, !name.isEmpty
                else { throw VaultError.invalid }
                envelope = try VaultEnvelope.fresh()
                revision = nil
            }
            let hasContents = id != nil || restore != nil
            let result = try await Task.detached(priority: .userInitiated) {
                let key = try envelope.key(passphrase: passphrase)
                if hasContents { return (try envelope.opened(with: key), key, envelope) }
                let journal = Journal(name: name)
                return (journal, key, try envelope.replacing(journal, using: key))
            }.value
            guard token == opening else { return }
            let savedRevision: Int64
            if let revision { savedRevision = revision }
            else { savedRevision = try await vault.save(result.2, expected: nil) }
            await refresh()
            guard token == opening else { return }
            unlocked = (result.2, result.1, savedRevision)
            journal = result.0
        } catch {
            if token == opening { message = error.localizedDescription }
        }
    }

    func update(_ next: Journal) async -> Bool {
        guard !busy, let (envelope, key, revision) = unlocked else { return false }
        busy = true
        defer { busy = false }
        let opening = token
        do {
            let replacement = try await Task.detached(priority: .userInitiated) {
                try envelope.replacing(next, using: key)
            }.value
            guard token == opening else { return false }
            let nextRevision = try await vault.save(replacement, expected: revision)
            if token == opening {
                unlocked = (replacement, key, nextRevision)
                journal = next
            }
            return true
        } catch {
            if token == opening { message = error.localizedDescription }
            return false
        }
    }

    func deleteCurrentProfile() async {
        guard !busy, let (envelope, _, revision) = unlocked else { return }
        busy = true
        defer { busy = false }
        do {
            let reminders = journal?.reminders?.map(\.id) ?? []
            try await vault.delete(envelope.id, expected: revision)
            LocalReminders.remove(reminders, from: envelope.id)
            lock()
            await refresh()
        } catch { message = error.localizedDescription }
    }

    func backup() throws -> Data {
        guard let (envelope, _, _) = unlocked else { throw VaultError.unavailable }
        return try JSONEncoder().encode(envelope)
    }
}

struct RootView: View {
    @StateObject private var session = Session()
    @Environment(\.scenePhase) private var phase
    var body: some View {
        Group {
            if let journal = session.journal {
                JournalTabs(session: session, journal: journal)
            } else {
                ProfileGate(session: session)
            }
        }
        .tint(Color(red: 0.08, green: 0.43, blue: 0.33))
        .overlay {
            if phase != .active { Color(uiColor: .systemBackground).ignoresSafeArea() }
        }
        .onChange(of: phase) { _, next in
            if next == .background { session.lock() }
            if next == .active && session.journal == nil { Task { await session.refresh() } }
        }
        .task { await session.refresh() }
        .alert("Glucose Journal", isPresented: Binding(
            get: { session.message != nil }, set: { if !$0 { session.message = nil } })) {
                Button("OK") { session.message = nil }
            } message: { Text(session.message ?? "") }
    }
}

struct ExportFile: FileDocument {
    static var readableContentTypes: [UTType] { [.json, .commaSeparatedText, .pdf] }
    var bytes = Data()
    init(bytes: Data = Data()) { self.bytes = bytes }
    init(configuration: ReadConfiguration) throws {
        guard let bytes = configuration.file.regularFileContents else { throw VaultError.invalid }
        self.bytes = bytes
    }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: bytes)
    }
}

struct ProfileGate: View {
    @ObservedObject var session: Session
    @State private var selected: UUID?
    @State private var name = ""
    @State private var password = ""
    @State private var confirmation = ""
    @State private var importing = false
    @State private var restore: VaultEnvelope?
    var creating: Bool { selected == nil && restore == nil }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Label("Glucose Journal", systemImage: "book.closed")
                        .font(.largeTitle.bold()).accessibilityAddTraits(.isHeader)
                    Text("Keep your readings, medications, and visit notes in one private journal.")
                        .foregroundStyle(.secondary)
                }
                Section("Profile") {
                    if let restore {
                        LabeledContent("Backup", value: String(restore.id.uuidString.prefix(8)))
                        Button("Cancel restore") { self.restore = nil; password = "" }
                    } else {
                        Picker("Choose profile", selection: $selected) {
                            Text("New profile").tag(UUID?.none)
                            ForEach(session.profiles) { profile in
                                Text("Profile " + String(profile.id.uuidString.prefix(8))).tag(Optional(profile.id))
                            }
                        }
                        .onChange(of: selected) { _, _ in password = ""; confirmation = "" }
                        if creating {
                            TextField("Profile name", text: $name)
                            Text("Choose a unique passphrase of at least 14 characters. You’ll need it to restore a backup.")
                                .font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                    SecureField("Passphrase", text: $password).textContentType(creating ? .newPassword : .password)
                    if creating { SecureField("Confirm passphrase", text: $confirmation) }
                    Button(creating ? "Create profile" : (restore == nil ? "Unlock profile" : "Restore backup")) {
                        let phrase = password
                        password = ""
                        confirmation = ""
                        Task {
                            await session.open(id: selected, name: name.trimmingCharacters(in: .whitespacesAndNewlines),
                                               passphrase: phrase, restore: restore)
                        }
                    }
                    .disabled(password.isEmpty || (creating && (password.count < 14 || password != confirmation || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)))
                    if session.busy { ProgressView("Working…") }
                }
                Section {
                    Button("Open an encrypted backup") { importing = true }
                    Text("Each profile has its own passphrase. Back up your history before replacing or resetting your phone.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .disabled(session.busy)
            .fileImporter(isPresented: $importing, allowedContentTypes: [.json]) { result in
                do {
                    let url = try result.get()
                    let granted = url.startAccessingSecurityScopedResource()
                    defer { if granted { url.stopAccessingSecurityScopedResource() } }
                    let handle = try FileHandle(forReadingFrom: url)
                    defer { try? handle.close() }
                    let bytes = try handle.read(upToCount: VaultEnvelope.maxBytes * 2 + 1) ?? Data()
                    guard bytes.count <= VaultEnvelope.maxBytes * 2 else { throw VaultError.tooLarge }
                    restore = try JSONDecoder().decode(VaultEnvelope.self, from: bytes)
                    selected = nil
                    password = ""
                } catch { session.message = error.localizedDescription }
            }
        }
    }
}

struct JournalTabs: View {
    @ObservedObject var session: Session
    let journal: Journal
    @State private var draft: Entry?
    @State private var filter: Measure?
    @State private var days = 30
    @State private var selection: Measure = .glucose
    @State private var entryToDelete: Entry?
    @State private var confirmDeletion = false

    var ordered: [Entry] { journal.entries.sorted { $0.measuredAt > $1.measuredAt } }

    var body: some View {
        TabView {
            NavigationStack { history }
                .tabItem { Label("History", systemImage: "clock") }
            NavigationStack { InsightsView(journal: journal) }
                .tabItem { Label("Insights", systemImage: "doc.text.magnifyingglass") }
            NavigationStack { graph }
                .tabItem { Label("Graph", systemImage: "chart.xyaxis.line") }
            NavigationStack { medications }
                .tabItem { Label("Medications", systemImage: "pills") }
            NavigationStack { SettingsView(session: session, journal: journal) }
                .tabItem { Label("Settings", systemImage: "gearshape") }
        }
        .sheet(item: $draft) { entry in
            Editor(entry: entry, mmol: journal.useMMOL, busy: session.busy) { updated in
                var next = journal
                if let index = next.entries.firstIndex(where: { $0.id == updated.id }) {
                    next.entries[index] = updated
                } else { next.entries.append(updated) }
                let saved = await session.update(next)
                if !saved { throw VaultError.unavailable }
            }
        }
        .confirmationDialog("Delete this reading?", isPresented: $confirmDeletion, titleVisibility: .visible) {
            Button("Delete entry", role: .destructive) {
                guard let id = entryToDelete?.id else { return }
                var next = journal
                if next.entries.contains(where: { $0.id == id && $0.source != nil }) {
                    next.removedImportIDs = (next.removedImportIDs ?? []) + [id]
                }
                next.entries.removeAll { $0.id == id }
                Task { _ = await session.update(next) }
            }
        }
    }

    var history: some View {
        List {
            Section(journal.name) {
                if let recent = ordered.first(where: { $0.kind == .glucose }) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Latest glucose").font(.subheadline).foregroundStyle(.secondary)
                        Text(recent.displayValues(mmol: journal.useMMOL)).font(.title2.bold())
                        Text(recent.measuredAt.formatted(date: .abbreviated, time: .shortened) + " · " + recent.recordSource)
                            .font(.footnote).foregroundStyle(.secondary)
                    }.padding(.vertical, 8)
                } else { Text("Add your first glucose reading.").foregroundStyle(.secondary) }
                Button { draft = Entry() } label: { Label("Log glucose", systemImage: "plus.circle.fill") }
            }
            Section("Entries") {
                Picker("Show", selection: $filter) {
                    Text("All entries").tag(Measure?.none)
                    ForEach(Measure.allCases) { kind in Text(kind.rawValue).tag(Optional(kind)) }
                }
                ForEach(ordered.filter { filter == nil || $0.kind == filter }) { entry in row(entry) }
            }
        }
        .navigationTitle("History")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    ForEach(Measure.allCases) { kind in
                        Button(kind.rawValue) { draft = Entry(kind: kind) }
                    }
                } label: { Label("Add entry", systemImage: "plus.circle") }
            }
        }
    }

    func row(_ entry: Entry) -> some View {
        Button {
            draft = entry
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                Text([entry.kind.rawValue, entry.detail].filter { !$0.isEmpty }.joined(separator: " · ")).font(.headline)
                let values = entry.displayValues(mmol: journal.useMMOL)
                if !values.isEmpty { Text(values) }
                if entry.kind == .insulin || entry.kind == .medication { Text(entry.doseStatus.rawValue) }
                if !entry.tag.isEmpty { Text(entry.tag).foregroundStyle(.secondary) }
                if !entry.notes.isEmpty { Text(entry.notes).lineLimit(2) }
                Text(entry.measuredAt.formatted(date: .abbreviated, time: .shortened) + " · " + entry.recordSource)
                    .font(.caption).foregroundStyle(.secondary)
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(.plain)
        .swipeActions(allowsFullSwipe: false) {
            Button(role: .destructive) { entryToDelete = entry; confirmDeletion = true } label: {
                Label("Delete", systemImage: "trash")
            }
        }
    }

    var graph: some View {
        let cutoff = Calendar.current.date(byAdding: .day, value: -days, to: Date()) ?? .distantPast
        let points = ordered.filter { $0.kind == selection && $0.measuredAt >= cutoff && $0.firstValue != nil &&
            ($0.kind != .insulin || $0.doseStatus == .taken) }
        let factor = selection == .glucose && journal.useMMOL ? 18.0182 : 1.0
        return List {
            Section {
                Picker("Measurement", selection: $selection) {
                    ForEach(Measure.allCases.filter { !$0.fields.isEmpty && $0 != .medication }) { Text($0.rawValue).tag($0) }
                }
                Picker("Window", selection: $days) {
                    ForEach([1, 3, 7, 14, 30, 90, 180], id: \.self) { Text("\($0) days").tag($0) }
                }
            }
            Section("Recorded checks") {
                if points.isEmpty {
                    ContentUnavailableView("No measurements in this window", systemImage: "chart.xyaxis.line")
                } else {
                    Chart(points) { entry in
                        if let value = entry.firstValue {
                            PointMark(x: .value("Measured at", entry.measuredAt),
                                      y: .value("Value", value / factor))
                                .accessibilityLabel(entry.measuredAt.formatted())
                                .accessibilityValue(entry.displayValues(mmol: journal.useMMOL))
                        }
                    }.frame(height: 225).padding(.vertical, 8)
                    Text("\(points.count) measurements · \(factor == 1 ? selection.fields[0] : "Glucose (mmol/L)")")
                    ForEach(points.prefix(10)) { row($0) }
                }
            }
        }.navigationTitle("Graph")
    }

    var medications: some View {
        let doses = ordered.filter { $0.kind == .medication || $0.kind == .insulin }
        return List {
            Section {
                Button { draft = Entry(kind: .medication) } label: { Label("Log medication", systemImage: "plus.circle") }
                Button { draft = Entry(kind: .insulin) } label: { Label("Log insulin", systemImage: "syringe") }
            }
            if let last = doses.first(where: { $0.doseStatus == .taken }) {
                Section("Latest recorded as taken") { row(last) }
            }
            Section("Medication and insulin history") {
                if doses.isEmpty { Text("No medication or insulin entries.").foregroundStyle(.secondary) }
                ForEach(doses) { row($0) }
            }
        }.navigationTitle("Medications")
    }
}
