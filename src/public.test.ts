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
import { uiDir } from '../ui/index.js';

// The files now live in the shared ui/ package, and its own manifest says where
// -- asking it beats hardcoding a path that only one of the two consumers uses.
const PUBLIC = uiDir;

function inlineScripts(html: string): string[] {
  // Only scripts with a body; `<script src=...>` has nothing to parse here.
  return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1])
    .filter((body) => body.trim().length > 0);
}

test('any inline script in index.html parses', () => {
  const html = readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const scripts = inlineScripts(html);
  // No longer requires that one exists. The UI is now built from TypeScript
  // sources, so the document is a shell with a single <script src>, and the
  // redeclaration SyntaxError this test was written for is caught by tsc and
  // the bundler long before a file is written. The loop stays because an
  // inline script could be reintroduced -- and if it is, it still gets checked.
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

// The `hidden` attribute is only display:none in the UA stylesheet, so ANY
// author `display` on the element's own class beats it and the control is
// permanently on screen. The drawer backdrop was caught by this once already
// (see the comment on body.nav-open .nav-backdrop). The back button is the
// same shape - display:inline-flex, shown and hidden by the router through
// the attribute - so it needs its guard kept.
test('the back button has a rule that beats its own display', () => {
  const css = readFileSync(path.join(PUBLIC, 'app.css'), 'utf8');
  assert.match(css, /\.page-back\[hidden\]\s*\{[^}]*display:\s*none/,
    '.page-back sets a display, so it needs an explicit [hidden] rule to beat it');
});

// The other half of that assertion -- that the button ships hidden -- used to
// be checked here by grepping index.html. It cannot be, any more: React
// creates the button from the bundle, so it is never in the served document.
// This does not "come back once the port lands"; the assertion belongs in a
// component test in music-ui, next to the component that renders it. Recorded
// as todo rather than deleted so the coverage is owed to someone.
test('the back button ships hidden', { todo: 'moves to a music-ui component test with the shell port' }, () => {});

test('the manifest and any JSON assets are valid JSON', () => {
  for (const name of readdirSync(PUBLIC).filter((file) => file.endsWith('.webmanifest') || file.endsWith('.json'))) {
    const body = readFileSync(path.join(PUBLIC, name), 'utf8');
    assert.doesNotThrow(() => JSON.parse(body), `${name} is not valid JSON`);
  }
});
