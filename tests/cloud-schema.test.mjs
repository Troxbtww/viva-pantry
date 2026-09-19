import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

test('cloud schema protects each account and preserves reviewed records transactionally', async t => {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth; create schema storage;
    create table auth.users(id uuid primary key);
    insert into auth.users values ('${OWNER}'),('${OTHER}');
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id bigint generated always as identity,name text,bucket_id text,metadata jsonb);
    alter table storage.objects enable row level security;
    create function storage.foldername(text) returns text[] language sql immutable as
      $$ select string_to_array($1, '/') $$;
    grant usage on schema public,auth,storage to authenticated,anon;
    grant execute on function auth.uid(),storage.foldername(text) to authenticated,anon;
    grant select,insert,delete on storage.objects to authenticated;
    grant usage on sequence storage.objects_id_seq to authenticated;
  `);
  const schema = await readFile(new URL('../cloud/schema.sql', import.meta.url), 'utf8');
  await db.exec(schema);
  await db.exec(schema); // The published setup script can safely be re-run.
  async function asUser(id = OWNER, role = 'authenticated') {
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
    await db.exec(`set role ${role}`);
  }
  async function rpc(name, args = [], casts = []) {
    const params = args.map((_, i) => `$${i + 1}${casts[i] ? `::${casts[i]}` : ''}`).join(',');
    return (await db.query(`select public.${name}(${params}) as result`, args.map(value => value !== null && typeof value === 'object' ? JSON.stringify(value) : value))).rows[0].result;
  }
  const save = (data, id = null) => rpc('pantry_save_item', [data, id], ['jsonb', 'bigint']);
  const snapshot = () => rpc('pantry_snapshot');
  const addPrice = (id, data) => rpc('pantry_add_price', [id, data], ['bigint', 'jsonb']);
  const nutrition = { basis: 'per 100 g', serving_size: '40 g', values: [
    { label: 'Protein', value: '13.2', unit: 'g' }, { label: 'Salt', value: '<0.5', unit: 'g' },
  ] };
  let itemId, sourceId, priceId;
  try {
    await asUser();
    await t.test('creates minimal items and stores exact fils with nutrition revisions', async () => {
      itemId = await save({ name: 'Rolled oats', package_size: 500, package_unit: 'g', nutrition });
      priceId = await addPrice(itemId, { price: '0.29', observed_on: '2026-09-19' });
      await save({ name: 'Wholegrain oats' }, itemId);
      let data = await snapshot();
      assert.equal(data.items[0].pack_count, 1);
      assert.equal(data.prices[0].amount_fils, 29);
      assert.equal(data.nutrition_labels.length, 1);
      assert.deepEqual(data.nutrition_labels[0].content, nutrition);
      await save({ nutrition }, itemId);
      assert.equal((await snapshot()).nutrition_labels.length, 1);
      await save({ nutrition: { ...nutrition, basis: 'per serving' } }, itemId);
      assert.equal((await snapshot()).nutrition_labels.length, 2);
    });

    await t.test('rejects invalid money, dates, pages and changed pack sizes without mutation', async () => {
      const before = await snapshot();
      for (const price of ['NaN', 'Infinity', '0', '-1', '1.001', '100000.01']) {
        await assert.rejects(addPrice(itemId, { price, observed_on: '2026-09-19' }));
      }
      for (const details of [{ observed_on: '2026-02-30' }, { observed_on: '20260919' },
        { valid_to: '2026-09-18' }, { page: 0 }, { source_id: 0 }, { page: 1 }]) {
        await assert.rejects(addPrice(itemId, { price: '9.99', observed_on: '2026-09-19', ...details }));
      }
      await assert.rejects(save({ package_size: 1000 }, itemId), /separate item/);
      await assert.rejects(save({ pack_count: 2 }, itemId), /separate item/);
      assert.deepEqual(await snapshot(), before);
    });

    await t.test('registers only existing owned originals and deduplicates checksum', async () => {
      const storageName = `${OWNER}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.pdf`;
      const source = { storage_name: storageName, filename: 'weekly.pdf', mime_type: 'application/pdf',
        checksum: 'a'.repeat(64), byte_size: 100, page_count: 2, purpose: 'flyer' };
      await assert.rejects(rpc('pantry_register_source', [source], ['jsonb']), /not finished uploading/);
      await db.query('insert into storage.objects(name,bucket_id,metadata) values($1,$2,$3)', [storageName, 'pantry-originals', { size: 100 }]);
      const registered = await rpc('pantry_register_source', [source], ['jsonb']);
      sourceId = registered.id;
      assert.equal(registered.page_count, 2);
      const duplicate = await rpc('pantry_register_source', [source], ['jsonb']);
      assert.equal(duplicate.id, sourceId);
      assert.equal(duplicate.duplicate, true);
      await save({ source_ids: [sourceId] }, itemId);
      assert.equal((await snapshot()).item_sources.length, 1);
      await save({ notes: 'Keep original' }, itemId);
      assert.equal((await snapshot()).item_sources.length, 1);
      await save({ source_ids: [] }, itemId);
      assert.equal((await snapshot()).item_sources.length, 0);
      assert.equal((await snapshot()).sources.length, 1);
      // Even the owning user cannot delete a registered original through Storage.
      assert.equal((await db.query('delete from storage.objects where name=$1 returning id', [storageName])).rows.length, 0);
    });

    await t.test('flyer commits are atomic and idempotent', async () => {
      const second = await save({ name: 'Milk', package_size: 1, package_unit: 'L' });
      const batch = { source_id: sourceId, observed_on: '2026-09-14', valid_to: '2026-09-20', rows: [
        { item_id: itemId, price: '8.99', page: 1 }, { item_id: second, price: 'NaN', page: 2 },
      ] };
      const before = await snapshot();
      await assert.rejects(rpc('pantry_commit_import', [batch], ['jsonb']));
      assert.deepEqual(await snapshot(), before);
      batch.rows[1].price = '4.25';
      assert.deepEqual(await rpc('pantry_commit_import', [batch], ['jsonb']), { saved: 2, skipped: 0 });
      assert.deepEqual(await rpc('pantry_commit_import', [batch], ['jsonb']), { saved: 0, skipped: 2 });
      batch.rows[0].price = '7.99';
      assert.deepEqual(await rpc('pantry_commit_import', [batch], ['jsonb']), { saved: 0, skipped: 2 });
      const data = await snapshot();
      assert.equal(data.prices.filter(p => p.kind === 'offer').find(p => p.item_id === itemId).amount_fils, 899);
      assert.equal(data.nutrition_labels.length, 2);
    });

    await t.test('cannot bypass RPC validation with direct table writes or internal functions', async () => {
      await assert.rejects(db.query('update public.pantry_items set package_size=900 where id=$1', [itemId]), /permission denied/);
      await assert.rejects(db.query('insert into public.pantry_items(name) values($1)', ['Bypass']), /permission denied/);
      await assert.rejects(rpc('pantry_insert_price', [itemId, { price: '1', observed_on: '2026-09-19' }, null], ['bigint', 'jsonb', 'text']), /permission denied/);
    });

    await t.test('another account cannot read, edit, attach, delete or sign owner originals', async () => {
      await asUser(OTHER);
      const empty = await snapshot();
      for (const table of ['items', 'sources', 'prices', 'nutrition_labels', 'item_sources']) assert.deepEqual(empty[table], []);
      assert.deepEqual((await db.query('select * from public.pantry_items')).rows, []);
      assert.deepEqual((await db.query('select * from storage.objects')).rows, []);
      await assert.rejects(save({ name: 'Stolen' }, itemId), /not found/);
      await assert.rejects(save({ name: 'Wrong source', source_ids: [sourceId] }), /not found/);
      await assert.rejects(addPrice(itemId, { price: '1', observed_on: '2026-09-19' }), /not found/);
      await assert.rejects(rpc('pantry_delete_price', [priceId], ['bigint']), /not found/);
      await assert.rejects(rpc('pantry_save_extraction', [sourceId, {}], ['bigint', 'jsonb']), /not found/);
      await assert.rejects(db.query('insert into storage.objects(name,bucket_id,metadata) values($1,$2,$3)',
        [`${OWNER}/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jpg`, 'pantry-originals', { size: 100 }]), /row-level security/);
      const own = await save({ name: 'Other account food' });
      assert.equal((await snapshot()).items[0].id, own);
      await asUser();
      assert.equal((await snapshot()).items.length, 2);
    });

    await t.test('browser adapter uses the RPC contract and exports every original in a verified backup', async () => {
      const originals = new Map();
      const bytes = new Uint8Array(100).fill(65);
      const checksum = Buffer.from(await webcrypto.subtle.digest('SHA-256', bytes)).toString('hex');
      const source = (await snapshot()).sources[0];
      originals.set(source.storage_name, new Blob([bytes], { type: 'application/pdf' }));
      await db.exec('reset role');
      await db.query('update public.pantry_sources set checksum=$1 where id=$2', [checksum, sourceId]);
      await asUser();
      const rpcParameters = {
        pantry_snapshot: [], pantry_save_item: ['p_data', 'p_item_id'],
        pantry_add_price: ['p_item_id', 'p_data'], pantry_delete_price: ['p_price_id'],
        pantry_commit_import: ['p_data'], pantry_register_source: ['p_data'],
        pantry_save_extraction: ['p_source_id', 'p_extraction'],
      };
      const rpcCasts = {
        pantry_snapshot: [], pantry_save_item: ['jsonb', 'bigint'],
        pantry_add_price: ['bigint', 'jsonb'], pantry_delete_price: ['bigint'],
        pantry_commit_import: ['jsonb'], pantry_register_source: ['jsonb'],
        pantry_save_extraction: ['bigint', 'jsonb'],
      };
      const fakeClient = {
        auth: { getSession: async () => ({ data: { session: { user: { id: OWNER } } } }) },
        rpc: async (name, args) => {
          try { return { data: await rpc(name, rpcParameters[name].map(key => args[key]), rpcCasts[name]) }; }
          catch (error) { return { error }; }
        },
        from: table => {
          assert.equal(table, 'pantry_sources');
          return { select: () => ({ eq: (column, value) => ({ maybeSingle: async () => {
            assert.ok(['id', 'checksum'].includes(column));
            return { data: (await db.query(`select * from public.pantry_sources where ${column}=$1`, [value])).rows[0] || null };
          } }) }) };
        },
        storage: { from: bucket => {
          assert.equal(bucket, 'pantry-originals');
          return {
            createSignedUrl: async (name, seconds) => {
              assert.equal(seconds, 3600);
              return { data: { signedUrl: `https://private.example/${name}?signed=yes` } };
            },
            download: async name => ({ data: originals.get(name) }),
            upload: async (name, blob, options) => {
              assert.equal(options.upsert, false);
              originals.set(name, blob);
              await db.query('insert into storage.objects(name,bucket_id,metadata) values($1,$2,$3)', [name, bucket, { size: blob.size }]);
              return { data: { path: name } };
            },
            remove: async names => {
              for (const name of names) {
                const removed = await db.query('delete from storage.objects where name=$1 returning id', [name]);
                if (removed.rows.length) originals.delete(name);
              }
              return { data: [] };
            },
          };
        } },
      };
      let downloadedBlob, anchorClicked = false;
      class TestURL extends URL {
        static createObjectURL(blob) { downloadedBlob = blob; return 'blob:backup'; }
        static revokeObjectURL() {}
      }
      class TestFileReader {
        readAsDataURL(blob) {
          blob.arrayBuffer().then(buffer => {
            this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`;
            this.onload();
          }).catch(() => this.onerror());
        }
      }
      const context = vm.createContext({
        window: { pantrySupabase: fakeClient, VIVA_CLOUD_CONFIG: { url: 'https://test.supabase.co', anonKey: 'public-test-key' },
          PantryExtractor: {
            inspect: async () => ({ mime_type: 'image/png', page_count: 1 }),
            preview: async (_source, blob, page) => { assert.equal(page, 1); assert.ok(blob.size > 0); return 'blob:preview'; },
            extractSource: async () => ({ pages: [{ page: 1, text: 'Oats', preview_url: 'blob:device-only' }], warnings: [], candidates: [] }),
          } },
        location: { origin: 'https://pantry.example' }, URL: TestURL, Blob, FormData, FileReader: TestFileReader,
        crypto: webcrypto, setTimeout: callback => callback(),
        document: { body: { append() {} }, createElement: tag => {
          assert.equal(tag, 'a');
          return { click() { anchorClicked = true; }, remove() {} };
        } },
      });
      vm.runInContext(await readFile(new URL('../static/cloud-store.js', import.meta.url), 'utf8'), context);
      const adapter = context.window.PantryCloud;
      assert.equal(adapter.init(), true);
      assert.equal((await adapter.api('/api/info')).auth_required, true);
      const library = await adapter.api('/api/items');
      assert.equal(library.items.length, 2);
      const oats = library.items.find(item => item.id === itemId);
      assert.equal(oats.nutrition_history.length, 2);
      assert.equal(oats.prices.find(price => price.id === priceId).price, 0.29);
      assert.equal(oats.prices.find(price => price.id === priceId).week_start, '2026-09-14');
      assert.ok(!('owner_id' in oats));
      const created = await adapter.api('/api/items', { method: 'POST', body: JSON.stringify({ name: 'Adapter food', source_ids: [sourceId] }) });
      assert.match(created.sources[0].url, /^https:\/\/private.example\//);
      const added = await adapter.api(`/api/items/${created.id}/prices`, { method: 'POST', body: JSON.stringify({ price: '3.49', observed_on: '2026-09-21' }) });
      assert.equal(added.price, 3.49);
      assert.equal(added.week_start, '2026-09-21');
      await adapter.api(`/api/prices/${added.id}`, { method: 'DELETE' });
      assert.equal((await adapter.api(`/api/items/${created.id}`)).prices.length, 0);
      const photo = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' });
      const photoForm = new FormData();
      photoForm.append('file', photo, 'label.png');
      const uploaded = await adapter.api('/api/uploads', { method: 'POST', body: photoForm });
      assert.equal(uploaded.mime_type, 'image/png');
      const duplicate = await adapter.api('/api/uploads', { method: 'POST', body: photoForm });
      assert.equal(duplicate.id, uploaded.id);
      assert.equal(duplicate.duplicate, true);
      assert.equal(originals.size, 2);
      assert.equal(await adapter.preview(uploaded.id, 1), 'blob:preview');
      const extracted = await adapter.api(`/api/sources/${uploaded.id}/extract`, { method: 'POST' });
      assert.equal(extracted.pages[0].preview_url, 'blob:device-only');
      const persistedExtraction = (await snapshot()).sources.find(record => record.id === uploaded.id).extraction;
      assert.equal(persistedExtraction.pages[0].preview_url, undefined);
      const downloaded = await adapter.backup();
      assert.equal(downloaded.sources, 2);
      assert.equal(downloaded.items, 3);
      assert.equal(anchorClicked, true);
      const backup = JSON.parse(await downloadedBlob.text());
      assert.equal(backup.format_version, 1);
      assert.equal(backup.records.nutrition_labels.length, 2);
      assert.deepEqual(Buffer.from(backup.files[0].data_base64, 'base64'), Buffer.from(bytes));
      assert.equal(backup.files[0].checksum, checksum);
      assert.ok(!JSON.stringify(backup).includes('public-test-key'));
    });

    await t.test('anonymous sessions cannot call private RPCs or read tables', async () => {
      await asUser('', 'anon');
      await assert.rejects(snapshot(), /permission denied/);
      await assert.rejects(db.query('select * from public.pantry_items'), /permission denied/);
      await asUser('', 'authenticated');
      await assert.rejects(snapshot(), /Sign in/);
      await assert.rejects(save({ name: 'No identity' }), /Sign in/);
    });
  } finally { await db.close(); }
});
