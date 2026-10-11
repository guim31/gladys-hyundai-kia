// Every text shown to the user exists in the four languages of the Gladys
// interface: English, French, German and Spanish. German says "du", Spanish
// says "usted" (decision of the maintainer, same register on every
// integration).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { STATUS_MESSAGES } from '../src/hyundaiKia.js';
import { TEXTS } from '../src/i18n.js';
import { COMMAND_ISSUES, VEHICLE_ACTIONS, pickDevice, vehicleContent } from '../src/widgets.js';
import { LANGUAGES } from '../src/config.js';

const manifest = JSON.parse(
  readFileSync(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const LANGS = ['de', 'en', 'es', 'fr'];
// Polite German forms, capitalized: never used, German says "du".
const POLITE_GERMAN = /(?<!\p{L})(Sie|Ihr|Ihre|Ihren|Ihrem|Ihrer|Ihres)(?!\p{L})/u;

const isMultiLanguage = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  ['en', 'fr', 'de', 'es'].some((lang) => typeof value[lang] === 'string');

/** Every multi-language object under `node`, with its path. */
function collect(node, path = '', out = []) {
  if (isMultiLanguage(node)) out.push([path, node]);
  else if (Array.isArray(node)) node.forEach((item, i) => collect(item, `${path}[${i}]`, out));
  else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) collect(value, `${path}.${key}`, out);
  }
  return out;
}

/** Checks one multi-language text; `max` caps every language. */
function checkText(path, text, max = 500) {
  assert.deepEqual(Object.keys(text).sort(), LANGS, `${path}: languages`);
  for (const lang of LANGS) {
    const value = text[lang];
    assert.equal(typeof value, 'string', `${path}.${lang}: a string`);
    assert.ok(value.trim().length > 0, `${path}.${lang}: empty`);
    assert.ok(value.length <= max, `${path}.${lang}: ${value.length} characters (${max} max)`);
  }
  assert.doesNotMatch(text.de, POLITE_GERMAN, `${path}.de: German says "du", not "Sie"`);
}

function checkAll(label, node, max) {
  const texts = collect(node);
  assert.ok(texts.length > 0, `${label}: no text found`);
  for (const [path, text] of texts) checkText(`${label}${path}`, text, max);
  return texts.length;
}

test('every manifest text exists in English, French, German and Spanish', () => {
  const count = checkAll('manifest', manifest);
  assert.ok(count >= 70, `only ${count} manifest texts found`);
  checkText('manifest.description', manifest.description, 100);
  for (const option of manifest.config_schema.find((f) => f.key === 'language').options) {
    assert.ok(LANGUAGES.includes(option.value), `language option ${option.value}`);
  }
});

test('the message tables of the code exist in the four languages', () => {
  // A widget or action toast is cut at 200 characters by the core.
  checkAll('STATUS_MESSAGES', STATUS_MESSAGES, 200);
  checkAll('pickDevice', { pickDevice }, 200);
  checkAll('VEHICLE_ACTIONS', VEHICLE_ACTIONS, 200);
  // A status row holds 40 characters at most.
  checkAll('COMMAND_ISSUES', COMMAND_ISSUES, 40);
  // Feature names: one per language of the `language` setting.
  checkAll('TEXTS', TEXTS, 60);
  assert.deepEqual([...LANGUAGES].sort(), LANGS);
});

test('the widget content exists in the four languages, buttons and rows kept short', () => {
  const base = {
    device: { external_id: 'ext:hyundai-kia:vehicle:VIN' },
    created: null,
    info: { type: 'EV' },
    commandIssue: null,
  };
  const snapshots = [
    { charging: true, chargeRemainingMin: 95, climateOn: true, locked: true, doorOpen: true },
    { charging: true, plugged: true, climateOn: false, targetTempC: 21.5, locked: false },
    { charging: false, plugged: true, windowOpen: true, locked: true, updatedAt: Date.now() },
    { charging: false, plugged: false, climateOn: false, targetTempC: 20, locked: false },
  ];
  const views = [
    ...snapshots.map((snapshot) => ({ ...base, snapshot })),
    { ...base, snapshot: snapshots[0], commandIssue: 'pin' },
    { ...base, snapshot: snapshots[1], commandIssue: 'pinMissing' },
    { ...base, info: { type: 'GN' }, snapshot: { totalRangeKm: 500, odometerKm: 12000 } },
  ];
  for (const [i, view] of views.entries()) {
    const content = vehicleContent(view, { timeZone: 'Europe/Paris' });
    assert.deepEqual(validateWidgetContent(content), [], `widget[${i}]: core rules`);
    checkAll(`widget[${i}]`, content);
    for (const component of content.components) {
      if (component.type === 'button') checkText(`widget[${i}] button`, component.label, 18);
      if (component.type === 'value') checkText(`widget[${i}] tile`, component.label, 20);
      for (const item of component.items ?? []) {
        checkText(`widget[${i}] row label`, item.label, 30);
        if (isMultiLanguage(item.value)) checkText(`widget[${i}] row value`, item.value, 40);
      }
    }
  }
});

test('no inline text of the code skips German or Spanish', () => {
  // Texts built in place (connection test result, widget rows) are object
  // literals: each `fr:` key has its `de:` and `es:` siblings.
  const files = ['../index.js', '../src/hyundaiKia.js', '../src/widgets.js', '../src/i18n.js'];
  for (const file of files) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    const count = (key) => (source.match(new RegExp(`(?<![\\w.])${key}:\\s`, 'g')) ?? []).length;
    assert.equal(count('de'), count('fr'), `${file}: German texts`);
    assert.equal(count('es'), count('fr'), `${file}: Spanish texts`);
    assert.doesNotMatch(
      source,
      /language\s*===\s*['"]fr['"]/,
      `${file}: a text chosen by language`,
    );
  }
});

test('the guard catches a missing language, an empty text and a polite German form', () => {
  const ok = { en: 'Lock', fr: 'Verrouiller', de: 'Verriegeln', es: 'Bloquear' };
  checkText('ok', ok);
  const { es: _es, ...noSpanish } = ok;
  assert.throws(() => checkAll('missing', { label: noSpanish }), /languages/);
  assert.throws(() => checkText('empty', { ...ok, de: ' ' }), /empty/);
  assert.throws(() => checkText('long', ok, 5), /characters/);
  assert.throws(() => checkText('polite', { ...ok, de: 'Prüfen Sie die PIN' }), /du/);
  assert.throws(() => checkText('polite', { ...ok, de: 'Ihre PIN' }), /du/);
  checkText('casual', { ...ok, de: 'Prüfe deine PIN, sie ist falsch' });
});
