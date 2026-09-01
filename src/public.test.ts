// The UI is one large inline <script> in index.html plus player.js. Nothing
// imports either, so a syntax error in them reaches the browser and blanks
// the whole page with no server-side signal at all.
//
// The case that motivated this: a second `const badges = ...` was added
// alongside an existing one. Both halves looked right in isolation; together
// they are a redeclaration SyntaxError, and the page renders nothing.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const PUBLIC = path.join(import.meta.dirname, '..', 'public');

function inlineScripts(html: string): string[] {
  // Only scripts with a body; `<script src=...>` has nothing to parse here.
  return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1])
    .filter((body) => body.trim().length > 0);
}

test('every inline script in index.html parses', () => {
  const html = readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const scripts = inlineScripts(html);
  assert.ok(scripts.length > 0, 'expected at least one inline script');
  for (const [index, body] of scripts.entries()) {
    // Compiling without running catches syntax and redeclaration errors while
    // leaving the DOM calls in the body untouched.
    assert.doesNotThrow(
      () => new vm.Script(body, { filename: `index.html#script-${index}` }),
      `inline script ${index} does not parse`,
    );
  }
});

test('every shipped javascript file parses', () => {
  for (const name of readdirSync(PUBLIC).filter((file) => file.endsWith('.js'))) {
    const body = readFileSync(path.join(PUBLIC, name), 'utf8');
    assert.doesNotThrow(() => new vm.Script(body, { filename: name }), `${name} does not parse`);
  }
});

test('the manifest and any JSON assets are valid JSON', () => {
  for (const name of readdirSync(PUBLIC).filter((file) => file.endsWith('.webmanifest') || file.endsWith('.json'))) {
    const body = readFileSync(path.join(PUBLIC, name), 'utf8');
    assert.doesNotThrow(() => JSON.parse(body), `${name} is not valid JSON`);
  }
});
