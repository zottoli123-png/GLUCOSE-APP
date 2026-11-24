import CoreText
import SwiftUI
import UIKit
import UniformTypeIdentifiers

struct Editor: View {
    @Environment(\.dismiss) private var dismiss
    @State private var entry: Entry
    @State private var input: [String]
    @State private var error: String?
    @State private var saving = false
    let mmol: Bool
    let busy: Bool
    let save: (Entry) async throws -> Void

    init(entry: Entry, mmol: Bool, busy: Bool, save: @escaping (Entry) async throws -> Void) {
        _entry = State(initialValue: entry)
        _input = State(initialValue: entry.kind.fields.indices.map { index in
            guard entry.values.indices.contains(index), let value = entry.values[index] else { return "" }
            let displayed = entry.kind == .glucose && mmol ? value / 18.0182 : value
            return displayed.formatted(.number.grouping(.never).precision(.fractionLength(0...3)))
        })
        self.mmol = mmol
        self.busy = busy
        self.save = save
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Details") {
                    ForEach(entry.kind.fields.indices, id: \.self) { index in
                        let label = entry.kind == .glucose && mmol ? "Glucose (mmol/L)" : entry.kind.fields[index]
                        TextField(label, text: $input[index])
                            .keyboardType(.decimalPad).accessibilityLabel(label)
                    }
                    if let label = entry.kind.detailLabel { TextField(label, text: $entry.detail) }
                    if entry.kind == .medication { TextField("Unit as prescribed", text: $entry.unit) }
                    if entry.kind == .medication || entry.kind == .insulin {
                        Picker("Record status", selection: $entry.doseStatus) {
                            ForEach(DoseStatus.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                        }
                    }
                    DatePicker("Measured or happened at", selection: $entry.measuredAt)
                    TextField("Tag (optional)", text: $entry.tag)
                    TextField(entry.kind == .note ? "Note" : "Note (optional)", text: $entry.notes, axis: .vertical)
                        .lineLimit(2...8)
                }
                if let error { Text(error).foregroundStyle(.red) }
            }
            .disabled(saving || busy)
            .navigationTitle(entry.kind.rawValue)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) { Button("Save") { submit() }.disabled(saving || busy) }
            }
        }
        .interactiveDismissDisabled(saving)
    }

    func submit() {
        var result = entry
        var values: [Double?] = []
        for (index, text) in input.enumerated() {
            let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if text.isEmpty {
                if index < entry.kind.requiredValues {
                    error = "Enter the required measurement."
                    return
                }
                values.append(nil)
                continue
            }
            let factor = entry.kind == .glucose && mmol ? 18.0182 : 1
            guard let number = try? FloatingPointFormatStyle<Double>(locale: .current).parseStrategy.parse(text),
                  number.isFinite, abs(number * factor) < 1_000_000,
                  number >= 0 || entry.kind == .temperature else {
                error = "Check the value and unit for \(entry.kind.fields[index])."
                return
            }
            if entry.values.indices.contains(index), let original = entry.values[index],
               text == (original / factor).formatted(.number.grouping(.never).precision(.fractionLength(0...3))) {
                values.append(original)
            } else { values.append(number * factor) }
        }
        let name = result.detail.trimmingCharacters(in: .whitespacesAndNewlines)
        let note = result.notes.trimmingCharacters(in: .whitespacesAndNewlines)
        if (result.kind == .medication || result.kind == .insulin || result.kind == .exercise) && name.isEmpty {
            error = "Enter a name for this entry."
            return
        }
        if result.kind == .note && note.isEmpty {
            error = "Enter a note before saving."
            return
        }
        if result.kind == .medication && values.contains(where: { $0 != nil }) &&
            result.unit.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            error = "Enter the unit for this amount."
            return
        }
        result.values = values
        result.detail = name
        result.notes = note
        saving = true
        error = nil
        Task {
            defer { saving = false }
            do { try await save(result); dismiss() }
            catch { self.error = error.localizedDescription }
        }
    }
}

struct SettingsView: View {
    @ObservedObject var session: Session
    let journal: Journal
    @State private var filename = ""
    @State private var document = ExportFile()
    @State private var exporting = false

    @State private var confirmingDelete = false

    var body: some View {
        Form {
            Section("This profile") {
                LabeledContent("Name", value: journal.name)
                if let code = session.profileCode { LabeledContent("Profile code", value: code) }
                Picker("Glucose units", selection: Binding(get: { journal.useMMOL }, set: { mmol in
                    var next = journal
                    next.useMMOL = mmol
                    Task { _ = await session.update(next) }
                })) {
                    Text("mg/dL").tag(false)
                    Text("mmol/L").tag(true)
                }.disabled(session.busy)
                Button("Lock and switch profile") { session.lock() }
            }
            Section("Care and supplies") {
                NavigationLink("My care plan") {
                    NotePage(title: "My care plan", text: journal.carePlan) { text in
                        var next = journal
                        next.carePlan = text
                        return await session.update(next)
                    }
                }
                NavigationLink("Questions for my visit") {
                    NotePage(title: "Questions for my visit", text: journal.visitQuestions) { text in
                        var next = journal
                        next.visitQuestions = text
                        return await session.update(next)
                    }
                }
                NavigationLink("Refill and supply notes") {
                    NotePage(title: "Refill and supply notes", text: journal.refillNotes) { text in
                        var next = journal
                        next.refillNotes = text
                        return await session.update(next)
                    }
                }
            }
            Section("Tools") {
                NavigationLink("Reminders") { ReminderPage(session: session, journal: session.journal ?? journal) }
                NavigationLink("Apple Health") { HealthPage(session: session) }
                NavigationLink("Read a photo") { PhotoTextPage() }
            }
            Section("Privacy and backup") {
                Button("Save encrypted backup") {
                    do {
                        document = try ExportFile(bytes: session.backup())
                        filename = "GlucoseJournal-Backup-" + Date().formatted(.iso8601.year().month().day())
                        exporting = true
                    } catch { session.message = error.localizedDescription }
                }.disabled(session.busy)
                Text("Your passphrase is required to unlock the backup. Save a fresh copy before changing phones.")
                    .font(.footnote)
                Button("Delete this profile", role: .destructive) { confirmingDelete = true }
                    .disabled(session.busy)
            }
        }
        .navigationTitle("Settings")
        .confirmationDialog("Delete this profile and its local history?", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("Delete profile", role: .destructive) { Task { await session.deleteCurrentProfile() } }
        } message: {
            Text("Any backup or report you already exported will still exist where you saved it.")
        }
        .fileExporter(isPresented: $exporting, document: document, contentType: .json,
                      defaultFilename: filename) { result in
            document = ExportFile()
            if case let .failure(error) = result { session.message = error.localizedDescription }
        }
    }
}

struct NotePage: View {
    let title: String
    @State var text: String
    let save: (String) async -> Bool
    @Environment(\.dismiss) private var dismiss
    @State private var saving = false
    var body: some View {
        TextEditor(text: $text)
            .accessibilityLabel(title).padding()
            .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                Button("Save") {
                    saving = true
                    Task {
                        defer { saving = false }
                        if await save(text) { dismiss() }
                    }
                }.disabled(saving)
            }
    }
}

struct InsightsView: View {
    let journal: Journal
    @State private var from = Calendar.current.date(byAdding: .day, value: -29, to: Date()) ?? Date()
    @State private var until = Date()
    @State private var filter: Measure?
    @State private var includeQuestions = false
    @State private var includeName = false
    @State private var exporting = false
    @State private var document = ExportFile()
    @State private var type: UTType = .commaSeparatedText
    @State private var issue = ""
    @State private var preparing = false
    private let evidence = EvidenceBundle.load()

    var selected: [Entry] {
        let cal = Calendar.current
        let start = cal.startOfDay(for: from)
        guard let end = cal.date(byAdding: .day, value: 1, to: cal.startOfDay(for: until)), start < end
        else { return [] }
        return journal.entries.filter {
            $0.measuredAt >= start && $0.measuredAt < end && (filter == nil || $0.kind == filter)
        }.sorted { $0.measuredAt > $1.measuredAt }
    }

    var body: some View {
        Form {
            Section("Visit report") {
                DatePicker("From", selection: $from, displayedComponents: .date)
                DatePicker("Through", selection: $until, displayedComponents: .date)
                Picker("Entries", selection: $filter) {
                    Text("All types").tag(Measure?.none)
                    ForEach(Measure.allCases) { Text($0.rawValue).tag(Optional($0)) }
                }
                Text("\(selected.count) matching entries")
                Toggle("Include profile name in PDF", isOn: $includeName)
                Toggle("Include visit questions in PDF", isOn: $includeQuestions)
                Button("Save PDF") { export(.pdf) }.disabled(selected.isEmpty || preparing)
                Button("Save CSV") { export(.commaSeparatedText) }.disabled(selected.isEmpty || preparing)
                Text("Reports contain health information. Choose where you save or share them. Use Settings for an encrypted backup.")
                    .font(.footnote).foregroundStyle(.secondary)
                if !issue.isEmpty { Text(issue).foregroundStyle(.red) }
            }
            Section("Evidence library") {
                if let evidence {
                    Text("Edition " + evidence.version).font(.footnote)
                    ForEach(evidence.cards) { card in
                        NavigationLink(card.title) {
                            List {
                                Section("Finding") { Text(card.finding) }
                                Section("Who this applies to") { Text(card.population) }
                                Section("Limitations") { Text(card.limitations) }
                                Section("Sources") {
                                    Text(card.evidence)
                                    Text("Reviewed " + card.reviewed_on)
                                    ForEach(Array(card.sources.enumerated()), id: \.offset) { item in
                                        Link("Source \(item.offset + 1)", destination: item.element.url)
                                    }
                                }
                            }.navigationTitle(card.title).navigationBarTitleDisplayMode(.inline)
                        }
                    }
                } else { Text("Reviewed education will appear here when it is included in an app release.").foregroundStyle(.secondary) }
            }
        }
        .navigationTitle("Insights")
        .fileExporter(isPresented: $exporting, document: document, contentType: type,
                      defaultFilename: "GlucoseJournal-Visit") { result in
            document = ExportFile()
            if case let .failure(error) = result { issue = error.localizedDescription }
        }
    }

    func export(_ format: UTType) {
        issue = ""
        preparing = true
        type = format
        let items = selected
        let source = journal
        let fields = (includeName, includeQuestions)
        let range = from.formatted(date: .abbreviated, time: .omitted) + " through " +
            until.formatted(date: .abbreviated, time: .omitted)
        Task {
            let data = await Task.detached(priority: .userInitiated) {
                if format == .pdf {
                    let lines = items.map { entry in
                        let status = entry.kind == .insulin || entry.kind == .medication ? entry.doseStatus.rawValue : ""
                        return [entry.measuredAt.formatted(date: .numeric, time: .shortened),
                                entry.kind.rawValue, entry.recordSource, entry.detail, status, entry.displayValues(mmol: source.useMMOL),
                                entry.tag, entry.notes].filter { !$0.isEmpty }.joined(separator: "  |  ")
                    }
                    let content = ["Glucose Journal · Visit report", range,
                                   "\(items.count) recorded entries",
                                   fields.0 ? source.name : "",
                                   fields.1 ? ["Visit questions", source.visitQuestions].joined(separator: "\n") : ""]
                        + lines
                    return makePDF(content.filter { !$0.isEmpty }.joined(separator: "\n\n"))
                }
                return Data(source.csv(items).utf8)
            }.value
            document = ExportFile(bytes: data)
            preparing = false
            exporting = true
        }
    }
}

private func makePDF(_ text: String) -> Data {
    let page = CGRect(x: 0, y: 0, width: 612, height: 792)
    let content = page.insetBy(dx: 44, dy: 44)
    let font = CTFontCreateWithName("Helvetica" as CFString, 12, nil)
    let attributed = NSAttributedString(string: text, attributes: [
        NSAttributedString.Key(kCTFontAttributeName as String): font
    ])
    let framesetter = CTFramesetterCreateWithAttributedString(attributed)
    let renderer = UIGraphicsPDFRenderer(bounds: page)
    return renderer.pdfData { pdf in
        var cursor = 0
        while cursor < attributed.length {
            pdf.beginPage()
            let context = pdf.cgContext
            context.saveGState()
            context.translateBy(x: 0, y: page.height)
            context.scaleBy(x: 1, y: -1)
            context.textMatrix = .identity
            let path = CGPath(rect: content, transform: nil)
            let frame = CTFramesetterCreateFrame(framesetter, CFRange(location: cursor, length: 0), path, nil)
            CTFrameDraw(frame, context)
            context.restoreGState()
            let count = CTFrameGetVisibleStringRange(frame).length
            guard count > 0 else { break }
            cursor += count
        }
    }
}
