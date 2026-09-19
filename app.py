"""Viva Pantry: a private, single-household food and price journal."""
from __future__ import annotations

import hashlib
import io
import json
import math
import os
import secrets
import sqlite3
import threading
import time
import zipfile
from contextlib import closing
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from urllib.parse import urlparse

from flask import Flask, abort, g, jsonify, redirect, request, send_file, session
from werkzeug.exceptions import HTTPException
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.utils import secure_filename

ROOT = Path(__file__).resolve().parent
SCHEMA = """
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS items (
 id INTEGER PRIMARY KEY, name TEXT NOT NULL, brand TEXT NOT NULL DEFAULT '',
 category TEXT NOT NULL DEFAULT 'Other', package_size REAL, package_unit TEXT NOT NULL DEFAULT 'each',
 pack_count INTEGER NOT NULL DEFAULT 1, notes TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sources (
 id INTEGER PRIMARY KEY, filename TEXT NOT NULL, storage_name TEXT NOT NULL UNIQUE,
 mime_type TEXT NOT NULL, checksum TEXT NOT NULL UNIQUE, purpose TEXT NOT NULL,
 page_count INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, extraction TEXT
);
CREATE TABLE IF NOT EXISTS item_sources (
 item_id INTEGER NOT NULL REFERENCES items(id), source_id INTEGER NOT NULL REFERENCES sources(id),
 PRIMARY KEY(item_id, source_id)
);
CREATE TABLE IF NOT EXISTS nutrition_labels (
 id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id),
 content TEXT NOT NULL, recorded_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS prices (
 id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id),
 amount_fils INTEGER NOT NULL CHECK(amount_fils>0), currency TEXT NOT NULL DEFAULT 'AED',
 observed_on TEXT NOT NULL, valid_to TEXT, kind TEXT NOT NULL,
 source_id INTEGER REFERENCES sources(id), page INTEGER, notes TEXT NOT NULL DEFAULT '',
 import_key TEXT UNIQUE, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS prices_item_date ON prices(item_id, observed_on);
"""


def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def text(value, maximum=500, required=False):
    if value is None:
        value = ''
    if not isinstance(value, str):
        raise ValueError('Expected text.')
    value = value.strip()
    if len(value) > maximum or (required and not value):
        raise ValueError(f'Enter text between {1 if required else 0} and {maximum} characters.')
    return value


def positive(value, field, integer=False, maximum=100000):
    if isinstance(value, bool):
        raise ValueError(f'{field} must be a positive number.')
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError(f'{field} must be a positive number.') from None
    if not math.isfinite(number) or number <= 0 or number > maximum or (integer and number != int(number)):
        raise ValueError(f'{field} must be a positive {"whole number" if integer else "number"} up to {maximum}.')
    return int(number) if integer else number


def iso_date(value, field):
    try:
        result = date.fromisoformat(value)
        if result.isoformat() != value:
            raise ValueError()
        return value
    except (ValueError, TypeError):
        raise ValueError(f'{field} must be a date in YYYY-MM-DD format.') from None


def create_app(data_dir=None, testing=False):
    app = Flask(__name__, static_folder=str(ROOT / 'static'), static_url_path='/static')
    folder = Path(data_dir or os.environ.get('VIVA_DATA_DIR', ROOT / 'data')).resolve()
    folder.mkdir(parents=True, exist_ok=True)
    (folder / 'uploads').mkdir(exist_ok=True)
    secret_file = folder / '.session-secret'
    if not secret_file.exists():
        secret_file.write_text(secrets.token_hex(32), encoding='ascii')
    app.config.update(TESTING=testing, DATA_DIR=folder, MAX_CONTENT_LENGTH=40 * 1024 * 1024,
                      SECRET_KEY=os.environ.get('VIVA_SECRET_KEY') or secret_file.read_text().strip(),
                      SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE='Lax',
                      SESSION_COOKIE_SECURE=os.environ.get('VIVA_HTTPS', '') == '1',
                      PERMANENT_SESSION_LIFETIME=timedelta(days=30))
    password = os.environ.get('VIVA_PASSWORD', '')
    password_hash = generate_password_hash(password) if password else None
    if not password_hash:
        app.config['TRUSTED_HOSTS'] = ['localhost', '127.0.0.1', '[::1]']
    with closing(sqlite3.connect(folder / 'viva.sqlite3')) as connection:
        connection.executescript(SCHEMA)
        connection.execute('PRAGMA journal_mode=WAL')
    login_attempts = {}
    extraction_lock = threading.Lock()

    def db():
        if 'db' not in g:
            g.db = sqlite3.connect(folder / 'viva.sqlite3', timeout=30)
            g.db.row_factory = sqlite3.Row
            g.db.execute('PRAGMA foreign_keys=ON')
        return g.db

    @app.teardown_appcontext
    def close_db(_error):
        if 'db' in g:
            g.pop('db').close()

    def get_row(table, row_id):
        row = db().execute(f'SELECT * FROM {table} WHERE id=?', (row_id,)).fetchone()
        if not row:
            abort(404)
        return row

    def source_dict(row):
        return {key: row[key] for key in ('id', 'filename', 'mime_type', 'purpose', 'page_count', 'created_at')} | {
            'url': f'/api/sources/{row["id"]}/file'}

    def price_dict(row):
        result = dict(row)
        result['price'] = result.pop('amount_fils') / 100
        observed = date.fromisoformat(result['observed_on'])
        result['week_start'] = (observed - timedelta(days=observed.weekday())).isoformat()
        result.pop('import_key', None)
        return result

    def item_dict(row):
        result = dict(row)
        item_id = row['id']
        labels = db().execute('SELECT * FROM nutrition_labels WHERE item_id=? ORDER BY id DESC', (item_id,)).fetchall()
        result['nutrition'] = json.loads(labels[0]['content']) if labels else {'basis': 'per 100 g', 'serving_size': '', 'values': []}
        result['nutrition_history'] = [{'id': r['id'], 'recorded_at': r['recorded_at'], **json.loads(r['content'])} for r in labels]
        result['sources'] = [source_dict(r) for r in db().execute(
            'SELECT s.* FROM sources s JOIN item_sources x ON s.id=x.source_id WHERE x.item_id=? ORDER BY s.id', (item_id,))]
        result['prices'] = [price_dict(r) for r in db().execute(
            'SELECT * FROM prices WHERE item_id=? ORDER BY observed_on, id', (item_id,))]
        return result

    def payload():
        data = request.get_json()
        if not isinstance(data, dict):
            raise ValueError('Expected a JSON object.')
        return data

    @app.before_request
    def protect():
        if not password_hash and request.remote_addr not in ('127.0.0.1', '::1', None):
            abort(403, description='A password is required for network access.')
        if request.method in ('POST', 'PUT', 'DELETE', 'PATCH'):
            origin = request.headers.get('Origin')
            if origin and urlparse(origin).netloc != request.host:
                abort(403, description='Open the tracker directly before making changes.')
        if password_hash and not session.get('authenticated'):
            if request.path not in ('/login', '/health') and not request.path.startswith('/static/'):
                if request.path.startswith('/api/'):
                    return jsonify(error='Sign in to continue.'), 401
                return redirect('/login')

    @app.after_request
    def headers(response):
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['X-Frame-Options'] = 'DENY'
        response.headers['Referrer-Policy'] = 'same-origin'
        response.headers['Cache-Control'] = 'no-store' if request.path.startswith('/api/') else 'no-cache'
        return response

    @app.errorhandler(ValueError)
    def validation_error(error):
        if 'db' in g:
            db().rollback()
        return jsonify(error=str(error)), 400

    @app.errorhandler(HTTPException)
    def http_error(error):
        return jsonify(error=error.description), error.code

    @app.errorhandler(Exception)
    def unexpected_error(error):
        app.logger.exception('Request failed')
        if 'db' in g:
            db().rollback()
        return jsonify(error='The request failed. Your saved records are safe; please try again.'), 500

    @app.route('/login', methods=['GET', 'POST'])
    def login():
        if not password_hash:
            return redirect('/')
        error = ''
        if request.method == 'POST':
            ip = request.remote_addr
            recent = [stamp for stamp in login_attempts.get(ip, []) if stamp > time.time() - 300]
            login_attempts[ip] = recent
            if len(recent) >= 10:
                error = 'Please wait five minutes before trying again.'
            elif check_password_hash(password_hash, request.form.get('password', '')):
                session.clear()
                session['authenticated'] = True
                session.permanent = True
                return redirect('/')
            else:
                recent.append(time.time())
                error = 'That password did not match.'
        return f'''<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Sign in · Viva Pantry</title><style>body{{background:#f7f6ef;color:#214333;font:17px system-ui;margin:0;min-height:100vh;display:grid;place-items:center}}form{{max-width:360px;padding:32px}}input,button{{box-sizing:border-box;width:100%;padding:15px;border:1px solid #c6d0c3;border-radius:10px;margin:12px 0;font:inherit}}button{{background:#214333;color:white}}p{{line-height:1.6}}</style><form method="post"><p>VIVA PANTRY</p><h1>Your food. Your records.</h1><p>Sign in to your private pantry.</p><label for="password">Password</label><input id="password" name="password" type="password" required autocomplete="current-password"><button>Open my pantry</button><p role="alert">{error}</p></form></html>'''

    @app.post('/logout')
    def logout():
        session.clear()
        return redirect('/login')

    @app.get('/health')
    def health():
        return jsonify(status='ok')

    @app.get('/')
    def index():
        return send_file(ROOT / 'static' / 'index.html')

    @app.get('/cloud-config.js')
    def local_config():
        return app.response_class('window.VIVA_CLOUD_CONFIG = {url:"",anonKey:""};', mimetype='text/javascript')

    @app.get('/<path:asset>')
    def browser_asset(asset):
        from flask import send_from_directory
        if asset.startswith(('api/', 'data/', '.')):
            abort(404)
        return send_from_directory(ROOT / 'static', asset)

    @app.get('/api/info')
    def info():
        return jsonify(currency='AED', version='1.0', phone_urls=[], auth_required=bool(password_hash))

    @app.get('/api/items')
    def items():
        return jsonify(items=[item_dict(r) for r in db().execute('SELECT * FROM items ORDER BY name COLLATE NOCASE')])

    @app.get('/api/items/<int:item_id>')
    def item(item_id):
        return jsonify(item_dict(get_row('items', item_id)))

    @app.route('/api/items', methods=['POST'])
    @app.route('/api/items/<int:item_id>', methods=['PUT'])
    def save_item(item_id=None):
        data = payload()
        old = dict(get_row('items', item_id)) if item_id else {}
        data = {**old, **data}
        fields = {
            'name': text(data.get('name'), 150, True), 'brand': text(data.get('brand'), 100),
            'category': text(data.get('category') or 'Other', 80),
            'package_size': positive(data['package_size'], 'Pack size') if data.get('package_size') not in (None, '') else None,
            'package_unit': text(data.get('package_unit') or 'each', 10),
            'pack_count': positive(data.get('pack_count', 1), 'Pack count', True, 1000),
            'notes': text(data.get('notes'), 5000), 'updated_at': now(),
        }
        if fields['package_unit'] not in ('g', 'kg', 'ml', 'L', 'each'):
            raise ValueError('Choose g, kg, ml, L or each for the pack unit.')
        if item_id and any(fields[key] != old[key] for key in ('package_size', 'package_unit', 'pack_count')):
            if db().execute('SELECT 1 FROM prices WHERE item_id=? LIMIT 1', (item_id,)).fetchone():
                raise ValueError('This pack already has price history. Add a separate item for a different pack size so prices stay comparable.')
        nutrition = data.get('nutrition')
        if nutrition is not None:
            if not isinstance(nutrition, dict) or not isinstance(nutrition.get('values', []), list):
                raise ValueError('Nutrition must include a list of values.')
            values = nutrition.get('values', [])
            if len(values) > 50:
                raise ValueError('A label can have at most 50 nutrient rows.')
            if any(not isinstance(value, dict) for value in values):
                raise ValueError('Each nutrient needs a label, value and unit.')
            nutrition = {'basis': text(nutrition.get('basis'), 100), 'serving_size': text(nutrition.get('serving_size'), 100),
                         'values': [{'label': text(v.get('label'), 80, True),
                                     'value': text(str(v['value']), 60) if v.get('value') not in (None, '') else None,
                                     'unit': text(v.get('unit'), 30)} for v in values if isinstance(v, dict)]}
        source_ids = data.get('source_ids', [])
        if not isinstance(source_ids, list) or len(source_ids) > 50:
            raise ValueError('Choose up to 50 source files.')
        for source_id in source_ids:
            get_row('sources', positive(source_id, 'Source', True))
        if item_id:
            db().execute('UPDATE items SET ' + ','.join(f'{k}=?' for k in fields) + ' WHERE id=?', (*fields.values(), item_id))
        else:
            fields['created_at'] = now()
            cursor = db().execute(f'INSERT INTO items ({",".join(fields)}) VALUES ({",".join("?" for _ in fields)})', tuple(fields.values()))
            item_id = cursor.lastrowid
        if nutrition is not None:
            content = json.dumps(nutrition, ensure_ascii=False, sort_keys=True)
            latest = db().execute('SELECT content FROM nutrition_labels WHERE item_id=? ORDER BY id DESC LIMIT 1', (item_id,)).fetchone()
            if not latest or latest['content'] != content:
                db().execute('INSERT INTO nutrition_labels (item_id,content,recorded_at) VALUES (?,?,?)', (item_id, content, now()))
        if 'source_ids' in data:
            db().execute('DELETE FROM item_sources WHERE item_id=?', (item_id,))
        for source_id in source_ids:
            db().execute('INSERT OR IGNORE INTO item_sources VALUES (?,?)', (item_id, source_id))
        db().commit()
        return jsonify(item_dict(get_row('items', item_id)))

    def validate_price(data, item_id):
        get_row('items', item_id)
        try:
            amount = Decimal(str(data.get('price')))
            if not amount.is_finite() or amount <= 0 or amount > 100000 or amount != amount.quantize(Decimal('.01')):
                raise InvalidOperation()
        except InvalidOperation:
            raise ValueError('Enter a positive AED price with no more than two decimal places.') from None
        observed = iso_date(data.get('observed_on'), 'Price date')
        end = iso_date(data['valid_to'], 'Offer end') if data.get('valid_to') else None
        if end and end < observed:
            raise ValueError('The offer end cannot be before its start.')
        kind = data.get('kind', 'regular')
        if kind not in ('regular', 'offer', 'paid'):
            raise ValueError('Choose a regular, offer, or paid price.')
        source_id = positive(data['source_id'], 'Source', True) if data.get('source_id') not in (None, '') else None
        page = positive(data['page'], 'Page', True, 10000) if data.get('page') not in (None, '') else None
        if source_id:
            source = get_row('sources', source_id)
            if page and page > source['page_count']:
                raise ValueError('The page number is outside this file.')
        elif page:
            raise ValueError('A page number needs a source file.')
        return {'item_id': item_id, 'amount_fils': int(amount * 100), 'observed_on': observed, 'valid_to': end,
                'kind': kind, 'source_id': source_id, 'page': page, 'notes': text(data.get('notes'), 2000), 'created_at': now()}

    def insert_price(fields):
        return db().execute(f'INSERT INTO prices ({",".join(fields)}) VALUES ({",".join("?" for _ in fields)})', tuple(fields.values())).lastrowid

    @app.post('/api/items/<int:item_id>/prices')
    def add_price(item_id):
        fields = validate_price(payload(), item_id)
        price_id = insert_price(fields)
        db().commit()
        return jsonify(price_dict(get_row('prices', price_id)))

    @app.delete('/api/prices/<int:price_id>')
    def delete_price(price_id):
        get_row('prices', price_id)
        db().execute('DELETE FROM prices WHERE id=?', (price_id,))
        db().commit()
        return jsonify(deleted=True)

    @app.get('/api/sources')
    def sources():
        return jsonify(sources=[source_dict(r) for r in db().execute('SELECT * FROM sources ORDER BY id DESC')])

    @app.post('/api/uploads')
    def upload():
        upload_file = request.files.get('file')
        if not upload_file or not upload_file.filename:
            raise ValueError('Choose a photo or PDF.')
        raw = upload_file.read()
        if not raw:
            raise ValueError('The file is empty.')
        checksum = hashlib.sha256(raw).hexdigest()
        existing = db().execute('SELECT * FROM sources WHERE checksum=?', (checksum,)).fetchone()
        if existing:
            return jsonify(source_dict(existing) | {'duplicate': True})
        import pymupdf
        page_count = 1
        if raw.startswith(b'%PDF-'):
            try:
                with pymupdf.open(stream=raw, filetype='pdf') as doc:
                    if doc.needs_pass or doc.page_count == 0:
                        raise ValueError('Use an unlocked PDF with at least one page.')
                    page_count = doc.page_count
            except pymupdf.FileDataError:
                raise ValueError('That PDF could not be read.') from None
            extension, mime = '.pdf', 'application/pdf'
        else:
            from PIL import Image, UnidentifiedImageError
            try:
                with Image.open(io.BytesIO(raw)) as img:
                    if img.width * img.height > 40_000_000:
                        raise ValueError('Please resize this photo below 40 megapixels.')
                    fmt = img.format
                    img.verify()
                formats = {'JPEG': ('.jpg', 'image/jpeg'), 'PNG': ('.png', 'image/png'), 'WEBP': ('.webp', 'image/webp')}
                if fmt not in formats:
                    raise ValueError('Please use a JPG, PNG, WebP photo or PDF. Export HEIC photos as JPG first.')
                extension, mime = formats[fmt]
            except (UnidentifiedImageError, OSError):
                raise ValueError('Please use a valid JPG, PNG, WebP photo or PDF.') from None
        storage_name = checksum + extension
        path = folder / 'uploads' / storage_name
        path.write_bytes(raw)
        purpose = request.form.get('purpose', 'photo')
        if purpose not in ('photo', 'flyer'):
            purpose = 'photo'
        filename = secure_filename(upload_file.filename) or f'upload{extension}'
        db().execute('INSERT OR IGNORE INTO sources (filename,storage_name,mime_type,checksum,purpose,page_count,created_at) VALUES (?,?,?,?,?,?,?)',
                     (filename[:180], storage_name, mime, checksum, purpose, page_count, now()))
        db().commit()
        return jsonify(source_dict(db().execute('SELECT * FROM sources WHERE checksum=?', (checksum,)).fetchone()))

    @app.get('/api/sources/<int:source_id>/file')
    def source_file(source_id):
        row = get_row('sources', source_id)
        return send_file(folder / 'uploads' / row['storage_name'], mimetype=row['mime_type'], download_name=row['filename'])

    @app.get('/api/sources/<int:source_id>/preview')
    def preview(source_id):
        row = get_row('sources', source_id)
        page = positive(request.args.get('page', 1), 'Page', True, 10000)
        if page > row['page_count']:
            abort(404)
        path = folder / 'uploads' / row['storage_name']
        if row['mime_type'] != 'application/pdf':
            return send_file(path, mimetype=row['mime_type'])
        import pymupdf
        with pymupdf.open(path) as doc:
            pdf_page = doc[page - 1]
            scale = min(1.6, 1600 / max(pdf_page.rect.width, pdf_page.rect.height))
            pixmap = pdf_page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
            return send_file(io.BytesIO(pixmap.tobytes('png')), mimetype='image/png')

    @app.post('/api/sources/<int:source_id>/extract')
    def extract(source_id):
        row = get_row('sources', source_id)
        from importer import extract_source
        current_items = [dict(r) for r in db().execute('SELECT * FROM items')]
        with extraction_lock:
            extracted = extract_source(folder / 'uploads' / row['storage_name'], row['mime_type'], current_items)
        db().execute('UPDATE sources SET extraction=? WHERE id=?', (json.dumps(extracted, ensure_ascii=False), source_id))
        db().commit()
        return jsonify(extracted)

    @app.post('/api/imports/commit')
    def commit_import():
        data = payload()
        source_id = positive(data.get('source_id'), 'Source', True)
        get_row('sources', source_id)
        rows = data.get('rows')
        if not isinstance(rows, list) or not rows or len(rows) > 500:
            raise ValueError('Select between 1 and 500 reviewed prices.')
        validated = []
        for row in rows:
            if not isinstance(row, dict):
                raise ValueError('Each price must be a record.')
            fields = validate_price({**row, 'source_id': source_id, 'kind': 'offer',
                                     'observed_on': data.get('observed_on'), 'valid_to': data.get('valid_to')},
                                    positive(row.get('item_id'), 'Item', True))
            # Reopening a flyer cannot silently add a second version of the same offer.
            fields['import_key'] = f'{source_id}:{fields["item_id"]}:{fields["observed_on"]}:{fields["page"]}'
            validated.append(fields)
        saved = skipped = 0
        for fields in validated:
            if db().execute('SELECT id FROM prices WHERE import_key=?', (fields['import_key'],)).fetchone():
                skipped += 1
            else:
                insert_price(fields)
                saved += 1
        db().commit()
        return jsonify(saved=saved, skipped=skipped)

    @app.get('/api/backup')
    def backup():
        # A SQLite snapshot keeps the database consistent while the app is open.
        buffer = io.BytesIO()
        temp_path = folder / f'backup-{secrets.token_hex(8)}.sqlite3'
        try:
            with closing(sqlite3.connect(temp_path)) as target:
                db().backup(target)
            with closing(sqlite3.connect(temp_path)) as snapshot:
                snapshot.row_factory = sqlite3.Row
                source_rows = snapshot.execute('SELECT * FROM sources').fetchall()
                export = {table: [dict(r) for r in snapshot.execute(f'SELECT * FROM {table}')]
                          for table in ('items', 'nutrition_labels', 'prices', 'sources', 'item_sources')}
            with zipfile.ZipFile(buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
                archive.write(temp_path, 'viva.sqlite3')
                archive.writestr('records.json', json.dumps(export, ensure_ascii=False, indent=2))
                archive.writestr('RESTORE.txt', 'Stop Viva Pantry. Replace viva.sqlite3 and uploads/ in VIVA_DATA_DIR with these files. Restart. Do not copy an old SQLite -wal or -shm file. Keep a copy of the old data folder first.\n')
                for row in source_rows:
                    archive.write(folder / 'uploads' / row['storage_name'], 'uploads/' + row['storage_name'])
        finally:
            temp_path.unlink(missing_ok=True)
        buffer.seek(0)
        return send_file(buffer, mimetype='application/zip', as_attachment=True, download_name=f'viva-pantry-{date.today().isoformat()}.zip')

    return app


if __name__ == '__main__':
    from waitress import serve
    host = os.environ.get('HOST', '127.0.0.1')
    if host not in ('127.0.0.1', 'localhost', '::1') and len(os.environ.get('VIVA_PASSWORD', '')) < 12:
        raise SystemExit('Set VIVA_PASSWORD to at least 12 characters before enabling network access.')
    port = int(os.environ.get('PORT', '8765'))
    print(f'Viva Pantry is ready at http://{host}:{port}', flush=True)
    serve(create_app(), host=host, port=port, threads=8, channel_timeout=300)
