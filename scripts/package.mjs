#!/usr/bin/env node
/**
 * Build and package Regex Rabbit into dist/regex-rabbit.zip.
 *
 * Only copies files actually injected by background.js:
 *   style.css, domain/pattern_analyzer.js, content_script.js,
 *   background.js, manifest.json, icons/
 *
 * No Worker, no esbuild, no CSP issues.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = import.meta.dirname;
const REPO = join(ROOT, "..");
const DIST = join(REPO, "dist");

if (existsSync(DIST)) rmSync(DIST, { recursive: true });
mkdirSync(DIST, { recursive: true });

// ── Copy runtime files ──────────────────────────────
const FILES = ["manifest.json", "background.js", "content_script.js", "style.css", "options.html", "options.css", "options.js"];
for (const f of FILES) {
  const src = join(REPO, f);
  if (existsSync(src)) cpSync(src, join(DIST, f));
}

mkdirSync(join(DIST, "domain"), { recursive: true });
const domainFiles = ["error_registry.js", "pattern_analyzer.js", "display_formatter.js"];
for (const f of domainFiles) {
  const src = join(REPO, "domain", f);
  if (existsSync(src)) cpSync(src, join(DIST, "domain", f));
}

mkdirSync(join(DIST, "infra"), { recursive: true });
const infraFiles = ["text_collector.js", "highlight_engine.js", "worker_manager.js"];
for (const f of infraFiles) {
  const src = join(REPO, "infra", f);
  if (existsSync(src)) cpSync(src, join(DIST, "infra", f));
}

const icons = join(REPO, "icons");
if (existsSync(icons)) cpSync(icons, join(DIST, "icons"), { recursive: true });

// ── Zip ────────────────────────────────────────────
const crcTable = Array.from({ length: 256 }, (_, i) => {
  let v = i; for (let b = 0; b < 8; b++) v = v & 1 ? 0xedb88320 ^ (v >>> 1) : v >>> 1;
  return v >>> 0;
});
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = (c >>> 8) ^ crcTable[(c ^ b) & 0xff]; return (c ^ 0xffffffff) >>> 0; }

async function list(dir) {
  const { readdir } = await import("node:fs/promises");
  const es = await readdir(dir, { withFileTypes: true });
  const out = [];
  for (const e of es) {
    const ep = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await list(ep))); else out.push(ep);
  }
  return out.sort();
}

const all = await list(DIST);
const zipPath = join(DIST, "regex-rabbit.zip");
const entries = []; let offset = 0;

for (const fp of all) {
  if (fp === zipPath) continue;
  const name = fp.slice(DIST.length + 1).replaceAll("\\", "/");
  const data = readFileSync(fp);
  const enc = Buffer.from(name);
  const crc = crc32(data);

  const lh = Buffer.alloc(30 + enc.length);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6);
  lh.writeUInt16LE(0, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
  lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22);
  lh.writeUInt16LE(enc.length, 26); enc.copy(lh, 30);

  const ch = Buffer.alloc(46 + enc.length);
  ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
  ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(0, 10); ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0, 14);
  ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24);
  ch.writeUInt16LE(enc.length, 28); ch.writeUInt32LE(0, 38); ch.writeUInt32LE(offset, 42);
  enc.copy(ch, 46);
  entries.push({ lh, ch, data }); offset += lh.length + data.length;
}

const locals = Buffer.concat(entries.flatMap(e => [e.lh, e.data]));
const cdir = Buffer.concat(entries.map(e => e.ch));
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8);
eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cdir.length, 12); eocd.writeUInt32LE(offset, 16);
writeFileSync(zipPath, Buffer.concat([locals, cdir, eocd]));
console.log("Packaged " + zipPath + " (" + (entries.length + 1) + " files)");
