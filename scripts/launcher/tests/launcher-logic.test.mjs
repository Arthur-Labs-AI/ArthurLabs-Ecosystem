import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWslListOutput,
  filterUsableDistros,
  selectDistro,
  parseNodeMajor,
  nodeSatisfies,
  parseSemver,
  runtimeDirName,
  versionContains,
  classifyClaudeVersion,
  SENTRY_PRODUCT_VERSION,
} from '../launcher-logic.mjs';

describe('parseWslListOutput', () => {
  it('parses a typical list with default marker and NULs', () => {
    const raw =
      '  NAME                   STATE           VERSION\r\n* Ubuntu                 Stopped         2\r\n  docker-desktop         Stopped         2\r\n';
    const parsed = parseWslListOutput(raw.replace(/./g, (c) => c + '\0'));
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].name, 'Ubuntu');
    assert.equal(parsed[0].version, 2);
    assert.equal(parsed[1].name, 'docker-desktop');
  });
  it('parses names containing spaces', () => {
    const parsed = parseWslListOutput(
      'NAME STATE VERSION\nUbuntu-24.04 Running 2\nDebian Stopped 1\n',
    );
    assert.deepEqual(parsed, [
      { name: 'Ubuntu-24.04', state: 'Running', version: 2 },
      { name: 'Debian', state: 'Stopped', version: 1 },
    ]);
  });
  it('returns [] on garbage or non-strings', () => {
    assert.deepEqual(parseWslListOutput('hello\nworld\n'), []);
    assert.deepEqual(parseWslListOutput(null), []);
    assert.deepEqual(parseWslListOutput(''), []);
  });
  it('returns [] when only docker-desktop exists', () => {
    const parsed = parseWslListOutput(
      'NAME STATE VERSION\ndocker-desktop Stopped 2\ndocker-desktop-data Stopped 2\n',
    );
    assert.equal(filterUsableDistros(parsed).length, 0);
  });
});

describe('filterUsableDistros', () => {
  it('keeps WSL2 only and skips docker utility distros', () => {
    const inList = [
      { name: 'Ubuntu', state: 'Stopped', version: 2 },
      { name: 'Debian', state: 'Stopped', version: 1 },
      { name: 'docker-desktop', state: 'Stopped', version: 2 },
      { name: 'docker-desktop-data', state: 'Stopped', version: 2 },
    ];
    assert.deepEqual(
      filterUsableDistros(inList).map((d) => d.name),
      ['Ubuntu'],
    );
  });
});

describe('selectDistro', () => {
  const distros = [
    { name: 'Debian', state: 'Running', version: 2 },
    { name: 'Ubuntu', state: 'Stopped', version: 2 },
    { name: 'Ubuntu-24.04', state: 'Stopped', version: 2 },
  ];
  it('prefers the previous Sentry choice when usable', () => {
    assert.equal(selectDistro({ distros, previous: 'Ubuntu-24.04' }), 'Ubuntu-24.04');
  });
  it('prefers Ubuntu by default', () => {
    assert.equal(selectDistro({ distros }), 'Ubuntu');
  });
  it('honours an explicit flag case-insensitively', () => {
    assert.equal(selectDistro({ distros, explicit: 'debian' }), 'Debian');
  });
  it('rejects an explicit flag that is not usable', () => {
    assert.equal(selectDistro({ distros, explicit: 'Arch' }), null);
  });
  it('falls back to a running distro when Ubuntu is not ready', () => {
    const ready = new Set(['Debian']);
    assert.equal(selectDistro({ distros, readySet: ready }), 'Debian');
  });
  it('returns null when nothing is usable', () => {
    assert.equal(selectDistro({ distros: [] }), null);
    assert.equal(
      selectDistro({ distros: [{ name: 'docker-desktop', state: 'Stopped', version: 2 }] }),
      null,
    );
  });
  it('handles repo paths with spaces (selection is name-based, not path-based)', () => {
    assert.equal(selectDistro({ distros, previous: 'D:\\Source Code\\Sentry' }), 'Ubuntu');
  });
});

describe('node versions', () => {
  it('parses v-prefixed and bare versions', () => {
    assert.equal(parseNodeMajor('v22.14.0'), 22);
    assert.equal(parseNodeMajor('20.1.0'), 20);
    assert.equal(parseNodeMajor('garbage'), null);
  });
  it('accepts >= 22 and rejects older', () => {
    assert.equal(nodeSatisfies('v22.0.0'), true);
    assert.equal(nodeSatisfies('v24.13.1'), true);
    assert.equal(nodeSatisfies('v20.19.0'), false);
    assert.equal(nodeSatisfies(''), false);
  });
  it('parses pinned pnpm semver', () => {
    assert.deepEqual(parseSemver('9.12.3'), [9, 12, 3]);
    assert.equal(parseSemver('nope'), null);
  });
});

describe('runtime naming and tool versions', () => {
  it('builds version+sha directory names', () => {
    assert.equal(runtimeDirName('0.1.0-beta.1', 'e9e0b80'), '0.1.0-beta.1-e9e0b80');
    assert.equal(
      runtimeDirName(SENTRY_PRODUCT_VERSION, 'abc1234'),
      SENTRY_PRODUCT_VERSION + '-abc1234',
    );
    assert.equal(runtimeDirName('0.1.0-beta.1', ''), '0.1.0-beta.1-unknown');
  });
  it('matches exact tool versions only', () => {
    assert.equal(versionContains('opencode version 1.18.32', '1.18.32'), true);
    assert.equal(versionContains('1.18.3', '1.18.32'), false);
  });
  it('classifies claude versions incl. known-incompatible', () => {
    assert.equal(classifyClaudeVersion('2.1.270'), 'ready');
    assert.equal(classifyClaudeVersion('2.1.276'), 'incompatible');
    assert.equal(classifyClaudeVersion('2.1.300'), 'unverified');
  });
});
