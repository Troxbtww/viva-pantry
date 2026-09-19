/* Supabase adapter for the same reviewed-record contract as the local Flask app.
 * Auth owns the client; this file never reads or needs a service-role key. */
(() => {
  'use strict';
  const BUCKET = 'pantry-originals';
  const MAX_FILE_BYTES = 40 * 1024 * 1024;
  const signedUrls = new Map();
  const blobs = new Map();
  let activeUser = null;

  function init() {
    return Boolean(window.pantrySupabase && window.VIVA_CLOUD_CONFIG?.url && window.VIVA_CLOUD_CONFIG?.anonKey);
  }

  function failure(error, fallback = 'Your pantry could not be updated. Please try again.') {
    const message = error?.message || (typeof error === 'string' ? error : fallback);
    if (/jwt expired|invalid jwt|not authenticated|refresh token/i.test(message)) {
      return new Error('Your sign-in has expired. Sign in again to continue.');
    }
    if (/quota|maximum.*storage|storage.*limit/i.test(message)) {
      return new Error('The free storage allowance has been reached. Download a backup and check your Supabase storage before uploading more files.');
    }
    if (/Failed to fetch|NetworkError|network request failed/i.test(message)) {
      return new Error('The connection was interrupted. Please reconnect and try again.');
    }
    return new Error(message);
  }

  async function client() {
    if (!init()) throw new Error('Cloud setup is incomplete. Connect this website to your Supabase project first.');
    const supabase = window.pantrySupabase;
    const { data, error } = await supabase.auth.getSession();
    if (error) throw failure(error);
    const userId = data?.session?.user?.id;
    if (!userId) throw new Error('Sign in to continue.');
    if (activeUser !== userId) {
      signedUrls.clear();
      blobs.clear();
      window.PantryExtractor?.releaseAllPreviews?.();
      activeUser = userId;
    }
    return supabase;
  }

  async function rpc(name, args = {}) {
    const supabase = await client();
    const { data, error } = await supabase.rpc(name, args);
    if (error) throw failure(error);
    return data;
  }

  function positiveId(value) {
    const raw = String(value);
    if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error('This record ID is invalid.');
    return Number(raw);
  }

  function body(options) {
    let data;
    try { data = typeof options.body === 'string' ? JSON.parse(options.body) : (options.body || {}); }
    catch { throw new Error('The form could not be read. Please try again.'); }
    if (!data || Array.isArray(data) || typeof data !== 'object') throw new Error('Expected a record.');
    return data;
  }

  function weekStart(observed) {
    const date = new Date(`${observed}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
    return date.toISOString().slice(0, 10);
  }

  function priceRecord(row) {
    const { owner_id, amount_fils, import_key, ...result } = row;
    return { ...result, price: amount_fils / 100, week_start: weekStart(row.observed_on) };
  }

  async function signedSource(row) {
    const supabase = await client();
    const cacheKey = `${activeUser}:${row.storage_name}`;
    let cached = signedUrls.get(cacheKey);
    if (!cached || cached.expires < Date.now()) {
      const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(row.storage_name, 3600);
      if (error) throw failure(error, 'The original file could not be opened.');
      cached = { url: data.signedUrl, expires: Date.now() + 50 * 60 * 1000 };
      signedUrls.set(cacheKey, cached);
    }
    return {
      id: row.id, filename: row.filename, mime_type: row.mime_type, purpose: row.purpose,
      page_count: row.page_count, created_at: row.created_at, byte_size: row.byte_size, url: cached.url,
    };
  }

  async function rawSnapshot() {
    const snapshot = await rpc('pantry_snapshot');
    if (!snapshot || !Array.isArray(snapshot.items) || !Array.isArray(snapshot.sources)) {
      throw new Error('The cloud database has not been set up correctly. Run cloud/schema.sql in your Supabase SQL editor.');
    }
    return snapshot;
  }

  async function renderSnapshot(snapshot) {
    // Work in bounded groups so a photo collection does not flood a phone's network.
    const sources = [];
    for (let i = 0; i < snapshot.sources.length; i += 8) {
      sources.push(...await Promise.all(snapshot.sources.slice(i, i + 8).map(signedSource)));
    }
    const sourceMap = new Map(sources.map(source => [String(source.id), source]));
    const items = snapshot.items.map(row => {
      const { owner_id, ...product } = row;
      const labels = snapshot.nutrition_labels.filter(label => String(label.item_id) === String(row.id))
        .sort((a, b) => Number(b.id) - Number(a.id));
      const relations = snapshot.item_sources.filter(link => String(link.item_id) === String(row.id));
      return {
        ...product,
        nutrition: labels[0]?.content || { basis: 'per 100 g', serving_size: '', values: [] },
        nutrition_history: labels.map(label => ({ id: label.id, recorded_at: label.recorded_at, ...label.content })),
        sources: relations.map(link => sourceMap.get(String(link.source_id))).filter(Boolean),
        prices: snapshot.prices.filter(price => String(price.item_id) === String(row.id)).map(priceRecord),
      };
    });
    return { items, sources };
  }

  async function oneItem(id) {
    const snapshot = await renderSnapshot(await rawSnapshot());
    const product = snapshot.items.find(item => String(item.id) === String(id));
    if (!product) throw new Error('This food item could not be found.');
    return product;
  }

  async function rawSource(id) {
    const supabase = await client();
    const { data, error } = await supabase.from('pantry_sources').select('*').eq('id', positiveId(id)).maybeSingle();
    if (error) throw failure(error);
    if (!data) throw new Error('This original file could not be found.');
    return data;
  }

  async function sourceBlob(source) {
    const supabase = await client();
    const key = `${activeUser}:${source.storage_name}`;
    if (blobs.has(key)) return blobs.get(key);
    const { data, error } = await supabase.storage.from(BUCKET).download(source.storage_name);
    if (error) throw failure(error, 'The original file could not be downloaded.');
    // Limit retained originals to two; PDF renderers may already hold decoded pages.
    if (blobs.size >= 2) blobs.delete(blobs.keys().next().value);
    blobs.set(key, data);
    return data;
  }

  async function sha256(blob) {
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  async function upload(form) {
    if (!(form instanceof FormData)) throw new Error('Choose a photo or PDF.');
    const file = form.get('file');
    if (!(file instanceof Blob) || !file.size) throw new Error('Choose a non-empty photo or PDF.');
    if (file.size > MAX_FILE_BYTES) throw new Error('Please choose a file smaller than 40 MB.');
    if (!window.PantryExtractor?.inspect) throw new Error('The file reader has not loaded. Reload the website and try again.');
    const inspected = await window.PantryExtractor.inspect(file);
    const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' }[inspected.mime_type];
    if (!extension || !Number.isInteger(inspected.page_count) || inspected.page_count < 1 || inspected.page_count > 10000) {
      throw new Error('Please use a valid JPG, PNG, WebP photo or unlocked PDF.');
    }
    const checksum = await sha256(file);
    const supabase = await client();
    const { data: existing, error: lookupError } = await supabase.from('pantry_sources').select('*').eq('checksum', checksum).maybeSingle();
    if (lookupError) throw failure(lookupError);
    if (existing) return { ...await signedSource(existing), duplicate: true };
    const filename = String(file.name || `original.${extension}`).split(/[\\/]/).pop().replace(/[\u0000-\u001f]/g, '').trim().slice(0, 180) || `original.${extension}`;
    const storageName = `${activeUser}/${crypto.randomUUID()}.${extension}`;
    const { error: storageError } = await supabase.storage.from(BUCKET).upload(storageName, file, {
      contentType: inspected.mime_type, upsert: false, cacheControl: '3600',
    });
    if (storageError) throw failure(storageError, 'The original file could not be uploaded.');
    let registered;
    try {
      registered = await rpc('pantry_register_source', { p_data: {
        filename, storage_name: storageName, checksum, mime_type: inspected.mime_type,
        purpose: form.get('purpose') === 'flyer' ? 'flyer' : 'photo',
        page_count: inspected.page_count, byte_size: file.size,
      } });
    } catch (error) {
      // A lost response may still mean the transaction succeeded. Recheck first.
      const retry = await supabase.from('pantry_sources').select('*').eq('checksum', checksum).maybeSingle();
      if (!retry.error && retry.data) registered = retry.data;
      else {
        if (!retry.error) await supabase.storage.from(BUCKET).remove([storageName]);
        throw error;
      }
    }
    if (registered.storage_name !== storageName) {
      // A simultaneous upload of identical bytes won the unique checksum race.
      await supabase.storage.from(BUCKET).remove([storageName]);
    }
    return { ...await signedSource(registered), ...(registered.duplicate ? { duplicate: true } : {}) };
  }

  async function preview(sourceId, page = 1) {
    if (!Number.isInteger(page) || page < 1) throw new Error('Choose a valid page.');
    const source = await rawSource(sourceId);
    if (page > source.page_count) throw new Error('This page is outside the original file.');
    if (!window.PantryExtractor?.preview) throw new Error('The PDF preview reader has not loaded.');
    return window.PantryExtractor.preview(source, await sourceBlob(source), page);
  }

  async function extract(sourceId) {
    const source = await rawSource(sourceId);
    if (!window.PantryExtractor?.extractSource) throw new Error('The text reader has not loaded. Your original file is saved; reload and try again.');
    const snapshot = await rawSnapshot();
    const result = await window.PantryExtractor.extractSource(source, await sourceBlob(source), snapshot.items);
    const persisted = { ...result, pages: (result.pages || []).map(({ preview_url, ...page }) => page) };
    try { await rpc('pantry_save_extraction', { p_source_id: source.id, p_extraction: persisted }); }
    catch (error) {
      result.warnings = [...(result.warnings || []), `The suggestions could not be cached: ${error.message} Your original is still saved.`];
    }
    return result;
  }

  async function api(path, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const url = new URL(path, location.origin);
    const route = url.pathname;
    let match;
    if (route === '/api/info' && method === 'GET') {
      await client();
      return { currency: 'AED', version: '2.0-cloud', phone_urls: [location.origin], auth_required: true, cloud: true };
    }
    if (route === '/api/items' && method === 'GET') return { items: (await renderSnapshot(await rawSnapshot())).items };
    if (route === '/api/sources' && method === 'GET') {
      const snapshot = await renderSnapshot(await rawSnapshot());
      return { sources: snapshot.sources.sort((a, b) => Number(b.id) - Number(a.id)) };
    }
    if ((match = route.match(/^\/api\/items\/(\d+)$/)) && method === 'GET') return oneItem(positiveId(match[1]));
    if (route === '/api/items' && method === 'POST') {
      const id = await rpc('pantry_save_item', { p_data: body(options), p_item_id: null });
      return oneItem(id);
    }
    if ((match = route.match(/^\/api\/items\/(\d+)$/)) && method === 'PUT') {
      const id = await rpc('pantry_save_item', { p_data: body(options), p_item_id: positiveId(match[1]) });
      return oneItem(id);
    }
    if ((match = route.match(/^\/api\/items\/(\d+)\/prices$/)) && method === 'POST') {
      const id = await rpc('pantry_add_price', { p_item_id: positiveId(match[1]), p_data: body(options) });
      const snapshot = await rawSnapshot();
      const price = snapshot.prices.find(row => String(row.id) === String(id));
      if (!price) throw new Error('The price was saved but could not be reloaded. Refresh your library.');
      return priceRecord(price);
    }
    if ((match = route.match(/^\/api\/prices\/(\d+)$/)) && method === 'DELETE') {
      await rpc('pantry_delete_price', { p_price_id: positiveId(match[1]) });
      return { deleted: true };
    }
    if (route === '/api/uploads' && method === 'POST') return upload(options.body);
    if (route === '/api/imports/commit' && method === 'POST') return rpc('pantry_commit_import', { p_data: body(options) });
    if ((match = route.match(/^\/api\/sources\/(\d+)\/extract$/)) && method === 'POST') return extract(positiveId(match[1]));
    if ((match = route.match(/^\/api\/sources\/(\d+)\/preview$/)) && method === 'GET') return preview(positiveId(match[1]), Number(url.searchParams.get('page') || 1));
    if (route === '/api/backup' && method === 'GET') return backup();
    throw new Error('This action is not available in the cloud pantry.');
  }

  async function base64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('An original file could not be included in the backup.'));
      reader.onload = () => resolve(String(reader.result).split(',')[1]);
      reader.readAsDataURL(blob);
    });
  }

  async function backup() {
    const snapshot = await rawSnapshot();
    const files = [];
    for (const source of snapshot.sources) {
      const original = await sourceBlob(source);
      // Detect a missing/corrupt original instead of silently delivering a partial backup.
      if (await sha256(original) !== source.checksum) throw new Error(`The original ${source.filename} did not match its saved checksum. The backup was not downloaded.`);
      files.push({ source_id: source.id, filename: source.filename, mime_type: source.mime_type,
        checksum: source.checksum, byte_size: original.size, data_base64: await base64(original) });
    }
    const payload = {
      format: 'viva-pantry-backup', format_version: 1, exported_at: new Date().toISOString(), currency: 'AED',
      records: snapshot, files,
      restore_notes: 'Contains complete records and original files. Files are base64 encoded. IDs refer to this backup; importing into another account requires remapping IDs and uploading originals to that account. No credentials or session secrets are included.',
    };
    const output = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const href = URL.createObjectURL(output);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = `viva-pantry-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(href), 60000);
    return { downloaded: true, sources: files.length, items: snapshot.items.length };
  }

  window.PantryCloud = Object.freeze({ init, api, backup, preview });
})();
