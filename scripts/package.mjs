#!/usr/bin/env node
// Package the complete extension runtime; missing files fail the build.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = import.meta.dirname;
const REPO = join(ROOT, "..");
const DIST = join(REPO, "dist");

if (existsSync(DIST)) rmSync(DIST, { recursive: true });
mkdirSync(DIST, { recursive: true });

// ── Copy runtime files ──────────────────────────────
const FILES = ["manifest.json", "background.js", "content_script.js", "style.css", "options.html", "options.css", "options.js", "search_worker.js", "offscreen.html", "offscreen.js"];
for (const f of FILES) {
  const src = join(REPO, f);
  cpSync(src, join(DIST, f));
}

mkdirSync(join(DIST, "domain"), { recursive: true });
const domainFiles = ["runtime_policy.js", "error_registry.js", "pattern_analyzer.js", "literal_matcher.js", "display_formatter.js", "runtime_config.js"];
for (const f of domainFiles) {
  const src = join(REPO, "domain", f);
  cpSync(src, join(DIST, "domain", f));
}

mkdirSync(join(DIST, "infra"), { recursive: true });
const infraFiles = ["ui_i18n.js", "toolbar_position.js", "task_scheduler.js", "page_visibility.js", "selection_capture.js", "text_mapping.js", "text_collector.js", "highlight_engine.js", "worker_transport.js", "worker_manager.js", "dynamic_observer.js", "search_controller.js", "search_toolbar.js"];
for (const f of infraFiles) {
  const src = join(REPO, "infra", f);
  cpSync(src, join(DIST, "infra", f));
}

const icons = join(REPO, "icons");
if (existsSync(icons)) cpSync(icons, join(DIST, "icons"), { recursive: true });

cpSync(join(REPO, "_locales"), join(DIST, "_locales"), { recursive: true });

// ZIP32 uses fixed binary offsets from its file format, not application limits.
// Entries are stored without compression; zero-filled timestamp/extra fields
// make repeated builds deterministic.
const ZIP32 = {
  version: 20,
  utf8Flag: 0x0800,
  local: { signature: 0x04034b50, bytes: 30, version: 4, flags: 6, crc: 14, compressedSize: 18, size: 22, nameLength: 26 },
  central: { signature: 0x02014b50, bytes: 46, madeBy: 4, version: 6, flags: 8, crc: 16, compressedSize: 20, size: 24, nameLength: 28, localOffset: 42 },
  end: { signature: 0x06054b50, bytes: 22, diskEntries: 8, entries: 10, directorySize: 12, directoryOffset: 16 }
};
const CRC32_POLYNOMIAL = 0xedb88320;
const UINT32_MASK = 0xffffffff;
const BYTE_MASK = 0xff;
const BITS_PER_BYTE = 8;
const crcTable = Array.from({ length: BYTE_MASK + 1 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < BITS_PER_BYTE; bit++) {
    value = value & 1 ? CRC32_POLYNOMIAL ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});
function crc32(buffer) {
  let value = UINT32_MASK;
  for (const byte of buffer) value = (value >>> BITS_PER_BYTE) ^ crcTable[(value ^ byte) & BYTE_MASK];
  return (value ^ UINT32_MASK) >>> 0;
}

async function listFiles(directory) {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path));
    else files.push(path);
  }
  return files.sort();
}

function entryHeaders(name, data, offset) {
  const encodedName = Buffer.from(name);
  const crc = crc32(data);
  const localFormat = ZIP32.local;
  const centralFormat = ZIP32.central;
  const local = Buffer.alloc(localFormat.bytes + encodedName.length);
  local.writeUInt32LE(localFormat.signature, 0);
  local.writeUInt16LE(ZIP32.version, localFormat.version);
  local.writeUInt16LE(ZIP32.utf8Flag, localFormat.flags);
  local.writeUInt32LE(crc, localFormat.crc);
  local.writeUInt32LE(data.length, localFormat.compressedSize);
  local.writeUInt32LE(data.length, localFormat.size);
  local.writeUInt16LE(encodedName.length, localFormat.nameLength);
  encodedName.copy(local, localFormat.bytes);

  const central = Buffer.alloc(centralFormat.bytes + encodedName.length);
  central.writeUInt32LE(centralFormat.signature, 0);
  central.writeUInt16LE(ZIP32.version, centralFormat.madeBy);
  central.writeUInt16LE(ZIP32.version, centralFormat.version);
  central.writeUInt16LE(ZIP32.utf8Flag, centralFormat.flags);
  central.writeUInt32LE(crc, centralFormat.crc);
  central.writeUInt32LE(data.length, centralFormat.compressedSize);
  central.writeUInt32LE(data.length, centralFormat.size);
  central.writeUInt16LE(encodedName.length, centralFormat.nameLength);
  central.writeUInt32LE(offset, centralFormat.localOffset);
  encodedName.copy(central, centralFormat.bytes);
  return { local, central, data };
}

const files = await listFiles(DIST);
const zipPath = join(DIST, "regex-rabbit.zip");
const entries = [];
let offset = 0;
for (const file of files) {
  const name = file.slice(DIST.length + 1).replaceAll("\\", "/");
  const entry = entryHeaders(name, readFileSync(file), offset);
  entries.push(entry);
  offset += entry.local.length + entry.data.length;
}
const locals = Buffer.concat(entries.flatMap(entry => [entry.local, entry.data]));
const directory = Buffer.concat(entries.map(entry => entry.central));
const endFormat = ZIP32.end;
const end = Buffer.alloc(endFormat.bytes);
end.writeUInt32LE(endFormat.signature, 0);
end.writeUInt16LE(entries.length, endFormat.diskEntries);
end.writeUInt16LE(entries.length, endFormat.entries);
end.writeUInt32LE(directory.length, endFormat.directorySize);
end.writeUInt32LE(offset, endFormat.directoryOffset);
writeFileSync(zipPath, Buffer.concat([locals, directory, end]));
console.log("Packaged " + zipPath + " (" + (entries.length + 1) + " files)");
