"""Exercise the SQL shipped in Vault.swift using the system SQLite engine."""
import re
import sqlite3
import unittest
from pathlib import Path

SOURCE = (Path(__file__).resolve().parents[1] / "App" / "Vault.swift").read_text()


def statement(prefix):
    return re.search(r'"(' + re.escape(prefix) + r'[^"]*)"', SOURCE)[1]


class StorageTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)
        self.db.execute(statement("CREATE TABLE"))
        self.db.execute(statement("INSERT INTO"), (b"cipher-a", 1, "A"))
        self.db.execute(statement("INSERT INTO"), (b"cipher-b", 2, "B"))

    def load(self, profile):
        return self.db.execute(statement("SELECT envelope"), (profile,)).fetchone()

    def test_profiles_have_independent_rows(self):
        self.db.execute(statement("UPDATE profiles"), (b"new-a", 3, "A", 1))
        self.assertEqual(self.load("A"), (b"new-a", 2))
        self.assertEqual(self.load("B"), (b"cipher-b", 1))

    def test_stale_revision_does_not_overwrite(self):
        self.db.execute(statement("UPDATE profiles"), (b"new-a", 3, "A", 1))
        attempt = self.db.execute(statement("UPDATE profiles"), (b"old-state", 4, "A", 1))
        self.assertEqual(attempt.rowcount, 0)
        self.assertEqual(self.load("A"), (b"new-a", 2))

    def test_restore_cannot_overwrite_existing_profile(self):
        with self.assertRaises(sqlite3.IntegrityError):
            self.db.execute(statement("INSERT INTO"), (b"backup-a", 3, "A"))
        self.assertEqual(self.load("A"), (b"cipher-a", 1))

    def test_delete_requires_current_revision_and_matches_one_profile(self):
        stale = self.db.execute(statement("DELETE FROM"), ("A", 0))
        self.assertEqual(stale.rowcount, 0)
        self.assertEqual(self.load("A"), (b"cipher-a", 1))
        self.db.execute(statement("DELETE FROM"), ("A", 1))
        self.assertIsNone(self.load("A"))
        self.assertEqual(self.load("B"), (b"cipher-b", 1))


if __name__ == "__main__":
    unittest.main(verbosity=2)
