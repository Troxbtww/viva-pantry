"""Local, review-only extraction for product photographs and weekly PDF flyers.

No extraction result is persisted here. In particular, an uncertain product match
or a nutrition table with two numeric columns must not silently become a fact.
"""
from __future__ import annotations

import io
import re
import threading
import unicodedata
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any


MAX_PDF_PAGES = 40
MAX_IMAGE_EDGE = 2600
_OCR_ENGINE: Any = None
_OCR_LOCK = threading.Lock()
_DIGITS = str.maketrans("٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹٫", "01234567890123456789.")
_CURRENCY = r"(?:\bAED\b|\bDHS?\b\.?|\bDIRHAMS?\b|د\s*\.?\s*إ\.?|درهم)"
_NUMBER = r"(?:\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{1,5}(?:[.,]\d{1,2})?)"
_PRICE = re.compile(
    rf"(?:{_CURRENCY})[ \t.:]*(?P<before>{_NUMBER})(?![\d.,])"
    rf"|(?<![\d.,-])(?P<after>{_NUMBER})[ \t]*(?:{_CURRENCY})",
    re.IGNORECASE,
)
_CURRENCY_ONLY = re.compile(rf"^\s*{_CURRENCY}[\s.:]*$", re.IGNORECASE)
_PLAIN_PRICE = re.compile(rf"^\s*({_NUMBER})(?:\s*/-)?\s*$")
_PACK = re.compile(r"(?<!\w)(\d+(?:[.,]\d+)?)\s*(kg|grams?|g|ml|litres?|liters?|l)\b", re.I)
_CONDITIONAL = re.compile(r"\b(buy\s+\d|\d\s+for|member|loyalty|minimum spend|with purchase|was|rrp)\b", re.I)


@dataclass(frozen=True)
class TextLine:
    text: str
    x0: float = 0
    y0: float = 0
    x1: float = 0
    y1: float = 0


def _normalized(text: str) -> str:
    return unicodedata.normalize("NFKC", text).translate(_DIGITS).replace("\u00a0", " ").replace("−", "-")


def _tokens(text: str) -> set[str]:
    return set(re.findall(r"[^\W_]+", _normalized(text).casefold()))


def _price_number(value: str) -> float | None:
    if "," in value and "." in value:
        value = value.replace(",", "")
    elif "," in value:
        value = value.replace(",", "" if re.fullmatch(r"\d{1,3}(?:,\d{3})+", value) else ".")
    try:
        result = Decimal(value)
        return float(result) if Decimal("0") < result <= Decimal("99999") else None
    except InvalidOperation:
        return None


def _pack_sizes(text: str) -> set[tuple[str, Decimal]]:
    sizes = set()
    for value, unit in _PACK.findall(_normalized(text)):
        unit = unit.casefold()
        number = Decimal(value.replace(",", "."))
        family = "volume" if unit in {"ml", "l", "litre", "litres", "liter", "liters"} else "mass"
        if unit in {"kg", "l", "litre", "litres", "liter", "liters"}:
            number *= 1000
        sizes.add((family, number))
    return sizes


def suggest_item(context: str, items: list[dict]) -> int | None:
    """Require all name and brand tokens; ambiguity deliberately has no match."""
    present = _tokens(context)
    visible_sizes = _pack_sizes(context)
    matches = []
    for item in items:
        name = str(item.get("name") or "").strip()
        required = _tokens(name) | _tokens(str(item.get("brand") or ""))
        if not required or not required.issubset(present):
            continue
        pack = str(item.get("package_size") or item.get("pack_size") or "")
        if item.get("package_unit"):
            pack += " " + str(item["package_unit"])
        if not pack and item.get("pack_amount") is not None:
            pack = f"{item['pack_amount']} {item.get('pack_unit', '')}"
        expected_sizes = _pack_sizes(pack)
        if expected_sizes and visible_sizes and not expected_sizes.intersection(visible_sizes):
            continue
        visible_count = re.search(r"\b(\d+)\s*[x×]\s*\d", context, re.I)
        if visible_count and item.get("pack_count") is not None:
            if int(visible_count.group(1)) != int(item["pack_count"]):
                continue
        if item.get("id") is not None:
            matches.append(item["id"])
    return matches[0] if len(matches) == 1 else None


def _nearby(lines: list[TextLine], index: int) -> list[int]:
    line = lines[index]
    if not any(row.x1 or row.y1 for row in lines):
        result = [index]
        for direction in (-1, 1):
            for distance in range(1, 3):
                other = index + direction * distance
                if not 0 <= other < len(lines):
                    break
                if _PRICE.search(_normalized(lines[other].text)):
                    break
                result.append(other)
        return sorted(result)
    height = max(line.y1 - line.y0, 8)
    neighbors = []
    for other, row in enumerate(lines):
        if other == index:
            continue
        # Different flyer columns must not lend their product names to this price.
        horizontal_gap = max(row.x0 - line.x1, line.x0 - row.x1, 0)
        vertical_gap = max(row.y0 - line.y1, line.y0 - row.y1, 0)
        if horizontal_gap <= max(30, height * 2) and vertical_gap <= max(75, height * 6):
            if not _PRICE.search(_normalized(row.text)):
                neighbors.append((vertical_gap + horizontal_gap * 2, other))
    selected = [index] + [other for _, other in sorted(neighbors)[:5]]
    return sorted(selected, key=lambda other: (lines[other].y0, lines[other].x0))


def _is_label(text: str) -> bool:
    value = _normalized(text).strip(" .:/-|")
    if value.casefold() in {"viva", "now", "only", "price", "offer", "special offer", "a e d"}:
        return False
    return bool(re.search(r"[^\W\d_]", value)) and not _CURRENCY_ONLY.fullmatch(value) and not _PLAIN_PRICE.fullmatch(value)


def parse_price_candidates(text: str, items: list[dict] | None = None, page: int = 1,
                           lines: list[TextLine] | None = None) -> list[dict]:
    """Recognize explicit AED/Dh amounts, retaining nearby source text for review."""
    items = items or []
    rows = lines if lines is not None else [TextLine(line.strip()) for line in text.splitlines() if line.strip()]
    candidates = []
    seen = set()
    for index, row in enumerate(rows):
        normalized = _normalized(row.text)
        nearby = _nearby(rows, index)
        matches = list(_PRICE.finditer(normalized))
        values = [(match.group("before") or match.group("after"), match.span()) for match in matches]
        # A currency symbol is sometimes in its own PDF/OCR text box.
        plain = _PLAIN_PRICE.fullmatch(normalized)
        if not values and plain:
            currencies = [other for other in nearby if _CURRENCY_ONLY.fullmatch(_normalized(rows[other].text))]
            if currencies:
                values = [(plain.group(1), (0, len(normalized)))]
        if not values:
            continue
        raw = "\n".join(rows[other].text for other in nearby)[:1800]
        cleaned = _PRICE.sub("", normalized).strip(" .:/-|")
        label_options = [rows[other].text.strip() for other in nearby if other != index and _is_label(rows[other].text)]
        label = cleaned if _is_label(cleaned) else (label_options[0] if label_options else "Unidentified item")
        item_id = suggest_item(raw, items)
        for value, span in values:
            amount = _price_number(value)
            if amount is None:
                continue
            key = (index, span, amount)
            if key in seen:
                continue
            seen.add(key)
            candidates.append({"page": page, "label": label[:180], "price": amount,
                               "item_id": item_id, "confidence": "suggested" if item_id is not None else "needs_review",
                               "raw_text": raw})
    return candidates


_NUTRIENTS = [
    (r"(?:total\s+)?saturated\s+fat|(?:of\s+which\s+)?saturates", "Saturated fat"),
    (r"(?:total\s+)?trans\s+fat", "Trans fat"),
    (r"(?:total\s+)?(?:carbohydrates?|carbs)", "Carbohydrate"),
    (r"(?:of\s+which\s+)?(?:total\s+)?sugars?", "Sugars"),
    (r"(?:dietary\s+)?fib(?:er|re)", "Fibre"),
    (r"(?:total\s+)?fat", "Fat"),
    (r"proteins?", "Protein"),
    (r"sodium", "Sodium"),
    (r"salt", "Salt"),
    (r"cholesterol", "Cholesterol"),
    (r"potassium", "Potassium"),
    (r"calcium", "Calcium"),
    (r"iron", "Iron"),
    (r"energy|calories", "Energy"),
]
_QUANTITY = re.compile(r"(?<![\w.])([<>≤≥]?\s*\d+(?:[.,]\d+)?)\s*(kcal|kj|mcg|µg|μg|mg|g|%)?(?!\w)", re.I)


def parse_nutrition(text: str) -> tuple[dict, list[str]]:
    """Read unambiguous single-column rows without inventing missing values."""
    text = _normalized(text)
    result = {"basis": "", "serving_size": "", "values": []}
    warnings = []
    bases = set()
    for match in re.finditer(r"\bper\s*(100\s*(?:g|ml)|serving|portion)\b", text, re.I):
        value = re.sub(r"\s+", "", match.group(1).casefold())
        bases.add("per serving" if value in {"serving", "portion"} else "per 100 " + ("ml" if "ml" in value else "g"))
    if len(bases) == 1:
        result["basis"] = next(iter(bases))
    serving = re.search(r"\bserving\s+size\s*[:\-]?\s*([^\r\n]{1,80})", text, re.I)
    if serving:
        result["serving_size"] = serving.group(1).strip()
    ambiguous = len(bases) > 1
    rows = [row.strip() for row in text.splitlines() if row.strip()]
    seen = {}
    for row in rows:
        for pattern, label in _NUTRIENTS:
            match = re.match(rf"^(?:{pattern})\b\s*[:\-]?\s*(.*)$", row, re.I)
            if not match:
                continue
            tail = match.group(1)
            quantities = [(value.strip().replace(",", "."), (unit or "").lower())
                          for value, unit in _QUANTITY.findall(tail) if unit != "%"]
            unit_in_header = re.match(r"^\s*[\[(]?(kcal|kj|mcg|µg|μg|mg|g)[\])]?(?:\s|$)", tail, re.I)
            if not quantities:
                break
            quantities = [(value, unit or (unit_in_header.group(1).lower() if unit_in_header else "kcal" if row.lower().startswith("calories") else ""))
                          for value, unit in quantities]
            # Energy may legitimately list kJ and kcal for the same column.
            units = [unit for _, unit in quantities]
            if len(quantities) > 1 and not (label == "Energy" and len(quantities) == 2 and set(units) == {"kj", "kcal"}):
                ambiguous = True
                break
            for value, unit in quantities:
                unit = "kJ" if unit == "kj" else "µg" if unit in {"mcg", "μg"} else unit
                key = (label, unit)
                if key in seen and seen[key] != value:
                    ambiguous = True
                elif key not in seen:
                    seen[key] = value
                    result["values"].append({"label": label, "value": value, "unit": unit})
            break
    if ambiguous:
        result["values"] = []
        result["basis"] = "" if len(bases) > 1 else result["basis"]
        warnings.append("Nutrition has multiple or conflicting columns. Read the label and enter the intended column manually.")
    elif result["values"] and not result["basis"]:
        warnings.append("The nutrition basis was not clear. Confirm whether these values are per serving, per 100 g or per 100 ml.")
    return result, warnings


def _ocr_lines(image_bytes: bytes) -> list[TextLine]:
    """Models are bundled with RapidOCR; extraction does not call a cloud API."""
    global _OCR_ENGINE
    from PIL import Image, ImageOps
    import numpy as np
    with Image.open(io.BytesIO(image_bytes)) as original:
        image = ImageOps.exif_transpose(original).convert("RGB")
        image.thumbnail((MAX_IMAGE_EDGE, MAX_IMAGE_EDGE))
        array = np.asarray(image)[:, :, ::-1].copy()  # RapidOCR's ndarray input is BGR.
    with _OCR_LOCK:
        if _OCR_ENGINE is None:
            from rapidocr_onnxruntime import RapidOCR
            _OCR_ENGINE = RapidOCR(intra_op_num_threads=1, inter_op_num_threads=1,
                                   det_limit_side_len=1280, det_limit_type="max")
        result, _ = _OCR_ENGINE(array)
    lines = []
    for entry in result or []:
        box, value, score = entry[:3]
        if not value or float(score) < 0.45:
            continue
        xs, ys = zip(*box)
        lines.append(TextLine(str(value), min(xs), min(ys), max(xs), max(ys)))
    return sorted(lines, key=lambda line: (round(line.y0 / 8), line.x0))


def _pdf_lines(page: Any) -> list[TextLine]:
    lines = []
    for block in page.get_text("dict").get("blocks", []):
        for line in block.get("lines", []):
            value = " ".join(span.get("text", "") for span in line.get("spans", [])).strip()
            if value:
                lines.append(TextLine(value, *line["bbox"]))
    return sorted(lines, key=lambda line: (round(line.y0 / 4), line.x0))


def _nutrition_text(lines: list[TextLine]) -> str:
    """Join labels and values detected as separate boxes on the same visual row."""
    if not any(line.y1 for line in lines):
        return "\n".join(line.text for line in lines)
    groups: list[list[TextLine]] = []
    for line in sorted(lines, key=lambda row: ((row.y0 + row.y1) / 2, row.x0)):
        if groups:
            previous = groups[-1][0]
            tolerance = max(3, min(line.y1 - line.y0, previous.y1 - previous.y0) * 0.55)
            if abs((line.y0 + line.y1 - previous.y0 - previous.y1) / 2) <= tolerance:
                groups[-1].append(line)
                continue
        groups.append([line])
    return "\n".join("  ".join(row.text for row in sorted(group, key=lambda row: row.x0)) for group in groups)


def extract_source(path: Path, mime_type: str, items: list[dict]) -> dict:
    """Return page text and draft suggestions; corrupt input returns a warning."""
    path = Path(path)
    output = {"pages": [], "candidates": [], "nutrition_suggestions": {"basis": "", "serving_size": "", "values": []}, "warnings": []}
    page_lines: list[tuple[int, list[TextLine]]] = []
    used_ocr = False
    is_pdf = mime_type.partition(";")[0].strip().lower() == "application/pdf"
    try:
        if is_pdf:
            import pymupdf
            with pymupdf.open(path) as document:
                if document.needs_pass:
                    output["warnings"].append("This PDF is password protected. Upload an unlocked copy.")
                    return output
                if document.page_count > MAX_PDF_PAGES:
                    output["warnings"].append(f"Only the first {MAX_PDF_PAGES} of {document.page_count} PDF pages were processed.")
                for index in range(min(document.page_count, MAX_PDF_PAGES)):
                    page = document[index]
                    lines = _pdf_lines(page)
                    # A short but meaningful native text page need not load OCR.
                    native_text = "\n".join(line.text for line in lines)
                    has_native_text = len(re.sub(r"\W", "", native_text)) >= 12
                    if not has_native_text:
                        try:
                            scale = min(2.2, MAX_IMAGE_EDGE / max(page.rect.width, page.rect.height))
                            rendered = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
                            ocr_lines = _ocr_lines(rendered.tobytes("png"))
                            used_ocr = True
                            if ocr_lines:
                                lines = ocr_lines
                        except Exception:
                            output["warnings"].append(f"Text recognition could not read page {index + 1}. Use its preview to enter values manually.")
                    page_lines.append((index + 1, lines))
        elif mime_type.lower().startswith("image/"):
            used_ocr = True
            try:
                lines = _ocr_lines(path.read_bytes())
            except Exception:
                lines = []
                output["warnings"].append("Text recognition could not read this photo. You can still record values from the original image.")
            page_lines.append((1, lines))
        else:
            output["warnings"].append("Upload a PDF or a supported image to extract suggestions.")
            return output
    except Exception:
        output["warnings"].append("This file could not be opened. Check that it is a valid, readable PDF or image.")
        return output
    for page_number, lines in page_lines:
        text = "\n".join(line.text for line in lines)
        output["pages"].append({"page": page_number, "text": text, "preview_available": True})
        output["candidates"].extend(parse_price_candidates(text, items, page_number, lines))
        if not text.strip():
            output["warnings"].append(f"No readable text was found on page {page_number}. Review the original and add values manually.")
    combined_text = "\n\n".join(page["text"] for page in output["pages"])
    nutrition_text = "\n\n".join(_nutrition_text(lines) for _, lines in page_lines)
    nutrition, nutrition_warnings = parse_nutrition(nutrition_text)
    output["nutrition_suggestions"] = nutrition
    output["warnings"].extend(nutrition_warnings)
    if used_ocr:
        output["warnings"].append("Local text recognition can miss small print, Arabic text and styled prices. Check every suggestion against the original.")
    if output["candidates"]:
        output["warnings"].append("Confirm each product, package size, price and offer date before saving. Printed previous prices may also be detected.")
    if _CONDITIONAL.search(combined_text):
        output["warnings"].append("The source may contain previous prices or conditional offers. Record multi-buy and membership conditions explicitly.")
    output["warnings"] = list(dict.fromkeys(output["warnings"]))
    return output
