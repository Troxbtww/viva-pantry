/* Local, review-only food-label and flyer extraction. Originals never leave
 * this browser through this module. PDF.js, Tesseract and English data are
 * loaded from the site's own bundled vendor directory. */
(function (root) {
  'use strict';

  const MAX_PAGES = 40;
  const MAX_EDGE = 1600;
  const scriptUrl = typeof document !== 'undefined'
    ? new URL(document.currentScript?.getAttribute('src') || 'static/extractor.js', document.baseURI).href : '';
  const assetUrl = (path) => new URL(`vendor/${path}`, scriptUrl).href;
  const currency = String.raw`(?:\bAED\b|\bDHS?\b\.?|\bDIRHAMS?\b|د\s*\.?\s*إ\.?|درهم)`;
  const number = String.raw`(?:\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{1,5}(?:[.,]\d{1,2})?)`;
  const pricePattern = () => new RegExp(`${currency}[ \\t.:]*(${number})(?![\\d.,])|(?<![\\d.,-])(${number})[ \\t]*${currency}`, 'gi');
  const currencyOnly = new RegExp(`^\\s*${currency}[\\s.:]*$`, 'i');
  const plainPrice = new RegExp(`^\\s*(${number})(?:\\s*/-)?\\s*$`);
  const conditionalPattern = /\b(buy\s+\d|\d\s+for|member|loyalty|minimum spend|with purchase|was|rrp)\b/i;
  const emptyNutrition = () => ({basis: '', serving_size: '', values: []});

  function normalized(text) {
    return String(text || '').normalize('NFKC').replace(/[٠-٩۰-۹]/g, digit => {
      const point = digit.codePointAt(0);
      return String(point >= 0x6f0 ? point - 0x6f0 : point - 0x660);
    }).replace(/٫/g, '.').replace(/\u00a0/g, ' ').replace(/−/g, '-');
  }

  function tokens(text) {
    return new Set(normalized(text).toLocaleLowerCase('en').match(/[\p{L}\p{N}]+/gu) || []);
  }

  function priceNumber(value) {
    let cleaned = value;
    if (cleaned.includes(',') && cleaned.includes('.')) cleaned = cleaned.replace(/,/g, '');
    else if (cleaned.includes(',')) cleaned = /^\d{1,3}(?:,\d{3})+$/.test(cleaned) ? cleaned.replace(/,/g, '') : cleaned.replace(',', '.');
    const amount = Number(cleaned);
    return Number.isFinite(amount) && amount > 0 && amount <= 99999 ? amount : null;
  }

  function packSizes(text) {
    const sizes = new Set();
    const pattern = /(?<!\w)(\d+(?:[.,]\d+)?)\s*(kg|grams?|g|ml|litres?|liters?|l)\b/gi;
    for (const match of normalized(text).matchAll(pattern)) {
      const unit = match[2].toLowerCase();
      const family = /^(ml|l|litres?|liters?)$/.test(unit) ? 'volume' : 'mass';
      let amount = Number(match[1].replace(',', '.'));
      if (/^(kg|l|litres?|liters?)$/.test(unit)) amount *= 1000;
      sizes.add(`${family}:${Math.round(amount * 1000000) / 1000000}`);
    }
    return sizes;
  }

  function suggestItem(context, items = []) {
    const present = tokens(context);
    const visibleSizes = packSizes(context);
    const visibleCount = normalized(context).match(/\b(\d+)\s*[x×]\s*\d/i);
    const matches = [];
    for (const item of items) {
      const required = tokens(`${item.name || ''} ${item.brand || ''}`);
      if (!required.size || ![...required].every(value => present.has(value))) continue;
      let pack = String(item.package_size || item.pack_size || '');
      if (item.package_unit) pack += ` ${item.package_unit}`;
      if (!pack && item.pack_amount != null) pack = `${item.pack_amount} ${item.pack_unit || ''}`;
      const expectedSizes = packSizes(pack);
      if (expectedSizes.size && visibleSizes.size && ![...expectedSizes].some(value => visibleSizes.has(value))) continue;
      if (visibleCount && item.pack_count != null && Number(visibleCount[1]) !== Number(item.pack_count)) continue;
      if (item.id != null) matches.push(item.id);
    }
    return matches.length === 1 ? matches[0] : null;
  }

  const textLine = (text, x0 = 0, y0 = 0, x1 = 0, y1 = 0) => ({text, x0, y0, x1, y1});

  function nearby(lines, index) {
    const line = lines[index];
    if (!lines.some(row => row.x1 || row.y1)) {
      const found = [index];
      for (const direction of [-1, 1]) {
        for (let distance = 1; distance <= 2; distance++) {
          const other = index + direction * distance;
          if (other < 0 || other >= lines.length || pricePattern().test(normalized(lines[other].text))) break;
          found.push(other);
        }
      }
      return found.sort((a, b) => a - b);
    }
    const height = Math.max(line.y1 - line.y0, 8);
    const found = [];
    lines.forEach((row, other) => {
      if (other === index) return;
      const xGap = Math.max(row.x0 - line.x1, line.x0 - row.x1, 0);
      const yGap = Math.max(row.y0 - line.y1, line.y0 - row.y1, 0);
      if (xGap <= Math.max(30, height * 2) && yGap <= Math.max(75, height * 6) && !pricePattern().test(normalized(row.text))) {
        found.push([yGap + xGap * 2, other]);
      }
    });
    return [index, ...found.sort((a, b) => a[0] - b[0]).slice(0, 5).map(pair => pair[1])]
      .sort((a, b) => lines[a].y0 - lines[b].y0 || lines[a].x0 - lines[b].x0);
  }

  function isLabel(text) {
    const value = normalized(text).replace(/^[ .:/|\-]+|[ .:/|\-]+$/g, '');
    if (['viva', 'now', 'only', 'price', 'offer', 'special offer', 'a e d'].includes(value.toLowerCase())) return false;
    return /\p{L}/u.test(value) && !currencyOnly.test(value) && !plainPrice.test(value);
  }

  function parsePriceCandidates(text, items = [], page = 1, lines = null) {
    const rows = lines || String(text).split(/\r?\n/).map(value => textLine(value.trim())).filter(row => row.text);
    const candidates = [];
    rows.forEach((row, index) => {
      const value = normalized(row.text);
      const contextRows = nearby(rows, index);
      let prices = [...value.matchAll(pricePattern())].map(match => match[1] || match[2]);
      const plain = value.match(plainPrice);
      if (!prices.length && plain && contextRows.some(other => currencyOnly.test(normalized(rows[other].text)))) prices = [plain[1]];
      if (!prices.length) return;
      const raw = contextRows.map(other => rows[other].text).join('\n').slice(0, 1800);
      const cleaned = value.replace(pricePattern(), '').replace(/^[ .:/|\-]+|[ .:/|\-]+$/g, '');
      const options = contextRows.filter(other => other !== index && isLabel(rows[other].text)).map(other => rows[other].text.trim());
      const label = isLabel(cleaned) ? cleaned : options[0] || 'Unidentified item';
      const itemId = suggestItem(raw, items);
      for (const priceText of prices) {
        const amount = priceNumber(priceText);
        if (amount == null) continue;
        candidates.push({page, label: label.slice(0, 180), price: amount, item_id: itemId,
          confidence: itemId == null ? 'needs_review' : 'suggested', raw_text: raw});
      }
    });
    return candidates;
  }

  const nutrients = [
    ['(?:total\\s+)?saturated\\s+fat|(?:of\\s+which\\s+)?saturates', 'Saturated fat'],
    ['(?:total\\s+)?trans\\s+fat', 'Trans fat'],
    ['(?:total\\s+)?(?:carbohydrates?|carbs)', 'Carbohydrate'],
    ['(?:of\\s+which\\s+)?(?:total\\s+)?sugars?', 'Sugars'],
    ['(?:dietary\\s+)?fib(?:er|re)', 'Fibre'],
    ['(?:total\\s+)?fat', 'Fat'], ['proteins?', 'Protein'], ['sodium', 'Sodium'],
    ['salt', 'Salt'], ['cholesterol', 'Cholesterol'], ['potassium', 'Potassium'],
    ['calcium', 'Calcium'], ['iron', 'Iron'], ['energy|calories', 'Energy'],
  ];

  function parseNutrition(text) {
    text = normalized(text);
    const result = emptyNutrition();
    const warnings = [];
    const bases = new Set();
    for (const match of text.matchAll(/\bper\s*(100\s*(?:g|ml)|serving|portion)\b/gi)) {
      const value = match[1].replace(/\s+/g, '').toLowerCase();
      bases.add(['serving', 'portion'].includes(value) ? 'per serving' : `per 100 ${value.includes('ml') ? 'ml' : 'g'}`);
    }
    if (bases.size === 1) result.basis = [...bases][0];
    const serving = text.match(/\bserving\s+size\s*[:\-]?\s*([^\r\n]{1,80})/i);
    if (serving) result.serving_size = serving[1].trim();
    let ambiguous = bases.size > 1;
    const seen = new Map();
    for (const row of text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)) {
      for (const [pattern, label] of nutrients) {
        // OCR often joins "Salt" and "0.12g" without a space. Accept numeric
        // adjacency, while refusing letter guesses such as "FatOg" for zero.
        const match = row.match(new RegExp(`^(?:${pattern})(?=\\s|\\d|[(:<>=≤≥-]|$)\\s*[:\\-]?\\s*(.*)$`, 'i'));
        if (!match) continue;
        const tail = match[1];
        const header = tail.match(/^\s*[\[(]?(kcal|kj|mcg|µg|μg|mg|g)[\])]?(?:\s|$)/i);
        const quantities = [...tail.matchAll(/(?<![\w.])([<>≤≥]?\s*\d+(?:[.,]\d+)?)\s*(kcal|kj|mcg|µg|μg|mg|g|%)?(?!\w)/gi)]
          .filter(quantity => quantity[2] !== '%')
          .map(quantity => ({value: quantity[1].trim().replace(',', '.'),
            unit: (quantity[2] || header?.[1] || (/^calories/i.test(row) ? 'kcal' : '')).toLowerCase()}));
        const units = new Set(quantities.map(quantity => quantity.unit));
        if (quantities.length > 1 && !(label === 'Energy' && quantities.length === 2 && units.has('kj') && units.has('kcal'))) {
          ambiguous = true;
          break;
        }
        for (const quantity of quantities) {
          const unit = quantity.unit === 'kj' ? 'kJ' : ['mcg', 'μg'].includes(quantity.unit) ? 'µg' : quantity.unit;
          const key = `${label}:${unit}`;
          if (seen.has(key) && seen.get(key) !== quantity.value) ambiguous = true;
          else if (!seen.has(key)) {
            seen.set(key, quantity.value);
            result.values.push({label, value: quantity.value, unit});
          }
        }
        break;
      }
    }
    if (ambiguous) {
      result.values = [];
      if (bases.size > 1) result.basis = '';
      warnings.push('Nutrition has multiple or conflicting columns. Read the label and enter the intended column manually.');
    } else if (result.values.length && !result.basis) {
      warnings.push('The nutrition basis was not clear. Confirm whether these values are per serving, per 100 g or per 100 ml.');
    }
    return {nutrition: result, warnings};
  }

  function rowGroups(lines) {
    const groups = [];
    for (const line of [...lines].sort((a, b) => (a.y0 + a.y1) - (b.y0 + b.y1) || a.x0 - b.x0)) {
      const previous = groups.at(-1)?.[0];
      const tolerance = previous ? Math.max(3, Math.min(line.y1 - line.y0, previous.y1 - previous.y0) * 0.55) : 0;
      if (previous && Math.abs((line.y0 + line.y1 - previous.y0 - previous.y1) / 2) <= tolerance) groups.at(-1).push(line);
      else groups.push([line]);
    }
    return groups.map(group => group.sort((a, b) => a.x0 - b.x0));
  }

  function nutritionText(lines) {
    if (!lines.some(line => line.y1)) return lines.map(line => line.text).join('\n');
    return rowGroups(lines).map(group => group.map(line => line.text).join('  ')).join('\n');
  }

  function joinFragments(lines) {
    const joined = [];
    for (const group of rowGroups(lines)) {
      let current = null;
      for (const line of group) {
        const gap = current ? line.x0 - current.x1 : Infinity;
        if (current && gap <= Math.max(12, Math.min(current.y1 - current.y0, line.y1 - line.y0) * 2.5)) {
          current.text += ` ${line.text}`;
          current.x1 = Math.max(current.x1, line.x1);
          current.y0 = Math.min(current.y0, line.y0);
          current.y1 = Math.max(current.y1, line.y1);
        } else {
          current = {...line};
          joined.push(current);
        }
      }
    }
    return joined;
  }

  let pdfModulePromise;
  let tesseractScriptPromise;
  let ocrWorkerPromise;
  let ocrQueue = Promise.resolve();
  let ocrProgress = null;
  let ocrUses = 0;
  const objectUrls = new Set();
  const previewCache = new WeakMap();

  async function pdfModule() {
    if (!pdfModulePromise) {
      pdfModulePromise = import(assetUrl('pdfjs/pdf.mjs')).then(pdfjs => {
        pdfjs.GlobalWorkerOptions.workerSrc = assetUrl('pdfjs/pdf.worker.mjs');
        return pdfjs;
      }).catch(error => { pdfModulePromise = null; throw error; });
    }
    return pdfModulePromise;
  }

  async function openPdf(blob) {
    const pdfjs = await pdfModule();
    const task = pdfjs.getDocument({data: new Uint8Array(await blob.arrayBuffer()),
      isEvalSupported: false, useSystemFonts: true});
    try { return await task.promise; }
    catch (error) { await task.destroy(); throw error; }
  }

  async function closePdf(pdf) {
    // PDF.js 6 removed PDFDocumentProxy.destroy; the loading task owns workers.
    if (pdf?.loadingTask) await pdf.loadingTask.destroy();
    else if (pdf?.destroy) await pdf.destroy();
  }

  function mimeFromBytes(bytes) {
    if (bytes.length >= 5 && String.fromCharCode(...bytes.slice(0, 5)) === '%PDF-') return 'application/pdf';
    if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return 'image/png';
    if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
    if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP') return 'image/webp';
    return null;
  }

  function loadImage(blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const image = new Image();
      image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
      image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('This image could not be decoded. Please use a readable JPG, PNG or WebP image.')); };
      image.src = url;
    });
  }

  async function inspect(blob) {
    if (!blob || !blob.size) throw new Error('Choose a non-empty PDF, JPG, PNG or WebP file.');
    const mime = mimeFromBytes(new Uint8Array(await blob.slice(0, 16).arrayBuffer()));
    if (!mime) throw new Error('Use PDF, JPG, PNG or WebP files. Export HEIC photos as JPG first.');
    if (mime === 'application/pdf') {
      let pdf;
      try {
        pdf = await openPdf(blob);
        if (!pdf.numPages) throw new Error('This PDF contains no pages.');
        return {mime_type: mime, page_count: pdf.numPages};
      } catch (error) {
        if (error.name === 'PasswordException') throw new Error('This PDF is password protected. Upload an unlocked copy.');
        throw new Error('This PDF could not be opened. Upload a valid, unlocked PDF.');
      } finally { await closePdf(pdf); }
    }
    const image = await loadImage(blob);
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('This image has no readable pixels.');
    return {mime_type: mime, page_count: 1};
  }

  function makeCanvas(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    return canvas;
  }

  async function imageCanvas(blob) {
    const image = await loadImage(blob);
    const scale = Math.min(1, MAX_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = makeCanvas(image.naturalWidth * scale, image.naturalHeight * scale);
    const context = canvas.getContext('2d', {alpha: false});
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  async function renderPage(page) {
    const original = page.getViewport({scale: 1});
    const scale = Math.min(2.2, MAX_EDGE / Math.max(original.width, original.height));
    const viewport = page.getViewport({scale});
    const canvas = makeCanvas(viewport.width, viewport.height);
    await page.render({canvasContext: canvas.getContext('2d', {alpha: false}), viewport}).promise;
    return canvas;
  }

  function freeCanvas(canvas) {
    if (canvas) { canvas.width = 1; canvas.height = 1; }
  }

  function rememberPreview(blob, page, renderedBlob) {
    let pages = previewCache.get(blob);
    if (!pages) { pages = new Map(); previewCache.set(blob, pages); }
    const previous = pages.get(page);
    if (previous && objectUrls.has(previous)) return previous;
    const url = URL.createObjectURL(renderedBlob);
    pages.set(page, url);
    objectUrls.add(url);
    return url;
  }

  async function canvasPreview(blob, page, canvas) {
    const imageBlob = await new Promise((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('Preview could not be created.')), 'image/jpeg', 0.85));
    return rememberPreview(blob, page, imageBlob);
  }

  async function preview(source, blob, pageNumber = 1) {
    const page = Number(pageNumber);
    if (!Number.isInteger(page) || page < 1) throw new Error('Choose a valid page number.');
    const cached = previewCache.get(blob)?.get(page);
    if (cached && objectUrls.has(cached)) return cached;
    const mime = source?.mime_type || mimeFromBytes(new Uint8Array(await blob.slice(0, 16).arrayBuffer()));
    if (mime !== 'application/pdf') {
      if (page !== 1) throw new Error('An image has only one page.');
      return rememberPreview(blob, page, blob);
    }
    let pdf;
    let canvas;
    try {
      pdf = await openPdf(blob);
      if (page > pdf.numPages) throw new Error('That PDF page does not exist.');
      const pdfPage = await pdf.getPage(page);
      canvas = await renderPage(pdfPage);
      return await canvasPreview(blob, page, canvas);
    } finally {
      freeCanvas(canvas);
      await closePdf(pdf);
    }
  }

  function loadTesseract() {
    if (root.Tesseract) return Promise.resolve(root.Tesseract);
    if (!tesseractScriptPromise) {
      tesseractScriptPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = assetUrl('tesseract.min.js');
        script.onload = () => root.Tesseract ? resolve(root.Tesseract) : reject(new Error('Text recognition did not load.'));
        script.onerror = () => { script.remove(); reject(new Error('Text recognition files are unavailable.')); };
        document.head.appendChild(script);
      }).catch(error => { tesseractScriptPromise = null; throw error; });
    }
    return tesseractScriptPromise;
  }

  async function getOcrWorker() {
    if (!ocrWorkerPromise) {
      ocrWorkerPromise = (async () => {
        const tesseract = await loadTesseract();
        const worker = await tesseract.createWorker('eng', 1, {
          workerPath: assetUrl('tesseract/worker.min.js'),
          corePath: assetUrl('tesseract/core/'),
          langPath: assetUrl('tesseract/lang/'),
          workerBlobURL: false,
          gzip: true,
          logger: message => { if (ocrProgress) ocrProgress(message); },
        });
        await worker.setParameters({tessedit_pageseg_mode: '11', preserve_interword_spaces: '1'});
        return worker;
      })().catch(error => { ocrWorkerPromise = null; throw error; });
    }
    return ocrWorkerPromise;
  }

  function report(callback, update) {
    if (typeof callback === 'function') { try { callback(update); } catch (_) { /* UI callbacks cannot abort extraction. */ } }
  }

  function ocrLines(canvas, progress) {
    const work = ocrQueue.then(async () => {
      ocrProgress = message => report(progress, message);
      try {
        if (ocrUses >= 60 && ocrWorkerPromise) {
          await (await ocrWorkerPromise).terminate();
          ocrWorkerPromise = null;
          ocrUses = 0;
        }
        const worker = await getOcrWorker();
        const {data} = await worker.recognize(canvas, {}, {text: true, blocks: true});
        ocrUses++;
        const lines = [];
        for (const block of data.blocks || []) {
          for (const paragraph of block.paragraphs || []) {
            for (const line of paragraph.lines || []) {
              if (!line.text?.trim()) continue;
              const box = line.bbox;
              lines.push(textLine(line.text.trim(), box.x0, box.y0, box.x1, box.y1));
            }
          }
        }
        return lines.length ? lines : (data.text || '').split(/\r?\n/).filter(value => value.trim()).map(value => textLine(value.trim()));
      } finally { ocrProgress = null; }
    });
    ocrQueue = work.catch(() => {});
    return work;
  }

  async function nativePdfLines(page, pdfjs) {
    const content = await page.getTextContent();
    const viewport = page.getViewport({scale: 1});
    const lines = [];
    for (const item of content.items) {
      if (!item.str?.trim() || !item.transform) continue;
      const transform = pdfjs.Util.transform(viewport.transform, item.transform);
      const height = Math.max(1, Math.hypot(transform[2], transform[3]));
      lines.push(textLine(item.str.trim(), transform[4], transform[5] - height, transform[4] + Math.abs(item.width), transform[5]));
    }
    return joinFragments(lines);
  }

  async function extractSource(source, blob, items = [], onProgress = null) {
    const result = {pages: [], candidates: [], nutrition_suggestions: emptyNutrition(), warnings: []};
    const rowsByPage = [];
    let usedOcr = false;
    let pdf;
    const mime = source?.mime_type || mimeFromBytes(new Uint8Array(await blob.slice(0, 16).arrayBuffer()));
    function addPage(pageNumber, lines, previewUrl) {
      const text = lines.map(line => line.text).join('\n');
      const page = {page: pageNumber, text, preview_available: true};
      if (previewUrl) page.preview_url = previewUrl;
      result.pages.push(page);
      result.candidates.push(...parsePriceCandidates(text, items, pageNumber, lines));
      rowsByPage.push(lines);
      if (!text.trim()) result.warnings.push(`No readable text was found on page ${pageNumber}. Review the original and add values manually.`);
    }
    try {
      if (mime === 'application/pdf') {
        const pdfjs = await pdfModule();
        pdf = await openPdf(blob);
        const total = Math.min(pdf.numPages, MAX_PAGES);
        if (pdf.numPages > MAX_PAGES) result.warnings.push(`Only the first ${MAX_PAGES} of ${pdf.numPages} PDF pages were processed.`);
        for (let pageNumber = 1; pageNumber <= total; pageNumber++) {
          report(onProgress, {status: `Reading page ${pageNumber} of ${total}`, progress: (pageNumber - 1) / total, page: pageNumber, total});
          let canvas;
          let pdfPage;
          let lines = [];
          let previewUrl;
          try {
            pdfPage = await pdf.getPage(pageNumber);
            lines = await nativePdfLines(pdfPage, pdfjs);
            const hasText = lines.map(line => line.text).join('').replace(/[^\p{L}\p{N}]/gu, '').length >= 12;
            if (!hasText) {
              usedOcr = true;
              canvas = await renderPage(pdfPage);
              const recognized = await ocrLines(canvas, message => report(onProgress, {status: `Reading text on page ${pageNumber} of ${total}`, progress: (pageNumber - 1 + (message.progress || 0)) / total, page: pageNumber, total}));
              if (recognized.length) lines = recognized;
            }
            // Keep only one eager preview; other pages are rendered on demand.
            if (pageNumber === 1) {
              if (!canvas) canvas = await renderPage(pdfPage);
              previewUrl = await canvasPreview(blob, pageNumber, canvas);
            }
          } catch (_) {
            result.warnings.push(`Text recognition could not read page ${pageNumber}. Use its preview to enter values manually.`);
          } finally {
            freeCanvas(canvas);
            if (pdfPage) pdfPage.cleanup();
          }
          addPage(pageNumber, lines, previewUrl);
        }
      } else if (mime && mime.startsWith('image/')) {
        usedOcr = true;
        let canvas;
        let lines = [];
        try {
          canvas = await imageCanvas(blob);
          lines = await ocrLines(canvas, message => report(onProgress, {status: 'Reading the photo', progress: message.progress || 0, page: 1, total: 1}));
        } catch (_) {
          result.warnings.push('Text recognition could not read this photo. You can still record values from the original image.');
        } finally { freeCanvas(canvas); }
        addPage(1, lines, rememberPreview(blob, 1, blob));
      } else {
        result.warnings.push('Upload a PDF, JPG, PNG or WebP image to extract suggestions.');
      }
    } catch (error) {
      result.warnings.push(error.name === 'PasswordException' ? 'This PDF is password protected. Upload an unlocked copy.' : 'This file could not be opened. Check that it is a valid, readable PDF or image.');
    } finally {
      await closePdf(pdf);
    }
    const combinedText = result.pages.map(page => page.text).join('\n\n');
    const nutrition = parseNutrition(rowsByPage.map(nutritionText).join('\n\n'));
    result.nutrition_suggestions = nutrition.nutrition;
    result.warnings.push(...nutrition.warnings);
    if (usedOcr) result.warnings.push('Text recognition runs in your browser. It can miss Arabic text, small print and styled prices. Check every suggestion against the original.');
    if (result.candidates.length) result.warnings.push('Confirm each product, package size, price and offer date before saving. Printed previous prices may also be detected.');
    if (conditionalPattern.test(combinedText)) result.warnings.push('The source may contain previous prices or conditional offers. Record multi-buy and membership conditions explicitly.');
    result.warnings = [...new Set(result.warnings)];
    report(onProgress, {status: 'Ready to review', progress: 1, page: result.pages.length, total: result.pages.length});
    return result;
  }

  function revokePreview(url) {
    if (objectUrls.delete(url)) URL.revokeObjectURL(url);
  }

  function releaseAllPreviews() {
    for (const url of [...objectUrls]) revokePreview(url);
  }

  async function dispose() {
    await ocrQueue;
    if (ocrWorkerPromise) {
      const worker = await ocrWorkerPromise.catch(() => null);
      if (worker) await worker.terminate();
      ocrWorkerPromise = null;
      ocrUses = 0;
    }
    releaseAllPreviews();
  }

  const api = {inspect, preview, extractSource, revokePreview, releaseAllPreviews, dispose,
    _test: {normalized, priceNumber, packSizes, suggestItem, textLine, parsePriceCandidates,
      parseNutrition, nutritionText, joinFragments, mimeFromBytes}};
  root.PantryExtractor = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof root.addEventListener === 'function') root.addEventListener('pagehide', releaseAllPreviews);
})(typeof window !== 'undefined' ? window : globalThis);
