import unittest
from copy import deepcopy
from datetime import date, timedelta

from research import articles, digest, package


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.card = {
            "id": "test", "kind": "education", "title": "Example",
            "population": "Synthetic", "finding": "Example text",
            "limitations": "Example limitation", "evidence": "Test fixture",
            "sources": [{"url": "https://pubmed.ncbi.nlm.nih.gov/123/"}],
            "design_implication": "Internal note",
        }
        today = date.today().isoformat()
        self.approval = {"status": "approved", "digest": digest(self.card),
                         "reviewer": "Test fixture", "reviewed_on": today}
        self.check = {"checked_on": today, "records": {"123": {"priority_review": False}}}

    def build(self, card=None, approval=None, check=None):
        return package([card or self.card], {"test": approval or self.approval},
                       check or self.check, "test-version")

    def test_package_contains_only_patient_content(self):
        bundle = self.build()
        self.assertNotIn("design_implication", bundle["cards"][0])
        self.assertNotIn("reviewer", bundle["cards"][0])

    def test_pending_card_blocks_empty_release(self):
        with self.assertRaisesRegex(ValueError, "No reviewed"):
            self.build(approval={"status": "pending"})

    def test_edited_text_requires_fresh_approval(self):
        with self.assertRaisesRegex(ValueError, "content changed"):
            self.build(card={**self.card, "finding": "Modified text"})

    def test_missing_source_check_blocks_release(self):
        with self.assertRaisesRegex(ValueError, "must be checked"):
            self.build(check={**self.check, "records": {}})

    def test_stale_source_check_blocks_release(self):
        old_date = (date.today() - timedelta(days=31)).isoformat()
        with self.assertRaisesRegex(ValueError, "Refresh"):
            self.build(check={**self.check, "checked_on": old_date})

    def test_retraction_blocks_release(self):
        check = deepcopy(self.check)
        check["records"]["123"]["priority_review"] = True
        with self.assertRaisesRegex(ValueError, "publication notice"):
            self.build(check=check)

    def test_mixed_content_title_and_correction_import(self):
        xml = """<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>123</PMID>
        <Article><ArticleTitle>Test <i>title</i>.</ArticleTitle></Article>
        <CommentsCorrectionsList><CommentsCorrections RefType="ErratumIn"><PMID>456</PMID>
        </CommentsCorrections></CommentsCorrectionsList></MedlineCitation>
        </PubmedArticle></PubmedArticleSet>"""
        entry = dict(articles(xml))["123"]
        self.assertEqual(entry["title"], "Test title.")
        self.assertEqual(entry["notices"], [{"relation": "ErratumIn", "pmid": "456"}])
        self.assertTrue(entry["priority_review"])


if __name__ == "__main__":
    unittest.main()
