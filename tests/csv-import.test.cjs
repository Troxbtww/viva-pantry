const test = require('node:test');
const assert = require('node:assert/strict');
const {parse} = require('../static/csv-import.js');

const columns = ['Food', 'Type', 'Price (AED)', 'Package qty', 'Package unit', 'Nutrition basis qty',
  'Basis unit', 'Calories / basis', 'Protein g / basis', 'Carbs g / basis', 'Fat g / basis',
  'Fibre g / basis', 'Sugar g / basis', 'Sodium mg / basis', 'Calcium mg / basis',
  'Vitamin D mcg / basis', 'Confidence', 'Source / note', 'Buy priority', 'Best use / appliance'];
const quote = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
const csv = (...records) => [columns, ...records.map(record => columns.map(column => record[column] ?? ''))]
  .map(row => row.map(quote).join(',')).join('\r\n');
const base = {'Food': 'Test food', 'Package qty': '500', 'Package unit': 'g',
  'Nutrition basis qty': '100', 'Basis unit': 'g', 'Calories / basis': '89',
  'Confidence': 'High', 'Source / note': 'Label transcription'};

test('quoted commas, newlines, escaped quotes and BOM retain their field boundaries', () => {
  const [{item}] = parse('\uFEFF' + csv({...base, Food: 'Test food, plain',
    'Source / note': 'Line one\nContains "quoted" text'}), 'sample.csv');
  assert.equal(item.name, 'Test food, plain');
  assert.match(item.notes, /Line one\nContains "quoted" text/);
  assert.match(item.notes, /^Imported from sample\.csv; awaiting your review\./);
});

test('nutrients preserve supplied precision and zeros while blanks stay absent', () => {
  const [{item}] = parse(csv({...base, 'Calories / basis': '100.57', 'Protein g / basis': '0',
    'Fat g / basis': '', 'Sodium mg / basis': '1230.5', 'Vitamin D mcg / basis': '0.000'}));
  assert.deepEqual(item.nutrition.values, [
    {label: 'Energy', value: '100.57', unit: 'kcal'}, {label: 'Protein', value: '0', unit: 'g'},
    {label: 'Sodium', value: '1230.5', unit: 'mg'}, {label: 'Vitamin D', value: '0.000', unit: 'mcg'},
  ]);
  assert.match(item.nutrition.basis, /^Per 100 g; .*unverified$/);
});

test('per-serving-sized quantities are retained without nutrition conversions', () => {
  for (const [qty, unit] of [['50', 'g'], ['15', 'ml'], ['330', 'ml'], ['1', 'egg'], ['1', 'can']]) {
    const [{item}] = parse(csv({...base, 'Nutrition basis qty': qty, 'Basis unit': unit}));
    assert.match(item.nutrition.basis, new RegExp(`^Per ${qty} ${unit}; `));
    assert.equal(item.nutrition.values[0].value, '89');
  }
});

test('counted packages do not become weights and unknown pack quantities stay missing', () => {
  const records = parse(csv({...base, 'Package qty': '60', 'Package unit': 'egg'},
    {...base, 'Package qty': '1', 'Package unit': 'can'}, {...base, 'Package qty': ''}));
  assert.deepEqual(records.map(({item}) => [item.package_size, item.package_unit, item.pack_count]),
    [[60, 'each', 1], [1, 'each', 1], [null, 'g', 1]]);
  assert.match(records[0].item.notes, /Original package unit: egg; quantity: 60/);
  assert.match(records[1].item.notes, /not a weight/);
  assert.match(records[2].warnings.join(' '), /Package size is missing/);
});

test('undated promotional prices stay references with conditions, never price observations', () => {
  const [{item}] = parse(csv({...base, 'Price (AED)': '12.50',
    'Source / note': 'Promotional price assumes 2 for AED 25', 'Buy priority': 'Useful',
    'Best use / appliance': 'Stove / oven'}), 'D:/private/catalog.csv');
  assert.match(item.notes, /^Imported from catalog\.csv;/);
  assert.match(item.notes, /Undated reference price: AED 12\.50/);
  assert.match(item.notes, /2 for AED 25/);
  assert.match(item.notes, /Source confidence: High .*not independently verified/);
  assert.match(item.notes, /Buy priority \(from CSV\): Useful/);
  assert.match(item.notes, /Best use \/ appliance \(from CSV\): Stove \/ oven/);
  for (const key of ['price', 'prices', 'amount', 'observed_on', 'valid_to']) assert.equal(key in item, false);
});

test('estimates and corrected values are visible alongside nutrition', () => {
  for (const note of ['Approximate standard food values', 'Sodium is an estimate',
    'Sodium estimated from salt', 'Energy corrected to about 127 kcal']) {
    const [{item, warnings}] = parse(csv({...base, 'Source / note': note}));
    assert.match(item.nutrition.basis, /includes estimates — unverified/);
    assert.ok(warnings.length);
    assert.ok(item.notes.includes(note));
  }
});

test('ranges, negative numbers and text are not silently converted to numeric facts', () => {
  const [{item, warnings}] = parse(csv({...base, 'Calories / basis': '120-140',
    'Protein g / basis': 'about 8', 'Sodium mg / basis': '-5', 'Package qty': '2 x 250',
    'Vitamin D mcg / basis': 'NaN', 'Calcium mg / basis': 'Infinity', 'Fat g / basis': 'N/A'}));
  assert.deepEqual(item.nutrition.values, []);
  assert.equal(item.package_size, null);
  assert.match(item.notes, /120-140/);
  assert.match(item.notes, /about 8/);
  assert.ok(warnings.length >= 6);
});

test('unknown units are flagged and never paired with a guessed weight', () => {
  const [{item, warnings}] = parse(csv({...base, 'Package unit': 'oz', 'Basis unit': 'scoop'}));
  assert.equal(item.package_size, null);
  assert.equal(item.package_unit, 'each');
  assert.match(item.nutrition.basis, /^Basis not supplied;/);
  assert.match(warnings.join(' '), /Package unit “oz” is unsupported/);
  assert.match(item.notes, /100 scoop/);
});

test('brands are copied only when explicit, with the original product name retained', () => {
  const [{item}] = parse('Food,Brand,Calories / basis\nTest yogurt,Test Brand,80');
  assert.equal(item.brand, 'Test Brand');
  assert.equal(item.name, 'Test yogurt');
  assert.equal(parse(csv({...base, Food: 'Greek-style yogurt'}))[0].item.brand, '');
});

test('damaged CSV is rejected instead of shifting nutrition values to other columns', () => {
  for (const content of ['Food,Calories / basis\nTest,100,9', 'Food,Calories / basis\n"Test,100',
    'Food,Calories / basis\n"Test"junk,100', 'Food,Food,Calories / basis\nA,B,100',
    'Food,Calories / basis\n,100', 'Name,Other\nTest,100']) {
    assert.throws(() => parse(content), /CSV|column|food name/);
  }
});
