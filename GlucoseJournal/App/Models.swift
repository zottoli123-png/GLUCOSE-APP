import Foundation

enum Measure: String, CaseIterable, Codable, Identifiable {
    case glucose = "Glucose", weight = "Weight", pressure = "Blood pressure"
    case insulin = "Insulin", a1c = "Lab A1C", medication = "Medication"
    case oxygen = "Oxygen", temperature = "Temperature", exercise = "Exercise"
    case ketones = "Ketones", carbs = "Carbs", note = "Note", inr = "INR"
    var id: Self { self }
    var fields: [String] {
        switch self {
        case .glucose: ["Glucose (mg/dL)"]
        case .weight: ["Weight (lb)"]
        case .pressure: ["Systolic (mmHg)", "Diastolic (mmHg)", "Heart rate (bpm)"]
        case .insulin: ["Amount (units)"]
        case .a1c: ["Lab A1C (%)"]
        case .medication: ["Amount"]
        case .oxygen: ["SpO₂ (%)", "Heart rate (bpm)"]
        case .temperature: ["Temperature (°F)"]
        case .exercise: ["Duration (min)"]
        case .ketones: ["Blood ketones (mmol/L)"]
        case .carbs: ["Carbs (g)", "Fat (g)", "Fiber (g)", "Sugar (g)", "Protein (g)", "Calories (kcal)"]
        case .note: []
        case .inr: ["INR"]
        }
    }
    var detailLabel: String? {
        switch self {
        case .medication: "Medication name"
        case .insulin: "Insulin name"
        case .exercise: "Activity"
        case .carbs: "Food"
        default: nil
        }
    }
    var requiredValues: Int {
        switch self {
        case .note, .exercise, .medication: 0
        case .pressure: 2
        default: 1
        }
    }
}

enum DoseStatus: String, CaseIterable, Codable {
    case scheduled = "Scheduled", taken = "Taken", skipped = "Skipped", unsure = "Unsure"
}

struct Entry: Identifiable, Codable {
    var id = UUID()
    var kind: Measure = .glucose
    var measuredAt = Date()
    var recordedAt = Date()
    var values: [Double?] = []
    var detail = ""
    var unit = ""
    var notes = ""
    var tag = ""
    var doseStatus: DoseStatus = .unsure
    var source: String?
    var recordSource: String { source ?? "Manual" }
    var firstValue: Double? { values.first ?? nil }

    func displayValues(mmol: Bool) -> String {
        zip(kind.fields, values).compactMap { label, value -> String? in
            guard let value else { return nil }
            if kind == .glucose && mmol {
                return (value / 18.0182).formatted(.number.precision(.fractionLength(1))) + " mmol/L"
            }
            let formatted = value.formatted(.number.precision(.fractionLength(0...3)))
            return kind == .medication ? [formatted, unit].joined(separator: " ") : "\(label): \(formatted)"
        }.joined(separator: " · ")
    }
}

struct Journal: Codable {
    var schema = 1
    var name = ""
    var useMMOL = false
    var carePlan = ""
    var visitQuestions = ""
    var refillNotes = ""
    var entries: [Entry] = []
    var reminders: [JournalReminder]?
    var removedImportIDs: [UUID]?

    func csv(_ selected: [Entry]) -> String {
        let header = "ID,Type,Measured at,Recorded at,Source,Name,Status,Tag,Values,Notes\r\n"
        let clock = ISO8601DateFormatter()
        let rows = selected.map { e in
            let status = e.kind == .insulin || e.kind == .medication ? e.doseStatus.rawValue : ""
            return [e.id.uuidString, e.kind.rawValue, clock.string(from: e.measuredAt),
                    clock.string(from: e.recordedAt), e.recordSource, e.detail, status,
                    e.tag, e.displayValues(mmol: useMMOL), e.notes].map(Self.csvCell).joined(separator: ",")
        }
        return header + rows.joined(separator: "\r\n") + "\r\n"
    }

    static func csvCell(_ value: String) -> String {
        let visible = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let formula = visible.first.map { "=+-@".contains($0) } ?? false
        let safe = formula ? "'" + value : value
        return "\"" + safe.replacingOccurrences(of: "\"", with: "\"\"") + "\""
    }
}

struct EvidenceBundle: Codable {
    struct Card: Codable, Identifiable {
        struct Source: Codable { var url: URL }
        var id: String
        var title: String
        var population: String
        var finding: String
        var limitations: String
        var evidence: String
        var sources: [Source]
        var reviewed_on: String
    }
    var schema: Int
    var version: String
    var cards: [Card]
    static func load() -> Self? {
        guard let url = Bundle.main.url(forResource: "evidence", withExtension: "bundle.json", subdirectory: "Resources"),
              let data = try? Data(contentsOf: url),
              let bundle = try? JSONDecoder().decode(Self.self, from: data),
              bundle.schema == 1 else { return nil }
        return bundle
    }
}
