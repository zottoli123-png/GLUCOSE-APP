import CommonCrypto
import CryptoKit
import Foundation
import SQLite3
import Security

enum VaultError: LocalizedError {
    case unavailable, invalid, duplicate, conflict, unsupported, tooLarge
    var errorDescription: String? {
        switch self {
        case .unavailable: "Storage is unavailable. Unlock your phone and try again."
        case .invalid: "The passphrase or encrypted file could not be verified."
        case .duplicate: "This profile already exists on this device."
        case .conflict: "The profile changed. Lock it and unlock again before saving."
        case .unsupported: "This file needs a newer version of Glucose Journal."
        case .tooLarge: "The profile exceeds the supported storage size. Export your history."
        }
    }
}

struct Profile: Identifiable, Sendable {
    let id: UUID
    let updated: Date
}

struct VaultEnvelope: Codable, Sendable {
    static let maxBytes = 16 * 1024 * 1024
    let format: Int
    let id: UUID
    let salt: Data
    let sealed: Data

    var aad: Data { Data("GlucoseJournal:v\(format):\(id.uuidString)".utf8) }

    func key(passphrase: String) throws -> SymmetricKey {
        guard format == 1 else { throw VaultError.unsupported }
        guard salt.count == 16, sealed.count <= Self.maxBytes, passphrase.utf8.count <= 1024
        else { throw VaultError.invalid }
        let pass = Array(passphrase.utf8)
        var material = Data(count: 32)
        let status = material.withUnsafeMutableBytes { output in
            salt.withUnsafeBytes { saltBytes in
                pass.withUnsafeBytes { password in
                    CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2),
                        password.baseAddress?.assumingMemoryBound(to: Int8.self), password.count,
                        saltBytes.baseAddress?.assumingMemoryBound(to: UInt8.self), saltBytes.count,
                        CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), 600_000,
                        output.baseAddress?.assumingMemoryBound(to: UInt8.self), output.count)
                }
            }
        }
        guard status == kCCSuccess else { throw VaultError.invalid }
        return SymmetricKey(data: material)
    }

    func opened(with key: SymmetricKey) throws -> Journal {
        let plaintext: Data
        do { plaintext = try AES.GCM.open(AES.GCM.SealedBox(combined: sealed), using: key, authenticating: aad) }
        catch { throw VaultError.invalid }
        let journal = try JSONDecoder().decode(Journal.self, from: plaintext)
        guard journal.schema == 1 else { throw VaultError.unsupported }
        return journal
    }

    func replacing(_ journal: Journal, using key: SymmetricKey) throws -> Self {
        let encoded = try JSONEncoder().encode(journal)
        guard encoded.count <= Self.maxBytes - 28 else { throw VaultError.tooLarge }
        guard let value = try AES.GCM.seal(encoded, using: key, authenticating: aad).combined
        else { throw VaultError.unavailable }
        return Self(format: format, id: id, salt: salt, sealed: value)
    }

    static func fresh() throws -> Self {
        var salt = Data(count: 16)
        let status = salt.withUnsafeMutableBytes { bytes in
            SecRandomCopyBytes(kSecRandomDefault, bytes.count, bytes.baseAddress!)
        }
        guard status == errSecSuccess else { throw VaultError.unavailable }
        return Self(format: 1, id: UUID(), salt: salt, sealed: Data())
    }
}

actor Vault {
    private var db: OpaquePointer?
    private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    private func connection() throws -> OpaquePointer {
        if let db { return db }
        let fm = FileManager.default
        var folder = try fm.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                appropriateFor: nil, create: true).appendingPathComponent("Vault", isDirectory: true)
        try fm.createDirectory(at: folder, withIntermediateDirectories: true,
                               attributes: [.protectionKey: FileProtectionType.complete])
        try fm.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: folder.path)
        var options = URLResourceValues()
        options.isExcludedFromBackup = true
        try folder.setResourceValues(options)
        var handle: OpaquePointer?
        let url = folder.appendingPathComponent("journal.sqlite")
        guard sqlite3_open_v2(url.path, &handle, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK,
              let handle else {
            sqlite3_close(handle)
            throw VaultError.unavailable
        }
        do {
            try fm.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: url.path)
            sqlite3_busy_timeout(handle, 3000)
            for sql in ["PRAGMA journal_mode=DELETE", "PRAGMA synchronous=FULL", "PRAGMA secure_delete=ON",
                        "CREATE TABLE IF NOT EXISTS profiles(id TEXT PRIMARY KEY, updated REAL NOT NULL, revision INTEGER NOT NULL, envelope BLOB NOT NULL)"] {
                guard sqlite3_exec(handle, sql, nil, nil, nil) == SQLITE_OK else { throw VaultError.unavailable }
            }
            db = handle
            return handle
        } catch {
            sqlite3_close(handle)
            throw error
        }
    }

    private func withStatement<T>(_ sql: String, _ action: (OpaquePointer, OpaquePointer) throws -> T) throws -> T {
        let db = try connection()
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK,
              let statement else { throw VaultError.unavailable }
        defer { sqlite3_finalize(statement) }
        return try action(db, statement)
    }

    func profiles() throws -> [Profile] {
        try withStatement("SELECT id, updated FROM profiles ORDER BY updated DESC, id") { _, stmt in
            var profiles: [Profile] = []
            while true {
                let code = sqlite3_step(stmt)
                if code == SQLITE_DONE { return profiles }
                guard code == SQLITE_ROW, let raw = sqlite3_column_text(stmt, 0),
                      let id = UUID(uuidString: String(cString: raw)) else { throw VaultError.unavailable }
                profiles.append(Profile(id: id, updated: Date(timeIntervalSince1970: sqlite3_column_double(stmt, 1))))
            }
        }
    }

    func load(_ id: UUID) throws -> (VaultEnvelope, Int64) {
        try withStatement("SELECT envelope, revision FROM profiles WHERE id = ?") { _, stmt in
            guard sqlite3_bind_text(stmt, 1, id.uuidString, -1, transient) == SQLITE_OK,
                  sqlite3_step(stmt) == SQLITE_ROW, let blob = sqlite3_column_blob(stmt, 0)
            else { throw VaultError.unavailable }
            let data = Data(bytes: blob, count: Int(sqlite3_column_bytes(stmt, 0)))
            let envelope = try JSONDecoder().decode(VaultEnvelope.self, from: data)
            guard envelope.id == id else { throw VaultError.invalid }
            return (envelope, sqlite3_column_int64(stmt, 1))
        }
    }

    func delete(_ id: UUID, expected: Int64) throws {
        try withStatement("DELETE FROM profiles WHERE id = ? AND revision = ?") { db, stmt in
            guard sqlite3_bind_text(stmt, 1, id.uuidString, -1, transient) == SQLITE_OK,
                  sqlite3_bind_int64(stmt, 2, expected) == SQLITE_OK,
                  sqlite3_step(stmt) == SQLITE_DONE else { throw VaultError.unavailable }
            guard sqlite3_changes(db) == 1 else { throw VaultError.conflict }
        }
    }

    func save(_ envelope: VaultEnvelope, expected: Int64?) throws -> Int64 {
        let data = try JSONEncoder().encode(envelope)
        let sql = expected == nil
            ? "INSERT INTO profiles (envelope, updated, id, revision) VALUES (?, ?, ?, 1)"
            : "UPDATE profiles SET envelope = ?, updated = ?, revision = revision + 1 WHERE id = ? AND revision = ?"
        return try withStatement(sql) { db, stmt in
            let bind = data.withUnsafeBytes {
                sqlite3_bind_blob(stmt, 1, $0.baseAddress, Int32($0.count), transient)
            }
            guard bind == SQLITE_OK,
                  sqlite3_bind_double(stmt, 2, Date().timeIntervalSince1970) == SQLITE_OK,
                  sqlite3_bind_text(stmt, 3, envelope.id.uuidString, -1, transient) == SQLITE_OK
            else { throw VaultError.unavailable }
            if let expected, sqlite3_bind_int64(stmt, 4, expected) != SQLITE_OK { throw VaultError.unavailable }
            let result = sqlite3_step(stmt)
            if expected == nil && result == SQLITE_CONSTRAINT { throw VaultError.duplicate }
            guard result == SQLITE_DONE else { throw VaultError.unavailable }
            guard sqlite3_changes(db) == 1 else { throw VaultError.conflict }
            return (expected ?? 0) + 1
        }
    }
}
