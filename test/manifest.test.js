// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// The manifest is validated by the store indexer, but nothing there can know
// which handlers the code actually registers — these tests keep both in sync.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createSceneActions } from '../src/scenes.js';
import { createWidgets } from '../src/widgets.js';
import { DEFAULT_CONFIG } from '../src/config.js';

// The handlers are built around the runtime; their keys do not depend on it.
const SCENE_ACTIONS = createSceneActions({});
const WIDGETS = createWidgets({});
// Manifest actions registered in index.js.
const HANDLED_ACTIONS = ['test_connection'];

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

// Every list of form fields the manifest can declare (same field grammar).
const allFields = [
  ...(manifest.config_schema ?? []),
  ...(manifest.contact_schema ?? []),
  ...[
    ...(manifest.actions ?? []),
    ...(manifest.scene_triggers ?? []),
    ...(manifest.scene_actions ?? []),
  ].flatMap((item) => item.fields ?? []),
  ...(manifest.widgets ?? []).flatMap((widget) => widget.settings ?? []),
];

// Manifest fields older Gladys releases reject as unknown, with the first
// release accepting them. The store validator refuses a manifest whose
// `gladys_version` minimum is lower: these tests catch it before a release.
const CAPABILITY_FIELDS = ['scene_triggers', 'scene_actions', 'widgets'];
const CAPABILITY_MIN_GLADYS_VERSION = [5, 1, 0];
const CATEGORIES_MIN_GLADYS_VERSION = [4, 86, 0];

const keysOf = (list) => (list ?? []).map((entry) => entry.key);

// Minimum version of the manifest `gladys_version` range, e.g. [5, 1, 0].
function minGladysVersion() {
  const match = manifest.gladys_version.match(/>=\s*(\d+)\.(\d+)\.(\d+)/);
  assert.ok(match, 'gladys_version must declare a minimum version');
  return match.slice(1).map(Number);
}

function isAtLeast(version, required) {
  for (let i = 0; i < required.length; i += 1) {
    if (version[i] !== required[i]) {
      return version[i] > required[i];
    }
  }
  return true;
}

test('every manifest action has a registered handler', () => {
  const declared = keysOf(manifest.actions);
  assert.deepEqual([...declared].sort(), [...HANDLED_ACTIONS].sort());
  const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  for (const key of HANDLED_ACTIONS) {
    assert.ok(index.includes(`onAction('${key}'`), `index.js registers no handler for "${key}"`);
  }
});

test('declaring catalog categories requires Gladys >= 4.86.0', () => {
  // The store vocabulary itself is checked by the store validator (unknown
  // keys are dropped with a warning there) — what this test pins is the
  // coupling rule: older cores reject any unknown manifest field, so a
  // manifest declaring `categories` must not claim compatibility below the
  // first release that accepts it.
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  assert.ok(
    isAtLeast(minGladysVersion(), CATEGORIES_MIN_GLADYS_VERSION),
    `categories requires gladys_version >= 4.86.0, got "${manifest.gladys_version}"`,
  );
});

test('declaring scene triggers, scene actions or widgets requires Gladys >= 5.1.0', () => {
  const declared = CAPABILITY_FIELDS.filter((field) => manifest[field] !== undefined);
  assert.ok(declared.length > 0, 'the integration declares capability fields');
  assert.ok(
    isAtLeast(minGladysVersion(), CAPABILITY_MIN_GLADYS_VERSION),
    `${declared.join(', ')} requires gladys_version >= 5.1.0, got "${manifest.gladys_version}"`,
  );
});

test('every scene_actions key has an onSceneAction handler, and vice versa', () => {
  const declared = keysOf(manifest.scene_actions);
  for (const key of declared) {
    assert.equal(typeof SCENE_ACTIONS[key], 'function', `scene action "${key}" has no handler`);
  }
  for (const key of Object.keys(SCENE_ACTIONS)) {
    assert.ok(declared.includes(key), `handler "${key}" is not declared in scene_actions`);
  }
});

test('every widgets key has an onWidgetGet handler, and vice versa', () => {
  const declared = keysOf(manifest.widgets);
  for (const key of declared) {
    assert.equal(typeof WIDGETS[key]?.get, 'function', `widget "${key}" has no content handler`);
  }
  for (const key of Object.keys(WIDGETS)) {
    assert.ok(declared.includes(key), `widget "${key}" is not declared in widgets`);
  }
});

test('config_schema defaults stay consistent with DEFAULT_CONFIG', () => {
  for (const field of manifest.config_schema) {
    if (field.default !== undefined) {
      assert.equal(
        DEFAULT_CONFIG[field.key],
        field.default,
        `DEFAULT_CONFIG.${field.key} must match the manifest default`,
      );
    }
  }
});

test('section fields are purely presentational', () => {
  const sections = manifest.config_schema.filter((f) => f.type === 'section');
  assert.ok(sections.length > 0, 'the configuration opens with a section block');
  for (const section of sections) {
    // A section stores NO value: declaring `required`, `default` or
    // `placeholder` on it rejects the manifest, and its key must never leak
    // into the config the code manipulates.
    assert.equal(section.required, undefined, `section "${section.key}" must not be required`);
    assert.equal(section.default, undefined, `section "${section.key}" must not have a default`);
    assert.equal(
      section.placeholder,
      undefined,
      `section "${section.key}" must not have a placeholder`,
    );
    assert.ok(section.label?.en, `section "${section.key}" needs an English label`);
    assert.ok(
      !(section.key in DEFAULT_CONFIG),
      `section "${section.key}" stores no value and must not appear in DEFAULT_CONFIG`,
    );
    for (const link of section.links ?? []) {
      assert.match(link.url, /^https:\/\//, 'section links must be https');
    }
  }
});

test('dynamic selects declare a source and no static options', () => {
  const dynamicSelects = allFields.filter((f) => f.source !== undefined);
  assert.ok(dynamicSelects.length > 0, 'devices are picked with a dynamic select');
  for (const field of dynamicSelects) {
    assert.equal(field.source, 'devices', 'the only core-defined source in V1 is "devices"');
    assert.equal(
      field.options,
      undefined,
      `field "${field.key}": declaring source and options together rejects the manifest`,
    );
  }
});

test('the manifest version is the package version, and the image is tagged with it', () => {
  // The Release workflow writes all three: a mismatch means one was edited by
  // hand, and Gladys would offer a version whose image is another one.
  assert.equal(manifest.version, pkg.version, 'manifest version must match package.json');
  assert.ok(
    manifest.docker_image.endsWith(`:${manifest.version}`),
    `docker_image must be tagged :${manifest.version}, got "${manifest.docker_image}"`,
  );
});

test('the catalog description holds 10 to 100 characters per language', () => {
  // A store rule (the catalog card is short): a longer text rejects the
  // manifest.
  assert.ok(manifest.description.en, 'the description needs an English text');
  for (const [lang, text] of Object.entries(manifest.description)) {
    assert.ok(
      text.length >= 10 && text.length <= 100,
      `description.${lang} has ${text.length} characters (10 to 100 allowed)`,
    );
  }
});

test('field placeholders are multi-language objects', () => {
  // Like `label` and `description`: a plain string rejects the manifest.
  const withPlaceholder = allFields.filter((f) => f.placeholder !== undefined);
  for (const field of withPlaceholder) {
    assert.equal(typeof field.placeholder, 'object', `field "${field.key}": placeholder`);
    assert.ok(field.placeholder.en, `field "${field.key}": placeholder needs an English text`);
  }
});

test('the manifest identifies the Hyundai / Kia integration', () => {
  assert.equal(manifest.name, 'Hyundai / Kia');
  // `docker_image` is set by the Release workflow from the repository name.
  assert.deepEqual(manifest.transports, ['cloud']);
  for (const text of Object.values(manifest.description)) {
    assert.match(text, /Hyundai/);
    assert.match(text, /Kia/);
  }
});

test('every text of the manifest is bilingual', () => {
  // label, description and placeholder, everywhere: a plain string rejects
  // the manifest, and a missing French text shows English to French users.
  const walk = (node, path) => {
    if (Array.isArray(node)) return node.forEach((item, i) => walk(item, `${path}[${i}]`));
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (['label', 'description', 'placeholder'].includes(key)) {
        assert.equal(typeof value, 'object', `${path}.${key} must be a { en, fr } object`);
        assert.ok(value.en && value.fr, `${path}.${key} needs en and fr`);
      } else {
        walk(value, `${path}.${key}`);
      }
    }
  };
  walk(manifest, 'manifest');
});

test('number fields declare integer bounds and defaults', () => {
  // Gladys renders number inputs without `step`: the browser then only
  // accepts min + k.
  for (const field of allFields.filter((f) => f.type === 'number')) {
    for (const key of ['min', 'max', 'default']) {
      if (field[key] !== undefined) assert.ok(Number.isInteger(field[key]), `${field.key}.${key}`);
    }
  }
});

test('no secret field in an action form', () => {
  for (const action of manifest.actions ?? []) {
    for (const field of action.fields ?? []) {
      assert.notEqual(
        field.type,
        'secret',
        `action ${action.key}: a secret field cannot be filled`,
      );
    }
  }
});

test('widget, trigger and action keys are stable English snake_case', () => {
  const keys = [
    ...keysOf(manifest.widgets),
    ...keysOf(manifest.scene_actions),
    ...keysOf(manifest.actions),
  ];
  for (const key of keys) assert.match(key, /^[a-z][a-z0-9_]{1,31}$/);
  assert.equal(manifest.scene_triggers, undefined);
  assert.deepEqual(keysOf(manifest.widgets), ['vehicle']);
  assert.deepEqual(keysOf(manifest.scene_actions), ['refresh_vehicle', 'start_climate']);
});

test('the widget and scene actions wait no longer than the core allows', () => {
  // The core accepts 5 to 120 s; the runtime gives up waiting for the car
  // after 90 s (src/hyundaiKia.js), a forced refresh of a CCS2 car takes 25 s
  // plus the reads.
  for (const action of manifest.scene_actions) {
    assert.ok(action.timeout_seconds >= 60 && action.timeout_seconds <= 120, action.key);
  }
  for (const widget of manifest.widgets) {
    assert.ok(widget.action_timeout_seconds >= 90 && widget.action_timeout_seconds <= 120);
  }
});

test('scene action fields are optional but the vehicle (no default is ever applied)', () => {
  for (const action of manifest.scene_actions) {
    for (const field of action.fields) {
      assert.equal(field.required === true, field.key === 'device', `${action.key}.${field.key}`);
      assert.equal(field.default, undefined, `${action.key}.${field.key}`);
    }
  }
});
