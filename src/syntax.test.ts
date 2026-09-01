// Every module must survive type stripping. The test suite imports the small
// modules, but nothing imports server.ts (importing it would bind a port), so
// a syntax error there used to reach production and crash-loop the container.
// This closes that gap cheaply.
//
// It runs the real transform rather than `node --check`, because the two do
// not agree: --check only parses, so it happily accepts TypeScript that the
// strip-only runtime then refuses at import time. A constructor parameter
// property (`constructor(readonly x: number)`) is the case that got through.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import test from 'node:test';

const SRC = import.meta.dirname;

test('every source module survives type stripping', () => {
  const modules = readdirSync(SRC).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));
  assert.ok(modules.includes('server.ts'), 'server.ts must be covered');
  for (const name of modules) {
    const source = readFileSync(path.join(SRC, name), 'utf8');
    assert.doesNotThrow(
      () => stripTypeScriptTypes(source, { mode: 'strip' }),
      `${name} does not survive type stripping`,
    );
  }
});

test('no source module smuggles in a NUL byte', () => {
  // SQLite's C API truncates a bound string at the first NUL, so a stray one
  // in a template literal silently corrupts every key written through it.
  const modules = readdirSync(SRC).filter((name) => name.endsWith('.ts'));
  for (const name of modules) {
    assert.ok(!readFileSync(path.join(SRC, name)).includes(0), `${name} contains a NUL byte`);
  }
});
