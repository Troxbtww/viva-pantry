/* Read-only CSV mapping. Saving the returned items is a separate, reviewed action. */
(function (root) {
  'use strict';

  const nutrients = [
    ['Calories / basis', 'Energy', 'kcal'],
    ['Protein g / basis', 'Protein', 'g'],
    ['Carbs g / basis', 'Carbohydrates', 'g'],
    ['Fat g / basis', 'Fat', 'g'],
    ['Fibre g / basis', 'Fibre', 'g'],
    ['Sugar g / basis', 'Sugars', 'g'],
    ['Sodium mg / basis', 'Sodium', 'mg'],
    ['Calcium mg / basis', 'Calcium', 'mg'],
    ['Vitamin D mcg / basis', 'Vitamin D', 'mcg'],
  ];
  const clean = value => String(value ?? '').trim();
  const headerKey = value => clean(value).toLocaleLowerCase('en');
  const decimal = /^(?:\d+(?:\.\d+)?|\.\d+)$/;
  const missing = /^(?:n\/?a|not captured|unknown|[-–—])$/i;

  function csvRows(text) {
    const rows = [];
    let row = [], field = '', quoted = false, closed = false;
    const finishField = () => { row.push(field); field = ''; closed = false; };
    const finishRow = () => {
      finishField();
      if (row.some(value => clean(value))) rows.push(row);
      row = [];
    };
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else { quoted = false; closed = true; }
        } else field += ch;
      } else if (ch === ',') finishField();
      else if (ch === '\n' || ch === '\r') {
        finishRow();
        if (ch === '\r' && text[i + 1] === '\n') i++;
      } else if (closed) {
        if (!/[ \t]/.test(ch)) throw new Error('The CSV has text after a closing quote. Check the file before importing.');
      } else if (ch === '"') {
        if (clean(field)) throw new Error('The CSV has an unexpected quote. Check the file before importing.');
        field = ''; quoted = true;
      } else field += ch;
    }
    if (quoted) throw new Error('The CSV has an unclosed quoted field. Check the file before importing.');
    finishRow();
    return rows;
  }

  function explicitBrand(name, supplied) {
    if (supplied) return supplied;
    // These names are explicit prefixes in the supported food-database export.
    const match = name.match(/^(Milba|Mövenpick|D[’']Pollo|Dolo|Deep Blue)(?=\s|$)/i);
    return match ? match[1] : '';
  }

  function parse(text, filename = 'food database.csv') {
    if (typeof text !== 'string') throw new Error('Choose a CSV text file.');
    if (text.length > 2_000_000) throw new Error('This CSV is too large. Import a file smaller than 2 MB.');
    const rows = csvRows(text.replace(/^\uFEFF/, ''));
    if (rows.length < 2) throw new Error('The CSV needs a header and at least one food row.');
    if (rows.length > 1001) throw new Error('Import at most 1,000 foods at a time.');
    const headers = rows.shift().map(headerKey);
    if (new Set(headers).size !== headers.length || headers.some(header => !header)) {
      throw new Error('The CSV has blank or duplicate column headings.');
    }
    if (!headers.includes('food') || !nutrients.some(([header]) => headers.includes(headerKey(header)))) {
      throw new Error('Use the food database CSV with a Food column and nutrition columns such as Calories / basis.');
    }
    const sourceName = clean(filename).split(/[\\/]/).pop() || 'food database.csv';

    return rows.map((cells, index) => {
      const rowNumber = index + 2;
      if (cells.length !== headers.length) {
        throw new Error(`CSV row ${rowNumber} has ${cells.length} fields; the header has ${headers.length}. Check commas and quotes.`);
      }
      const source = Object.fromEntries(headers.map((header, i) => [header, clean(cells[i])]));
      const get = header => source[headerKey(header)] || '';
      const name = get('Food');
      if (!name) throw new Error(`CSV row ${rowNumber} has no food name.`);
      const warnings = [];
      const notes = [`Imported from ${sourceName}; awaiting your review.`];
      const warn = message => { warnings.push(message); notes.push(`Review: ${message}`); };
      const numberText = (value, label, positive = false, maximum = Number.MAX_SAFE_INTEGER) => {
        if (!value || missing.test(value)) return null;
        const amount = decimal.test(value) ? Number(value) : NaN;
        if (value.length > 60 || !Number.isFinite(amount) || amount > maximum || (positive ? amount <= 0 : amount < 0)) {
          warn(`${label} “${value}” was left blank because it is not a supported ${positive ? 'positive ' : ''}number.`);
          return null;
        }
        return value;
      };

      const originalUnit = get('Package unit');
      const normalizedUnit = originalUnit.toLowerCase();
      const unitMap = {g: 'g', kg: 'kg', ml: 'ml', l: 'L', each: 'each', egg: 'each', eggs: 'each', can: 'each', cans: 'each'};
      const packageUnit = unitMap[normalizedUnit] || 'each';
      let packageSize = numberText(get('Package qty'), 'Package quantity', true, 100000);
      if (!unitMap[normalizedUnit]) {
        if (originalUnit || packageSize !== null) warn(`Package unit “${originalUnit || 'not supplied'}” is unsupported; package size was left blank.`);
        packageSize = null;
      }
      if (packageSize === null) warn('Package size is missing or needs checking. No weight was inferred.');
      if (/^(eggs?|cans?)$/.test(normalizedUnit)) {
        notes.push(`Original package unit: ${originalUnit}${get('Package qty') ? `; quantity: ${get('Package qty')}` : ''}. Stored as a count (each), not a weight.`);
      }

      const rawPrice = get('Price (AED)');
      const price = numberText(rawPrice, 'Reference price', true, 99999);
      if (price !== null) notes.push(`Undated reference price: AED ${price}. From the CSV; not added to weekly price history.`);
      else if (!rawPrice || missing.test(rawPrice)) notes.push('Reference price was not recorded in the CSV.');

      const sourceNote = get('Source / note');
      const estimated = /\b(?:estimat(?:e[ds]?|ion)|approximate(?:ly)?|about|corrected)\b/i.test(sourceNote);
      const uncertain = /\b(?:partly|obscured|blurry)\b/i.test(sourceNote);
      const confidence = get('Confidence');
      if (confidence) notes.push(`Source confidence: ${confidence} (as supplied; not independently verified).`);
      if (sourceNote) notes.push(`Source / note: ${sourceNote}`);
      for (const header of ['Primary nutrient roles', 'Buy priority', 'Best use / appliance']) {
        if (get(header)) notes.push(`${header} (from CSV): ${get(header)}`);
      }
      if (estimated) warnings.push('The CSV includes estimated or corrected nutrition values; check them against your photos.');
      else if (uncertain) warnings.push('The source says some label values are unclear; check them against your photos.');

      const basisQty = numberText(get('Nutrition basis qty'), 'Nutrition basis quantity', true, 100000);
      const basisUnit = get('Basis unit');
      const validBasis = basisQty !== null && /^(?:g|kg|ml|l|each|eggs?|cans?|servings?)$/i.test(basisUnit);
      let basis = validBasis ? `Per ${basisQty} ${basisUnit}` : 'Basis not supplied';
      if (!validBasis) warn(`Nutrition basis needs checking: ${[get('Nutrition basis qty'), basisUnit].filter(Boolean).join(' ') || 'not supplied'}. Values were not converted.`);
      basis += estimated ? '; CSV data includes estimates — unverified' : '; CSV transcription — unverified';
      const values = nutrients.flatMap(([header, label, unit]) => {
        const value = numberText(get(header), label);
        return value === null ? [] : [{label, value, unit}];
      });
      if (!values.length) warnings.push('No numeric nutrition values were supplied.');

      const item = {
        name,
        brand: explicitBrand(name, get('Brand')),
        category: get('Type'),
        package_size: packageSize === null ? null : Number(packageSize),
        package_unit: packageUnit,
        pack_count: 1,
        notes: notes.join('\n\n'),
        nutrition: {basis, serving_size: '', values},
      };
      for (const [key, limit] of [['name', 150], ['brand', 100], ['category', 80], ['notes', 5000]]) {
        if (item[key].length > limit) throw new Error(`CSV row ${rowNumber}: ${key} is too long (maximum ${limit} characters).`);
      }
      if (basis.length > 100) throw new Error(`CSV row ${rowNumber}: nutrition basis is too long.`);
      return {item, warnings};
    });
  }

  const api = {parse};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PantryCSV = api;
})(typeof window !== 'undefined' ? window : globalThis);
