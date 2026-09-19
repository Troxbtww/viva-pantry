import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import pymupdf

from importer import (TextLine, extract_source, parse_nutrition,
                      parse_price_candidates, suggest_item)


class PriceParsingTests(unittest.TestCase):
    def test_currency_and_decimal_formats(self):
        for source, expected in [("Milk AED 4.95", 4.95), ("Milk 4,95 Dhs", 4.95),
                                 ("Rice AED 12", 12), ("Rice ١٢٫٥٠ درهم", 12.5),
                                 ("Bulk rice AED 1,234.50", 1234.5)]:
            with self.subTest(source=source):
                result = parse_price_candidates(source)
                self.assertEqual([row["price"] for row in result], [expected])

    def test_nutrition_and_weights_are_not_prices(self):
        result = parse_price_candidates("Protein 4.95 g\nEnergy 100 kcal\nMilk 500 ml\n4.95\n19/09/2026")
        self.assertEqual(result, [])

    def test_zero_negative_and_partial_numbers_are_not_prices(self):
        for text in ["Milk AED 0", "Milk AED -5", "Milk -5 AED", "Milk AED 4.999", "Milk 4.999 AED"]:
            with self.subTest(text=text):
                self.assertEqual(parse_price_candidates(text), [])

    def test_preserves_multiple_printed_prices_and_context(self):
        result = parse_price_candidates("Greek yoghurt 500 g\nWas AED 9.95 now AED 7.95")
        self.assertEqual([row["price"] for row in result], [9.95, 7.95])
        self.assertIn("Greek yoghurt", result[0]["raw_text"])

    def test_separate_currency_box(self):
        rows = [TextLine("Milk 1 L", 20, 20, 100, 35),
                TextLine("AED", 20, 50, 45, 65), TextLine("4.95", 50, 50, 95, 65)]
        result = parse_price_candidates("", lines=rows)
        self.assertEqual([row["price"] for row in result], [4.95])
        self.assertEqual(result[0]["label"], "Milk 1 L")

    def test_neighboring_flyer_columns_do_not_cross_match(self):
        rows = [TextLine("Plain yoghurt 500 g", 10, 10, 135, 25),
                TextLine("Chocolate milk 1 L", 230, 10, 360, 25),
                TextLine("AED 4.95", 10, 50, 70, 65),
                TextLine("AED 6.95", 230, 50, 300, 65)]
        items = [{"id": 1, "name": "Plain yoghurt", "package_size": "500g"},
                 {"id": 2, "name": "Chocolate milk", "package_size": "1L"}]
        result = parse_price_candidates("", items, lines=rows)
        self.assertEqual([row["item_id"] for row in result], [1, 2])

    def test_package_mismatch_is_not_matched(self):
        items = [{"id": 1, "name": "Greek yoghurt", "package_size": "500 g"}]
        self.assertIsNone(suggest_item("Greek yoghurt 150 g AED 4.95", items))
        self.assertEqual(suggest_item("Greek yoghurt 0.5 kg AED 4.95", items), 1)

    def test_duplicate_names_remain_ambiguous_without_size(self):
        items = [{"id": 1, "name": "Milk", "package_size": "1 L"},
                 {"id": 2, "name": "Milk", "package_size": "2 L"}]
        self.assertIsNone(suggest_item("Milk AED 4.95", items))
        self.assertEqual(suggest_item("Milk 1 L AED 4.95", items), 1)

    def test_numeric_package_size_and_multipack_count(self):
        items = [{"id": 1, "name": "Milk", "package_size": 200, "package_unit": "ml", "pack_count": 6}]
        self.assertIsNone(suggest_item("Milk 4 x 200 ml AED 4.95", items))
        self.assertIsNone(suggest_item("Milk 6 x 500 ml AED 4.95", items))
        self.assertEqual(suggest_item("Milk 6 x 200 ml AED 4.95", items), 1)


class NutritionParsingTests(unittest.TestCase):
    def test_single_column_missing_values_and_true_zero(self):
        result, warnings = parse_nutrition("Nutrition per 100 g\nEnergy 250 kJ / 60 kcal\nProtein 4.2 g\nFat 0 g\nSalt\nSugars <0.5 g")
        self.assertEqual(result["basis"], "per 100 g")
        self.assertIn({"label": "Fat", "value": "0", "unit": "g"}, result["values"])
        self.assertIn({"label": "Sugars", "value": "<0.5", "unit": "g"}, result["values"])
        self.assertFalse(any(row["label"] == "Salt" for row in result["values"]))
        self.assertEqual(len([row for row in result["values"] if row["label"] == "Energy"]), 2)
        self.assertEqual(warnings, [])

    def test_sodium_salt_and_saturated_fat_are_distinct(self):
        result, _ = parse_nutrition("Per serving\nServing size: 30 g\nSodium 25 mg\nSalt 0.1 g\nSaturated fat 1 g\nFat 3 g")
        self.assertEqual(result["serving_size"], "30 g")
        self.assertEqual([row["label"] for row in result["values"]], ["Sodium", "Salt", "Saturated fat", "Fat"])

    def test_multiple_basis_headers_suppress_values(self):
        result, warnings = parse_nutrition("Per 100 g | Per serving\nProtein 10 g 3 g\nFat 2 g 0.6 g")
        self.assertEqual(result["values"], [])
        self.assertEqual(result["basis"], "")
        self.assertTrue(warnings)

    def test_multiple_numeric_columns_without_units_are_ambiguous(self):
        result, warnings = parse_nutrition("Per 100 g\nProtein (g) 10 3\nFat (g) 2 0.6")
        self.assertEqual(result["values"], [])
        self.assertTrue(warnings)

    def test_daily_value_percent_does_not_become_second_column(self):
        result, warnings = parse_nutrition("Per serving\nProtein 4 g 8%\nSodium 20 mg 1%")
        self.assertEqual(len(result["values"]), 2)
        self.assertEqual(warnings, [])

    def test_unknown_basis_is_not_assumed(self):
        result, warnings = parse_nutrition("Protein 4.2 g")
        self.assertEqual(result["basis"], "")
        self.assertTrue(warnings)


class SourceExtractionTests(unittest.TestCase):
    def _pdf(self, directory, pages):
        path = Path(directory) / "flyer.pdf"
        with pymupdf.open() as document:
            for text in pages:
                page = document.new_page()
                if text:
                    page.insert_text((60, 80), text)
            document.save(path)
        return path

    def test_native_pdf_text_does_not_invoke_ocr(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self._pdf(directory, ["Greek yoghurt 500 g\nAED 7.95"])
            with patch("importer._ocr_lines", side_effect=AssertionError("should not use OCR")) as ocr:
                result = extract_source(path, "application/pdf", [{"id": 3, "name": "Greek yoghurt", "package_size": "500 g"}])
            ocr.assert_not_called()
        self.assertEqual(result["pages"][0]["page"], 1)
        self.assertTrue(result["pages"][0]["preview_available"])
        self.assertEqual(result["candidates"][0]["price"], 7.95)
        self.assertEqual(result["candidates"][0]["item_id"], 3)

    def test_scanned_page_uses_ocr(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self._pdf(directory, [""])
            with patch("importer._ocr_lines", return_value=[TextLine("Milk AED 4.95")]) as ocr:
                result = extract_source(path, "application/pdf", [])
            ocr.assert_called_once()
        self.assertEqual(result["candidates"][0]["price"], 4.95)

    def test_page_limit_is_explicit(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self._pdf(directory, ["Enough native text for a page"] * 41)
            result = extract_source(path, "application/pdf", [])
        self.assertEqual(len(result["pages"]), 40)
        self.assertTrue(any("first 40 of 41" in warning for warning in result["warnings"]))

    def test_ocr_failure_retains_manual_review_page(self):
        with tempfile.TemporaryDirectory() as directory:
            path = self._pdf(directory, [""])
            with patch("importer._ocr_lines", side_effect=RuntimeError("missing model")):
                result = extract_source(path, "application/pdf", [])
        self.assertEqual(len(result["pages"]), 1)
        self.assertEqual(result["candidates"], [])
        self.assertTrue(any("manually" in warning for warning in result["warnings"]))

    def test_invalid_pdf_returns_actionable_warning(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "broken.pdf"
            path.write_text("not a PDF")
            result = extract_source(path, "application/pdf", [])
        self.assertEqual(result["pages"], [])
        self.assertTrue(result["warnings"])

    def test_nutrition_ocr_boxes_on_same_row_are_combined(self):
        lines = [TextLine("Per 100 g", 10, 10, 100, 25),
                 TextLine("Protein", 10, 40, 70, 55), TextLine("4.2 g", 130, 41, 160, 55),
                 TextLine("Fat", 10, 70, 40, 85), TextLine("0 g", 130, 70, 155, 85)]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "photo.png"
            path.write_bytes(b"mock image")
            with patch("importer._ocr_lines", return_value=lines):
                result = extract_source(path, "image/png", [])
        self.assertEqual(result["nutrition_suggestions"]["values"],
                         [{"label": "Protein", "value": "4.2", "unit": "g"},
                          {"label": "Fat", "value": "0", "unit": "g"}])


if __name__ == "__main__":
    unittest.main()
