// Every module must parse. The test suite imports the small modules, but
// nothing imports server.ts (importing it would bind a port), so a syntax
// error there used to reach production and crash-loop the container. This
// closes that gap cheaply.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const SRC = import.meta.dirname;

test('every source module parses', () => {
  const modules = readdirSync(SRC).filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));
  assert.ok(modules.includes('server.ts'), 'server.ts must be covered');
  for (const name of modules) {
    assert.doesNotThrow(
      () => execFileSync(process.execPath, ['--experimental-strip-types', '--check', path.join(SRC, name)], { stdio: 'pipe' }),
      `${name} does not parse`,
    );
  }
});
