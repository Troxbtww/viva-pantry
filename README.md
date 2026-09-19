# Viva Pantry

A mobile food library with original photos, reviewed nutrition labels, weekly flyer imports, and AED price history.

[Open Viva Pantry](https://troxbtww.github.io/viva-pantry/)

## Free cloud website

The interface is hosted on GitHub Pages. Supabase Free stores private account records and original files. Image and PDF recognition runs in the browser using bundled PDF.js and Tesseract. There is no paid AI service or paid application server.

Use the same email on your phone and computer to receive a sign-in link and open the same library. With Supabase's default email service, use the email associated with your Supabase organization; other recipients may require configuring an email provider. Row-level security isolates each account's records. The public website source includes only the public project URL and publishable key, never a service-role key.

As checked on 19 September 2026, the Supabase Free plan includes 500 MB database space and 1 GB file storage. Inactive projects may pause after a week. Keep the organization on Free; this setup requires no payment method. [Pricing](https://supabase.com/pricing), [project pausing](https://supabase.com/docs/guides/platform/free-project-pausing).

## Using the tracker

1. Add an item with the exact brand, variant, pack size, and multipack count. Upload its front/package photo, nutrition label and price-tag photo when available. You can also copy an image and press Ctrl+V (Command+V on Mac) anywhere in the food editor, or use Paste image. Review the attached images and save the food.
2. Review nutrition suggestions against the original. Check the basis (per 100 g, 100 ml, or serving) and units. Blank means unknown, zero stays zero, and values such as `<0.5` are supported.
3. Record the first dated price as regular, offer, or paid.
4. Open Weekly offers, upload Viva's PDF, enter its actual offer dates, and review each matched product, price and source page. Only checked rows are saved; manual entry is also available.
5. Open an item for its nutrition facts, originals, weekly chart and price history. Use Back up my library periodically; on mobile, open Phone & backup.

Nutrition and prices are independent. Label revisions are retained in the database. Flyer imports never erase nutrition. Different pack sizes should be separate items; an item with prices cannot be relabelled as a different pack.

Use **Import foods from CSV** in the library to bring in a food database export with Food, Package qty, Package unit, Nutrition basis qty and nutrient columns. Choose the file or paste its contents, review the rows, then import. Imported nutrition remains marked for review; source confidence, estimates and notes are retained. Prices without observation dates are saved as undated references in item notes. Missing package quantities stay blank. Re-importing the same name and pack skips the existing item, preserving its photos and edits.

The chart shows the lowest recorded price of each type in Monday-start weeks. Missing weeks are gaps, never zero or carried-forward prices. Last-recorded prices show their dates; they are not a claim of today's availability. Offer conditions are preserved in notes.

## Import limits

Files can be JPG, PNG, WebP or PDF, up to 40 MB each. Export HEIC photos as JPG. Browser extraction processes the first 40 PDF pages; split larger PDFs or enter remaining prices manually. OCR may miss small print, glare, Arabic-only labels, decorative prices, and multiple nutrition columns. Suggestions require review, and originals remain available if extraction fails.

Files are deduplicated per account by their contents. Re-saving a flyer for the same product, date and page skips the duplicate. To correct a price, remove the mistaken observation and add the corrected one. Unlinking a photo from an item retains the original for price references and backups.

## Backups

Cloud backups are versioned JSON containing all records and original file bytes (base64), with verified file checksums and no credentials. There is currently no one-click cloud restore: restoring requires uploading originals and remapping record IDs through the checked database functions. Keep the file as a portable archive and ask for help restoring it if needed.

The optional Python version produces SQLite ZIP backups. Cloud and local databases are independent. To restore a local ZIP, stop the app, preserve the old data folder, extract into a new empty folder, point VIVA_DATA_DIR at it and restart. Do not merge old SQLite WAL/SHM files into the restored folder.

## Cloud development

```sh
npm ci
npm run build
npm test
```

Serve `static/` with an HTTP server for the cloud preview. The build bundles the SDK and copies PDF/OCR assets and the English language model; no runtime CDN is needed. Vendor output is ignored by Git and built during deployment.

Run `cloud/schema.sql` in the intended Supabase project's SQL editor. It creates owner-scoped records, a private storage bucket, transactional write functions and explicit privileges. It is safe to rerun for this app. Configure only the public project URL and publishable/anon key in `static/cloud-config.js`.

Set the complete GitHub Pages URL, including its repository path and trailing slash, as Supabase's Authentication Site URL and allowed Redirect URL. The GitHub Actions workflow publishes `static/` from the `codex/viva-pantry` branch. Personal files, backups, credentials and local databases are excluded from Git.

## Optional local version

The Python/SQLite app uses `data/` and works independently of Supabase:

```powershell
.\.venv\Scripts\python.exe app.py
```

Open <http://127.0.0.1:8765> or run `start.ps1`. By default it is only accessible on this computer. To prepare a new Python 3.12 environment:

```powershell
py -3.12 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

The optional Dockerfile requires a persistent `/data` volume and VIVA_PASSWORD of at least 12 characters for network access. It is not used for free cloud hosting.

## Checks

`npm test` covers browser parsing and actual PostgreSQL logic using PGlite: ownership isolation, denied direct writes, exact fils, nutrition history, atomic/idempotent imports, API contract and complete backups. Real browser smoke checks cover native PDFs, photos and scanned PDFs with bundled libraries.

For local API checks:

```powershell
.\.venv\Scripts\python.exe -m pip install pytest
.\.venv\Scripts\python.exe -m pytest -q --basetemp=.test-tmp
```

All fixtures are synthetic and isolated from your library. Your own photos and Viva flyers still need a first review.
