import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("keeps iOS text-entry controls at the non-zooming font-size threshold", async () => {
  const styles = await readFile(new URL("src/styles.css", root), "utf8");
  const textEntryRule = styles.match(
    /input\[type="text"\],[\s\S]*?textarea\s*\{([\s\S]*?)\}/,
  );

  assert.ok(textEntryRule, "The shared text-entry control rule is missing.");
  assert.match(textEntryRule[1], /font-size:\s*16px\s*;/);
  assert.match(textEntryRule[0], /input\[type="url"\]/);
  assert.match(textEntryRule[0], /select/);
  assert.match(textEntryRule[0], /textarea/);
});

test("preserves user-controlled pinch zoom in the mobile viewport", async () => {
  const html = await readFile(new URL("index.html", root), "utf8");
  const viewport = html.match(/<meta\s+name="viewport"\s+content="([^"]+)"/i);

  assert.ok(viewport, "The viewport meta tag is missing.");
  assert.doesNotMatch(viewport[1], /user-scalable\s*=\s*no/i);
  assert.doesNotMatch(viewport[1], /maximum-scale\s*=\s*1(?:\.0+)?(?:\s|,|$)/i);
});
