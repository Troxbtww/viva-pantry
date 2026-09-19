const test = require('node:test');
const assert = require('node:assert/strict');
const { _test: parser } = require('../static/extractor.js');
const {textLine, parsePriceCandidates, parseNutrition, suggestItem} = parser;

test('explicit AED prices accept decimals, Arabic digits, and thousands', () => {
  for (const [text, value] of [['Milk AED 4.95', 4.95], ['Milk 4,95 Dhs', 4.95],
    ['Rice AED 12', 12], ['Rice ١٢٫٥٠ درهم', 12.5], ['Rice AED 1,234.50', 1234.5]]) {
    assert.deepEqual(parsePriceCandidates(text).map(row => row.price), [value], text);
  }
});

test('nutrients, sizes, unmarked decimals, negative and partial prices are excluded', () => {
  for (const text of ['Protein 4.95 g', 'Energy 100 kcal', 'Milk 500 ml', '4.95', '19/09/2026',
    'Milk AED 0', 'Milk AED -5', 'Milk -5 AED', 'Milk AED 4.999', 'Milk 4.999 AED', 'Milk −5 AED']) {
    assert.deepEqual(parsePriceCandidates(text), [], text);
  }
});

test('previous and current prices both retain source context', () => {
  const rows = parsePriceCandidates('Greek yoghurt 500 g\nWas AED 9.95 now AED 7.95', [], 3);
  assert.deepEqual(rows.map(row => row.price), [9.95, 7.95]);
  assert.equal(rows[0].page, 3);
  assert.match(rows[0].raw_text, /Greek yoghurt/);
});

test('separate currency box and price retain product name', () => {
  const lines = [textLine('Milk 1 L', 20, 20, 100, 35), textLine('AED', 20, 50, 45, 65),
    textLine('4.95', 50, 50, 95, 65)];
  const rows = parsePriceCandidates('', [], 1, lines);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].price, 4.95);
  assert.equal(rows[0].label, 'Milk 1 L');
});

test('neighboring flyer columns do not cross-match products', () => {
  const lines = [textLine('Plain yoghurt 500 g', 10, 10, 135, 25),
    textLine('Chocolate milk 1 L', 230, 10, 360, 25), textLine('AED 4.95', 10, 50, 70, 65),
    textLine('AED 6.95', 230, 50, 300, 65)];
  const items = [{id: 'yoghurt-uuid', name: 'Plain yoghurt', package_size: 500, package_unit: 'g'},
    {id: 'milk-uuid', name: 'Chocolate milk', package_size: 1, package_unit: 'L'}];
  assert.deepEqual(parsePriceCandidates('', items, 1, lines).map(row => row.item_id), ['yoghurt-uuid', 'milk-uuid']);
});

test('package sizes, equivalent units and duplicate names remain conservative', () => {
  const items = [{id: 'one', name: 'Milk', package_size: 1, package_unit: 'L'},
    {id: 'two', name: 'Milk', package_size: 2, package_unit: 'L'}];
  assert.equal(suggestItem('Milk AED 4.95', items), null);
  assert.equal(suggestItem('Milk 1000 ml AED 4.95', items), 'one');
  assert.equal(suggestItem('Milk 500 ml AED 4.95', items), null);
});

test('known multipack and brand mismatches do not propose an item', () => {
  const items = [{id: 'one', name: 'Milk', brand: 'Acme', package_size: 200, package_unit: 'ml', pack_count: 6}];
  assert.equal(suggestItem('Acme Milk 4 x 200 ml AED 4.95', items), null);
  assert.equal(suggestItem('Other Milk 6 x 200 ml AED 4.95', items), null);
  assert.equal(suggestItem('Acme Milk 6 x 200 ml AED 4.95', items), 'one');
});

test('nutrition preserves zero and inequality, missing nutrients remain absent', () => {
  const {nutrition, warnings} = parseNutrition('Nutrition per 100 g\nEnergy 250 kJ / 60 kcal\nProtein 4.2 g\nFat 0 g\nSalt\nSugars <0.5 g');
  assert.equal(nutrition.basis, 'per 100 g');
  assert.deepEqual(nutrition.values.find(row => row.label === 'Fat'), {label: 'Fat', value: '0', unit: 'g'});
  assert.equal(nutrition.values.find(row => row.label === 'Sugars').value, '<0.5');
  assert.equal(nutrition.values.some(row => row.label === 'Salt'), false);
  assert.equal(nutrition.values.filter(row => row.label === 'Energy').length, 2);
  assert.deepEqual(warnings, []);
});

test('salt, sodium, saturated fat, and total fat remain distinct', () => {
  const {nutrition} = parseNutrition('Per serving\nServing size: 30 g\nSodium 25 mg\nSalt 0.1 g\nSaturated fat 1 g\nFat 3 g');
  assert.equal(nutrition.serving_size, '30 g');
  assert.deepEqual(nutrition.values.map(row => row.label), ['Sodium', 'Salt', 'Saturated fat', 'Fat']);
});

test('mixed bases or multiple numeric columns suppress nutrition suggestions', () => {
  for (const text of ['Per 100 g | Per serving\nProtein 10 g 3 g\nFat 2 g 0.6 g',
    'Per 100 g\nProtein (g) 10 3\nFat (g) 2 0.6', 'Per 100 g\nProtein 5 g\nProtein 9 g']) {
    const {nutrition, warnings} = parseNutrition(text);
    assert.deepEqual(nutrition.values, []);
    assert.ok(warnings.length);
  }
});

test('daily value percentage is not an additional nutrient column', () => {
  const {nutrition, warnings} = parseNutrition('Per serving\nProtein 4 g 8%\nSodium 20 mg 1%');
  assert.equal(nutrition.values.length, 2);
  assert.deepEqual(warnings, []);
});

test('unknown basis remains blank and warns', () => {
  const {nutrition, warnings} = parseNutrition('Protein 4.2 g');
  assert.equal(nutrition.basis, '');
  assert.ok(warnings.length);
});

test('OCR missing spaces are accepted without guessing letters as numbers', () => {
  const {nutrition} = parseNutrition('Per 100 g\nSalt0.12g\nProtein4.2g\nFatOg');
  assert.deepEqual(nutrition.values, [{label: 'Salt', value: '0.12', unit: 'g'}, {label: 'Protein', value: '4.2', unit: 'g'}]);
});

test('OCR label/value boxes on the same row are combined', () => {
  const lines = [textLine('Per 100 g', 10, 10, 100, 25), textLine('Protein', 10, 40, 70, 55),
    textLine('4.2 g', 130, 41, 160, 55), textLine('Fat', 10, 70, 40, 85), textLine('0 g', 130, 70, 155, 85)];
  const {nutrition} = parseNutrition(parser.nutritionText(lines));
  assert.deepEqual(nutrition.values, [{label: 'Protein', value: '4.2', unit: 'g'}, {label: 'Fat', value: '0', unit: 'g'}]);
});

test('PDF fragments join locally without merging separate columns', () => {
  const lines = [textLine('AED', 10, 20, 32, 30), textLine('4.95', 36, 20, 60, 30),
    textLine('AED 8.95', 250, 20, 310, 30)];
  assert.deepEqual(parser.joinFragments(lines).map(row => row.text), ['AED 4.95', 'AED 8.95']);
});

test('file signatures identify only supported actual formats', () => {
  const bytes = text => Uint8Array.from(Buffer.from(text, 'binary'));
  assert.equal(parser.mimeFromBytes(bytes('%PDF-1.7\n')), 'application/pdf');
  assert.equal(parser.mimeFromBytes(Uint8Array.from([137,80,78,71,13,10,26,10])), 'image/png');
  assert.equal(parser.mimeFromBytes(Uint8Array.from([255,216,255,224])), 'image/jpeg');
  assert.equal(parser.mimeFromBytes(bytes('RIFFxxxxWEBP')), 'image/webp');
  assert.equal(parser.mimeFromBytes(bytes('<html>fake.pdf')), null);
});
