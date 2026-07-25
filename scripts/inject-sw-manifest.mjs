import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const assetsDirectory = new URL("dist/assets/", root);
const serviceWorkerUrl = new URL("dist/sw.js", root);
const manifestToken = '["__STEMULATE_PRECACHE_ASSETS__"]';
const buildIdToken = "__STEMULATE_BUILD_ID__";

const assetNames = (await readdir(assetsDirectory))
  .filter((name) => /\.(?:css|js)$/i.test(name))
  .sort();
if (!assetNames.length) throw new Error("No production JavaScript or CSS assets were found for service-worker precaching.");

const assetUrls = assetNames.map((name) => `./assets/${name}`);
const shellFiles = [
  "index.html",
  "manifest.webmanifest",
  "stemulate-logo.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png",
];
const buildHash = createHash("sha256");
for (const path of [...assetUrls.map((url) => url.slice(2)), ...shellFiles]) {
  buildHash.update(path);
  buildHash.update(await readFile(new URL(`dist/${path}`, root)));
}
const buildId = buildHash.digest("hex").slice(0, 16);
const source = await readFile(serviceWorkerUrl, "utf8");
if (!source.includes(manifestToken) || !source.includes(buildIdToken)) {
  throw new Error("The service-worker precache placeholders are missing.");
}

const injected = source
  .replace(manifestToken, JSON.stringify(assetUrls, null, 2))
  .replaceAll(buildIdToken, buildId);
await writeFile(serviceWorkerUrl, injected, "utf8");
