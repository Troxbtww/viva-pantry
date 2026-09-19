"""Exercise persistence, reviewed imports, backups, and the private HTTP boundary."""
import io
import json
import sqlite3
import zipfile
from contextlib import closing

import pymupdf
import pytest
from PIL import Image

from app import create_app


@pytest.fixture
def app(tmp_path, monkeypatch):
    for variable in ('VIVA_PASSWORD', 'VIVA_SECRET_KEY', 'VIVA_HTTPS'):
        monkeypatch.delenv(variable, raising=False)
    return create_app(data_dir=tmp_path / 'pantry', testing=True)


@pytest.fixture
def client(app):
    return app.test_client()


def image_bytes(format='PNG'):
    stream = io.BytesIO()
    Image.new('RGB', (12, 12), '#337755').save(stream, format=format)
    return stream.getvalue()


def pdf_bytes(pages=2, encrypted=False):
    with pymupdf.open() as document:
        for index in range(pages):
            page = document.new_page()
            page.insert_text((50, 50), f'Viva weekly offer page {index + 1}')
        if encrypted:
            return document.tobytes(encryption=pymupdf.PDF_ENCRYPT_AES_256,
                                    owner_pw='owner-password', user_pw='reader-password')
        return document.tobytes()


def upload(client, raw=None, filename='label.png', purpose='photo'):
    response = client.post('/api/uploads', data={
        'file': (io.BytesIO(raw if raw is not None else image_bytes()), filename),
        'purpose': purpose,
    })
    assert response.status_code == 200, response.get_json()
    return response.get_json()


def item(client, **fields):
    response = client.post('/api/items', json={
        'name': 'Rolled oats', 'brand': 'Pantry', 'package_size': 500,
        'package_unit': 'g', **fields,
    })
    assert response.status_code == 200, response.get_json()
    return response.get_json()


def price(client, item_id, **fields):
    response = client.post(f'/api/items/{item_id}/prices', json={
        'price': '12.35', 'observed_on': '2026-09-19', **fields,
    })
    assert response.status_code == 200, response.get_json()
    return response.get_json()


def label(energy='389'):
    return {'basis': 'per 100 g', 'serving_size': '40 g', 'values': [
        {'label': 'Energy', 'value': energy, 'unit': 'kcal'},
        {'label': 'Protein', 'value': '13.2', 'unit': 'g'},
        {'label': 'Salt', 'value': None, 'unit': 'g'},
    ]}


def test_item_edits_keep_nutrition_versions_photos_and_price_history(client, app):
    source = upload(client)
    initial = item(client, nutrition=label(), source_ids=[source['id']])
    regular = price(client, initial['id'], price='0.29', observed_on='2026-09-07')
    offer = price(client, initial['id'], price='0.19', observed_on='2026-09-13',
                  valid_to='2026-09-15', kind='offer', source_id=source['id'], page=1)
    updated = client.put(f"/api/items/{initial['id']}", json={
        'name': 'Wholegrain rolled oats', 'nutrition': label('390'),
    }).get_json()
    assert updated['brand'] == initial['brand']
    assert updated['sources'] == initial['sources']
    assert updated['nutrition'] == label('390')
    assert len(updated['nutrition_history']) == 2
    assert updated['nutrition_history'][1]['values'] == label()['values']
    assert [entry['id'] for entry in updated['prices']] == [regular['id'], offer['id']]
    assert [entry['week_start'] for entry in updated['prices']] == ['2026-09-07'] * 2
    assert [entry['price'] for entry in updated['prices']] == [0.29, 0.19]
    for changes in ({'nutrition': label('390')}, {'notes': 'Keep the label on file'}):
        response = client.put(f"/api/items/{initial['id']}", json=changes)
        assert response.status_code == 200
        assert len(response.get_json()['nutrition_history']) == 2
        assert response.get_json()['nutrition'] == label('390')
    with closing(sqlite3.connect(app.config['DATA_DIR'] / 'viva.sqlite3')) as database:
        assert database.execute('SELECT amount_fils FROM prices ORDER BY id').fetchall() == [(29,), (19,)]
    reopened = create_app(data_dir=app.config['DATA_DIR'], testing=True).test_client()
    assert reopened.get(f"/api/items/{initial['id']}").get_json() == response.get_json()


@pytest.mark.parametrize('bad_price', ['NaN', 'Infinity', '-Infinity', '-0.01', '0',
                                        '2.001', '100000.01', '', None, True, 'abc'])
def test_invalid_prices_never_create_records(client, bad_price):
    product = item(client)
    response = client.post(f"/api/items/{product['id']}/prices", json={
        'price': bad_price, 'observed_on': '2026-09-19',
    })
    assert response.status_code == 400
    assert client.get(f"/api/items/{product['id']}").get_json()['prices'] == []


@pytest.mark.parametrize('changes', [
    {'observed_on': '2026-02-30'}, {'observed_on': '20260919'},
    {'observed_on': None}, {'observed_on': '2026-09-19T00:00:00'},
    {'valid_to': '2026-09-18'}, {'valid_to': 'tomorrow'},
    {'kind': 'unknown'}, {'page': 1}, {'page': 0}, {'source_id': 0},
])
def test_invalid_price_dates_and_metadata(client, changes):
    product = item(client)
    response = client.post(f"/api/items/{product['id']}/prices", json={
        'price': '4.99', 'observed_on': '2026-09-19', **changes,
    })
    assert response.status_code == 400
    assert client.get(f"/api/items/{product['id']}").get_json()['prices'] == []


@pytest.mark.parametrize('changes', [
    {'name': ''}, {'package_size': 'NaN'}, {'package_size': 'Infinity'},
    {'pack_count': 1.5}, {'pack_count': True}, {'package_unit': 'litres'},
])
def test_invalid_item_updates_leave_existing_record_intact(client, changes):
    product = item(client, nutrition=label())
    response = client.put(f"/api/items/{product['id']}", json=changes)
    assert response.status_code == 400
    assert client.get(f"/api/items/{product['id']}").get_json() == product


@pytest.mark.parametrize('changes', [
    {'package_size': 1000}, {'package_unit': 'kg'}, {'pack_count': 2},
])
def test_pack_variants_cannot_relabel_existing_price_history(client, changes):
    product = item(client, nutrition=label())
    price(client, product['id'])
    before = client.get(f"/api/items/{product['id']}").get_json()
    response = client.put(f"/api/items/{product['id']}", json=changes)
    assert response.status_code == 400
    assert client.get(f"/api/items/{product['id']}").get_json() == before
    # Price-free drafts can still have their packaging corrected.
    draft = item(client, name='Draft product')
    assert client.put(f"/api/items/{draft['id']}", json=changes).status_code == 200


def test_upload_checks_contents_deduplicates_and_preserves_original(client, app):
    raw = image_bytes()
    first = upload(client, raw, '../../label.html')
    assert first['mime_type'] == 'image/png'
    assert first['filename'] == 'label.html'
    repeated = upload(client, raw, 'different-name.png')
    assert repeated['duplicate'] is True
    assert repeated['id'] == first['id']
    assert client.get(first['url']).data == raw
    assert client.get(f"/api/sources/{first['id']}/preview").data == raw
    assert len(client.get('/api/sources').get_json()['sources']) == 1
    assert len(list((app.config['DATA_DIR'] / 'uploads').iterdir())) == 1


def test_removing_item_photos_keeps_originals_price_references_and_backups(client):
    photo_raw, flyer_raw = image_bytes(), pdf_bytes()
    photo = upload(client, photo_raw)
    flyer = upload(client, flyer_raw, 'weekly.pdf', 'flyer')
    product = item(client, nutrition=label(), source_ids=[photo['id'], flyer['id']])
    shared = item(client, name='Another item', source_ids=[photo['id']])
    recorded = price(client, product['id'], source_id=photo['id'], page=1)

    replaced = client.put(f"/api/items/{product['id']}", json={'source_ids': [flyer['id']]})
    assert replaced.status_code == 200
    assert [source['id'] for source in replaced.get_json()['sources']] == [flyer['id']]
    unchanged = client.put(f"/api/items/{product['id']}", json={'notes': 'Keep linked flyer'})
    assert unchanged.get_json()['sources'] == replaced.get_json()['sources']
    cleared = client.put(f"/api/items/{product['id']}", json={'source_ids': []})
    assert cleared.status_code == 200
    assert cleared.get_json()['sources'] == []
    assert cleared.get_json()['prices'] == [recorded]
    assert cleared.get_json()['nutrition'] == label()
    assert client.get(f"/api/items/{shared['id']}").get_json()['sources'] == shared['sources']
    assert client.get(photo['url']).data == photo_raw
    assert client.get(flyer['url']).data == flyer_raw
    assert len(client.get('/api/sources').get_json()['sources']) == 2

    response = client.get('/api/backup')
    assert response.status_code == 200
    with zipfile.ZipFile(io.BytesIO(response.data)) as archive:
        exported = json.loads(archive.read('records.json'))
        assert exported['item_sources'] == [{'item_id': shared['id'], 'source_id': photo['id']}]
        assert exported['prices'][0]['source_id'] == photo['id']
        assert len(exported['sources']) == 2
        for source in exported['sources']:
            expected = photo_raw if source['id'] == photo['id'] else flyer_raw
            assert archive.read('uploads/' + source['storage_name']) == expected


@pytest.mark.parametrize('raw,filename', [
    (b'', 'empty.jpg'), (b'<script>alert(1)</script>', 'photo.png'),
    (b'%PDF-not-a-document', 'flyer.pdf'), (image_bytes('GIF'), 'picture.gif'),
])
def test_invalid_uploads_do_not_leave_files_or_records(client, app, raw, filename):
    response = client.post('/api/uploads', data={'file': (io.BytesIO(raw), filename)})
    assert response.status_code == 400
    assert client.get('/api/sources').get_json() == {'sources': []}
    assert list((app.config['DATA_DIR'] / 'uploads').iterdir()) == []


def test_pdf_pages_are_validated_and_previewed(client):
    source = upload(client, pdf_bytes(), 'weekly.pdf', purpose='flyer')
    assert source['page_count'] == 2
    assert source['purpose'] == 'flyer'
    preview = client.get(f"/api/sources/{source['id']}/preview?page=2")
    assert preview.status_code == 200
    assert preview.mimetype == 'image/png'
    assert client.get(f"/api/sources/{source['id']}/preview?page=3").status_code == 404
    product = item(client)
    response = client.post(f"/api/items/{product['id']}/prices", json={
        'price': '5.50', 'observed_on': '2026-09-19', 'source_id': source['id'], 'page': 3,
    })
    assert response.status_code == 400
    locked = client.post('/api/uploads', data={
        'file': (io.BytesIO(pdf_bytes(encrypted=True)), 'locked.pdf'),
    })
    assert locked.status_code == 400
    assert len(client.get('/api/sources').get_json()['sources']) == 1


def test_reviewed_flyer_import_is_atomic_and_retry_safe(client):
    source = upload(client, pdf_bytes(), 'offers.pdf', purpose='flyer')
    oats = item(client, nutrition=label())
    milk = item(client, name='Milk', package_size=1, package_unit='L')
    regular = price(client, oats['id'])
    draft = {
        'source_id': source['id'], 'observed_on': '2026-09-14', 'valid_to': '2026-09-20',
        'rows': [{'item_id': oats['id'], 'price': '9.99', 'page': 1},
                 {'item_id': milk['id'], 'price': 'NaN', 'page': 2}],
    }
    assert client.post('/api/imports/commit', json=draft).status_code == 400
    assert client.get(f"/api/items/{oats['id']}").get_json()['prices'] == [regular]
    assert client.get(f"/api/items/{milk['id']}").get_json()['prices'] == []
    draft['rows'][1]['price'] = '4.25'
    committed = client.post('/api/imports/commit', json=draft)
    assert committed.status_code == 200
    assert committed.get_json() == {'saved': 2, 'skipped': 0}
    assert client.post('/api/imports/commit', json=draft).get_json() == {'saved': 0, 'skipped': 2}
    # Even an altered retry cannot silently rewrite a previously reviewed offer.
    draft['rows'][0]['price'] = '8.99'
    assert client.post('/api/imports/commit', json=draft).get_json() == {'saved': 0, 'skipped': 2}
    current = client.get(f"/api/items/{oats['id']}").get_json()
    assert current['nutrition'] == label()
    assert len(current['nutrition_history']) == 1
    assert len(current['prices']) == 2
    assert current['prices'][0]['price'] == 9.99
    assert current['prices'][0]['kind'] == 'offer'
    assert current['prices'][0]['valid_to'] == '2026-09-20'
    assert current['prices'][0]['source_id'] == source['id']
    assert current['prices'][1] == regular


def test_backup_contains_consistent_database_json_and_every_original(client, app, tmp_path):
    photo_raw, flyer_raw = image_bytes(), pdf_bytes()
    photo = upload(client, photo_raw)
    flyer = upload(client, flyer_raw, 'weekly.pdf', 'flyer')
    product = item(client, nutrition=label(), source_ids=[photo['id']])
    client.put(f"/api/items/{product['id']}", json={'nutrition': label('390')})
    price(client, product['id'], source_id=flyer['id'], page=2)
    response = client.get('/api/backup')
    assert response.status_code == 200
    assert response.mimetype == 'application/zip'
    assert 'attachment' in response.headers['Content-Disposition']
    with zipfile.ZipFile(io.BytesIO(response.data)) as archive:
        names = set(archive.namelist())
        assert {'viva.sqlite3', 'records.json', 'RESTORE.txt'} <= names
        assert not any('.session-secret' in name or name.endswith(('-wal', '-shm')) for name in names)
        exported = json.loads(archive.read('records.json'))
        assert set(exported) == {'items', 'nutrition_labels', 'prices', 'sources', 'item_sources'}
        assert len(exported['nutrition_labels']) == 2
        for source, expected in zip(exported['sources'], (photo_raw, flyer_raw)):
            assert archive.read('uploads/' + source['storage_name']) == expected
        snapshot_path = tmp_path / 'snapshot.sqlite3'
        snapshot_path.write_bytes(archive.read('viva.sqlite3'))
    with closing(sqlite3.connect(snapshot_path)) as snapshot:
        snapshot.row_factory = sqlite3.Row
        assert snapshot.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        assert snapshot.execute('PRAGMA foreign_key_check').fetchall() == []
        for table, rows in exported.items():
            assert [dict(row) for row in snapshot.execute(f'SELECT * FROM {table}')] == rows
        price(client, product['id'], price='10.00', observed_on='2026-09-20')
        assert snapshot.execute('SELECT COUNT(*) FROM prices').fetchone()[0] == 1
    assert list(app.config['DATA_DIR'].glob('backup-*.sqlite3')) == []


def test_password_protects_all_private_routes_and_logout_revokes_session(tmp_path, monkeypatch):
    monkeypatch.setenv('VIVA_PASSWORD', 'a-long-private-test-password')
    monkeypatch.delenv('VIVA_HTTPS', raising=False)
    private_app = create_app(data_dir=tmp_path / 'private', testing=True)
    authenticated = private_app.test_client()
    failed = authenticated.post('/login', data={'password': 'incorrect'})
    assert failed.status_code == 200
    assert authenticated.get('/api/items').status_code == 401
    signed_in = authenticated.post('/login', data={'password': 'a-long-private-test-password'})
    assert signed_in.status_code == 302
    assert 'HttpOnly' in signed_in.headers['Set-Cookie']
    assert 'SameSite=Lax' in signed_in.headers['Set-Cookie']
    product = item(authenticated)
    source = upload(authenticated)
    record = price(authenticated, product['id'])
    anonymous = private_app.test_client()
    replacements = {'<int:item_id>': str(product['id']), '<int:source_id>': str(source['id']),
                    '<int:price_id>': str(record['id']), '<path:asset>': 'styles.css'}
    checked = set()
    # Enumerating the routing table makes newly added private endpoints part of this boundary test.
    for route in private_app.url_map.iter_rules():
        if route.endpoint in ('static', 'login', 'health'):
            continue
        path = route.rule
        for parameter, value in replacements.items():
            path = path.replace(parameter, value)
        assert '<' not in path, f'Add a representative URL for {path}'
        for method in route.methods - {'OPTIONS', 'HEAD'}:
            response = anonymous.open(path, method=method)
            expected = 401 if path.startswith('/api/') else 302
            assert response.status_code == expected, (method, path, response.status_code)
            checked.add((method, route.rule))
    assert ('GET', '/api/backup') in checked
    assert ('POST', '/api/sources/<int:source_id>/extract') in checked
    assert anonymous.get('/health').get_json() == {'status': 'ok'}
    assert anonymous.get('/login').status_code == 200
    assert authenticated.get('/api/info').get_json()['auth_required'] is True
    assert authenticated.post('/logout').status_code == 302
    assert authenticated.get('/api/items').status_code == 401


def test_cross_origin_changes_are_rejected_and_api_responses_are_not_cached(client):
    blocked = client.post('/api/items', json={'name': 'Injected item'},
                          headers={'Origin': 'https://another-site.example'})
    assert blocked.status_code == 403
    response = client.get('/api/items')
    assert response.get_json() == {'items': []}
    assert response.headers['Cache-Control'] == 'no-store'
    assert response.headers['X-Content-Type-Options'] == 'nosniff'
    allowed = client.post('/api/items', json={'name': 'My item'},
                          headers={'Origin': 'http://localhost'})
    assert allowed.status_code == 200


@pytest.mark.parametrize('host', ['attacker.example', '192.168.1.15:8765'])
def test_passwordless_app_rejects_external_host_headers(client, host):
    response = client.get('/api/items', headers={'Host': host})
    assert response.status_code == 400
    blocked = client.post('/api/items', headers={'Host': host}, json={'name': 'Rejected item'})
    assert blocked.status_code == 400
    assert client.get('/api/items').get_json() == {'items': []}


@pytest.mark.parametrize('remote_address', ['192.168.1.22', '203.0.113.5', '2001:db8::5'])
def test_passwordless_app_rejects_network_clients_even_with_loopback_host(client, remote_address):
    overrides = {'REMOTE_ADDR': remote_address}
    assert client.get('/api/items', environ_overrides=overrides).status_code == 403
    blocked = client.post('/api/items', environ_overrides=overrides,
                          headers={'X-Forwarded-For': '127.0.0.1'}, json={'name': 'Rejected item'})
    assert blocked.status_code == 403
    assert client.get('/api/items').get_json() == {'items': []}


@pytest.mark.parametrize('host,remote_address', [('localhost:8765', '127.0.0.1'),
                                               ('127.0.0.1:8765', '127.0.0.1'),
                                               ('[::1]:8765', '::1')])
def test_passwordless_app_remains_accessible_over_loopback(client, host, remote_address):
    response = client.get('/api/items', headers={'Host': host},
                          environ_overrides={'REMOTE_ADDR': remote_address})
    assert response.status_code == 200
    assert response.get_json() == {'items': []}
