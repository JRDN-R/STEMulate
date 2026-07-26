import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const dist = new URL("../dist/", import.meta.url);

test("builds a GitHub Pages-compatible app shell", async () => {
  const html = await readFile(new URL("index.html", dist), "utf8");

  assert.match(html, /<title>STEMulate — AI Practice Deck<\/title>/i);
  assert.match(html, /viewport-fit=cover/i);
  assert.match(html, /apple-mobile-web-app-capable/i);
  assert.match(html, /href="\.\/manifest\.webmanifest"/i);
  assert.match(html, /src="\.\/assets\/index-[^"]+\.js"/i);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/i);
});

test("ships the PWA assets with relative scope", async () => {
  const manifest = JSON.parse(await readFile(new URL("manifest.webmanifest", dist), "utf8"));

  assert.equal(manifest.name, "STEMulate — AI Practice Deck");
  assert.equal(manifest.start_url, "./");
  assert.equal(manifest.scope, "./");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.icons[0].src, "./icons/icon-192.png");

  await Promise.all([
    access(new URL("sw.js", dist)),
    access(new URL("stemulate-logo.png", dist)),
    access(new URL("icons/icon-512.png", dist)),
    access(new URL("icons/apple-touch-icon.png", dist)),
  ]);
});

test("precaches every hashed production script and stylesheet", async () => {
  const [serviceWorker, assets] = await Promise.all([
    readFile(new URL("sw.js", dist), "utf8"),
    readdir(new URL("assets/", dist)),
  ]);
  const bundledAssets = assets.filter((name) => /\.(?:css|js)$/i.test(name));

  assert.ok(bundledAssets.length > 0);
  for (const name of bundledAssets) {
    assert.ok(serviceWorker.includes(`./assets/${name}`), `${name} is missing from the precache manifest`);
  }
  assert.doesNotMatch(serviceWorker, /__STEMULATE_(?:BUILD_ID|PRECACHE_ASSETS)__/);
  assert.match(serviceWorker, /event\.request\.mode\s*===\s*"navigate"/);
  assert.match(serviceWorker, /STATIC_DESTINATIONS[\s\S]*"worker"/);

  const navigationHandler = serviceWorker.slice(
    serviceWorker.indexOf("async function navigationResponse"),
    serviceWorker.indexOf("async function staticResponse"),
  );
  const staticHandler = serviceWorker.slice(
    serviceWorker.indexOf("async function staticResponse"),
    serviceWorker.indexOf('self.addEventListener("fetch"'),
  );
  assert.match(navigationHandler, /index\.html/);
  assert.doesNotMatch(staticHandler, /index\.html/);
});

test("never places a Music.ai API key in the browser build", async () => {
  const assets = await readdir(new URL("assets/", dist));
  const textFiles = assets.filter((name) => /\.(js|css)$/.test(name));
  const bundleText = (await Promise.all(textFiles.map((name) => readFile(new URL(`assets/${name}`, dist), "utf8")))).join("\n");

  assert.doesNotMatch(bundleText, /MUSIC_AI_API_KEY\s*[=:]\s*["'][^"']+["']/i);
  assert.doesNotMatch(bundleText, /api\.music\.ai\/v1\/job/i);
  assert.match(bundleText, /secure Firebase backend/i);
});

test("keeps deployment configuration outside the public artifact", async () => {
  const envExample = await readFile(new URL(".env.example", root), "utf8");
  assert.match(envExample, /VITE_STEMULATE_BACKEND_ENABLED=false/);
  assert.match(envExample, /VITE_ENABLE_SPOTIFY_IMPORT=false/);
  assert.match(envExample, /VITE_FIREBASE_APP_CHECK_SITE_KEY=/);
  assert.doesNotMatch(envExample, /MUSIC_AI_API_KEY\s*=\s*\S+/);
});

test("guards Spotify before the remote job callable when the deploy flag is off", async () => {
  const [client, app, remoteSources, workflow] = await Promise.all([
    readFile(new URL("src/lib/musicAi.ts", root), "utf8"),
    readFile(new URL("src/App.tsx", root), "utf8"),
    readFile(new URL("src/lib/remoteSources.ts", root), "utf8"),
    readFile(new URL(".github/workflows/deploy-pages.yml", root), "utf8"),
  ]);

  assert.match(
    client,
    /validateRemoteImportUrl\(normalizedUrl,\s*spotifyImportEnabled\)[\s\S]*ensureRemoteJob\(active/,
  );
  assert.match(app, /spotifyEnabled \? "YouTube \/ Spotify" : "YouTube"/);
  assert.match(app, /remoteImportValidationMessage\(validation,\s*spotifyImportEnabled\)/);
  assert.match(remoteSources, /Spotify importing is disabled on this deployment/);
  assert.match(workflow, /VITE_ENABLE_SPOTIFY_IMPORT:[^\n]*false/);
});

test("streams private outputs through an owner-only expiring URL callable", async () => {
  const client = await readFile(new URL("src/lib/musicAi.ts", root), "utf8");
  const functions = await readFile(new URL("functions/src/index.ts", root), "utf8");

  assert.match(client, /getProcessingOutputs/);
  assert.doesNotMatch(client, /getDownloadURL/);
  assert.match(functions, /export const getProcessingOutputs = onCall/);
  assert.match(functions, /enforceAppCheck:\s*true/);
});

test("bounds remote analysis artifacts and retries the same saved import", async () => {
  const [client, app] = await Promise.all([
    readFile(new URL("src/lib/musicAi.ts", root), "utf8"),
    readFile(new URL("src/App.tsx", root), "utf8"),
  ]);

  assert.match(client, /MAX_REMOTE_ARTIFACT_BYTES\s*=\s*16\s*\*\s*1024\s*\*\s*1024/);
  assert.match(client, /headers\.get\("content-length"\)/);
  assert.match(client, /response\.body\.getReader\(\)/);
  assert.match(client, /receivedBytes\s*>\s*MAX_REMOTE_ARTIFACT_BYTES/);
  assert.doesNotMatch(client, /response\.json\(\)/);
  assert.match(client, /rememberRemoteJob\(active\)[\s\S]*ensureRemoteJob\(active/);
  assert.match(app, /REMOTE_RESUME_BACKOFF_MS/);
  assert.match(app, /addEventListener\("online"/);
  assert.match(app, /addEventListener\("pageshow"/);
  assert.match(app, /addEventListener\("visibilitychange"/);
});

test("never substitutes demo maps for missing live Music.ai analysis", async () => {
  const [app, client] = await Promise.all([
    readFile(new URL("src/App.tsx", root), "utf8"),
    readFile(new URL("src/lib/musicAi.ts", root), "utf8"),
  ]);

  assert.doesNotMatch(app, /result\.beats\.length\s*\?\s*result\.beats\s*:\s*current\.beats/);
  assert.doesNotMatch(app, /result\.chords\.length\s*\?\s*result\.chords\s*:\s*current\.chords/);
  assert.doesNotMatch(app, /result\.sections\.length\s*\?\s*result\.sections\s*:\s*current\.sections/);
  assert.match(app, /No chord map was returned/);
  assert.match(app, /No section map was returned/);
  assert.match(client, /bpm:\s*Number\(bpmValue\)\s*\|\|\s*0/);
});

test("integrates the sample-clocked stem transport without media follower seeks", async () => {
  const [app, transport] = await Promise.all([
    readFile(new URL("src/App.tsx", root), "utf8"),
    readFile(new URL("src/lib/stemTransport.ts", root), "utf8"),
  ]);

  assert.match(app, /new StemTransport\(\)/);
  assert.match(app, /transport\.load\(audioSources/);
  assert.match(app, /transport\.play\(\)/);
  assert.doesNotMatch(app, /new Audio\(\)/);
  assert.doesNotMatch(app, /Math\.abs\(audio\.currentTime\s*-\s*clock\.currentTime\)/);
  assert.match(transport, /context\.createBufferSource\(\)/);
  assert.match(transport, /const when = context\.currentTime \+ this\.scheduleAheadSeconds/);
});
