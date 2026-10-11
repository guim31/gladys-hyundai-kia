import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_CONFIG,
  forceRefreshMs,
  isConfigured,
  isDaytime,
  normalizeConfig,
  refreshMs,
} from '../src/config.js';
import { createStore } from '../src/store.js';

test('defaults when nothing is configured', () => {
  assert.deepEqual(normalizeConfig(), DEFAULT_CONFIG);
  assert.deepEqual(normalizeConfig(null), DEFAULT_CONFIG);
  assert.equal(isConfigured(normalizeConfig()), false);
});

test('typed values are cleaned, unknown choices fall back', () => {
  const config = normalizeConfig({
    brand: 'genesis',
    username: '  driver@example.com ',
    password: ' pass word \n',
    pin: '12a4',
    account_language: 'xx',
    language: 'de',
    refresh_minutes: 7,
    force_refresh_hours: 4,
    climate_duration: '25',
  });
  assert.equal(config.brand, 'hyundai');
  assert.equal(config.username, 'driver@example.com');
  // Spaces inside or around a password are kept; a pasted newline is not.
  assert.equal(config.password, ' pass word ');
  assert.equal(config.pin, '');
  assert.equal(config.account_language, 'fr');
  assert.equal(config.language, 'en');
  assert.equal(config.refresh_minutes, '30');
  assert.equal(config.force_refresh_hours, '4');
  assert.equal(config.climate_duration, '10');
  assert.equal(normalizeConfig({ pin: ' 0042 ' }).pin, '0042');
  assert.equal(refreshMs(normalizeConfig({ refresh_minutes: '15' })), 15 * 60 * 1000);
  assert.equal(forceRefreshMs(normalizeConfig()), 0);
  assert.equal(forceRefreshMs(config), 4 * 60 * 60 * 1000);
});

test('forced refreshes only by day (6 am to 10 pm)', () => {
  assert.equal(isDaytime(new Date(2026, 9, 11, 5, 59)), false);
  assert.equal(isDaytime(new Date(2026, 9, 11, 6, 0)), true);
  assert.equal(isDaytime(new Date(2026, 9, 11, 21, 59)), true);
  assert.equal(isDaytime(new Date(2026, 9, 11, 22, 0)), false);
});

test('the store keeps the tokens private, survives a restart, ignores a corrupt file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gladys-hyundai-kia-'));
  try {
    const store = createStore({ dir });
    await store.load();
    store.tokenStore.set({ kind: 'cci', accessToken: 'Bearer x' });
    store.data.vehicles.VIN1 = { targetTempC: 22 };
    await store.flush();
    const file = join(dir, 'hyundai-kia.json');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    const again = createStore({ dir });
    await again.load();
    assert.equal(again.tokenStore.get().accessToken, 'Bearer x');
    assert.deepEqual(again.data.vehicles, { VIN1: { targetTempC: 22 } });
    await assert.rejects(readFile(`${file}.tmp`));
    await writeFile(file, '{not json');
    const corrupt = createStore({ dir });
    await corrupt.load();
    assert.equal(corrupt.tokenStore.get(), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
