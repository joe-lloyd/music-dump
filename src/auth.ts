import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';

const TOKEN_FILE = path.join(import.meta.dirname, '..', 'tokens.json');
const REDIRECT_URI = 'http://127.0.0.1:8888/callback';
const SCOPES = [
  'user-library-read',
  'user-follow-read',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-top-read',
  'user-read-recently-played',
].join(' ');

interface TokenSet {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function loadTokens(): TokenSet | null {
  try {
    return JSON.parse(readFileSync(TOKEN_FILE, 'utf8')) as TokenSet;
  } catch {
    return null;
  }
}

function saveTokens(tokens: TokenSet): void {
  writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2) + '\n', { mode: 0o600 });
}

async function tokenRequest(params: Record<string, string>): Promise<TokenSet> {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  if (!res.ok) {
    throw new Error(`Token request failed (${res.status}): ${await res.text()}`);
  }
  const body = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };
  return {
    access_token: body.access_token,
    // Spotify may rotate the refresh token; fall back to the one we sent.
    refresh_token: body.refresh_token ?? params.refresh_token ?? '',
    expires_at: Date.now() + body.expires_in * 1000,
  };
}

async function authorize(clientId: string): Promise<TokenSet> {
  const verifier = b64url(randomBytes(64));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(16));

  const authUrl = new URL('https://accounts.spotify.com/authorize');
  authUrl.search = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    state,
  }).toString();

  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', REDIRECT_URI);
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get('error');
      const gotCode = url.searchParams.get('code');
      const gotState = url.searchParams.get('state');
      if (error || !gotCode || gotState !== state) {
        res.writeHead(400, { 'content-type': 'text/plain' });
        res.end(`Authorization failed: ${error ?? 'state mismatch or missing code'}`);
        server.close();
        reject(new Error(`Authorization failed: ${error ?? 'state mismatch or missing code'}`));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<body style="font-family:sans-serif"><h2>Authorized ✓</h2>You can close this tab and return to the terminal.</body>');
      server.close();
      resolve(gotCode);
    });
    server.on('error', reject);
    server.listen(8888, '127.0.0.1', () => {
      console.log(`\nOpen this URL to authorize (it should open automatically):\n\n  ${authUrl}\n`);
      if (process.platform === 'darwin') {
        spawn('open', [authUrl.toString()], { stdio: 'ignore', detached: true }).unref();
      }
    });
  });

  return tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: verifier,
  });
}

let cached: TokenSet | null = null;
let clientId = '';

export async function initAuth(): Promise<void> {
  const id = process.env.SPOTIFY_CLIENT_ID;
  if (!id) {
    console.error('SPOTIFY_CLIENT_ID is not set.');
    console.error('Create an app at https://developer.spotify.com/dashboard,');
    console.error(`add ${REDIRECT_URI} as a redirect URI, then run:`);
    console.error('  SPOTIFY_CLIENT_ID=<your client id> pnpm export');
    process.exit(1);
  }
  clientId = id;
  cached = loadTokens();
  if (!cached) {
    cached = await authorize(clientId);
    saveTokens(cached);
    console.log('Authorized. Tokens saved to tokens.json (gitignored).');
  }
}

export async function getAccessToken(): Promise<string> {
  if (!cached) throw new Error('initAuth() was not called');
  if (Date.now() > cached.expires_at - 60_000) {
    try {
      cached = await tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: cached.refresh_token,
        client_id: clientId,
      });
    } catch (err) {
      // Refresh token revoked or expired — fall back to a fresh authorization.
      console.warn(`Token refresh failed (${(err as Error).message}), re-authorizing...`);
      cached = await authorize(clientId);
    }
    saveTokens(cached);
  }
  return cached.access_token;
}
