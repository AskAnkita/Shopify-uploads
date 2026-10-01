#!/usr/bin/env node
/**
 * Writes product titles and descriptions by looking at the renders.
 *
 * For every item in the Render folder that has no entry in product-content.json, this
 * sends ONE still image plus the folder name to the Claude API and asks for a title and
 * description in the house style. Results are merged into product-content.json, which you
 * then read and edit before importing — nothing goes to Shopify from here.
 *
 *   export ANTHROPIC_API_KEY=sk-ant-...
 *   node describe.js                 # dry run — lists what it would describe, costs nothing
 *   node describe.js --write         # call the API and save the results
 *   node describe.js --write --force # redo items that already have copy
 *   node describe.js --write --only AJER666
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const value = (n) => { const i = args.indexOf(n); return i === -1 ? null : args[i + 1]; };

const cfg = JSON.parse(fs.readFileSync(value('--config') || './config.json', 'utf8'));
const WRITE = flag('--write');
const FORCE = flag('--force');
const ONLY = value('--only') ? value('--only').split(',').map((s) => s.trim().toUpperCase()) : null;

export const HAS_KEY = () => !!process.env.ANTHROPIC_API_KEY;
const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = cfg.describe?.model || 'claude-sonnet-4-5';
const CONTENT_FILE = cfg.contentFile || './product-content.json';

const die = (m) => { console.error(`\n✖ ${m}\n`); process.exit(1); };

// ---------------------------------------------------------------- helpers ---

const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp'];

const baseCode = (code) => {
  const m = String(code).trim().match(/^([A-Za-z]+\s*\d+)/);
  return m ? m[1].replace(/\s+/g, '') : String(code).trim();
};
const caratsFrom = (name) => {
  const m = String(name).match(/(\d+(?:\.\d+)?)\s*CTS?\b/i);
  return m ? Number(m[1]) : null;
};

const CATEGORY = { ER: 'earrings', LB: 'bracelet', NK: 'necklace', PD: 'pendant' };

/** Render folder: <Render>/<CATEGORY>/<ITEM FOLDER>/<files> */
function indexRenderItems(dir) {
  if (!fs.existsSync(dir)) die(`Render folder not found: ${dir}`);
  const items = [];
  for (const cat of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!cat.isDirectory() || cat.name.startsWith('.')) continue;
    const catDir = path.join(dir, cat.name);
    for (const entry of fs.readdirSync(catDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const itemDir = path.join(catDir, entry.name);
      const files = fs.readdirSync(itemDir)
        .filter((f) => IMAGE_EXT.includes(path.extname(f).toLowerCase()))
        .map((f) => path.join(itemDir, f));
      if (files.length) items.push({ code: baseCode(entry.name), folder: entry.name, category: cat.name, files });
    }
  }
  return items.sort((a, z) => a.code.localeCompare(z.code, undefined, { numeric: true }));
}

/**
 * Pick the clearest single still: prefer a white-metal front view (lowest number),
 * since that shows the stone shape without the metal tint competing.
 */
function pickImage(files) {
  const score = (f) => {
    const b = path.basename(f);
    const m = b.match(/-([RWY])(\d+)\./i);
    if (!m) return [9, 99];
    const colour = { W: 0, Y: 1, R: 2 }[m[1].toUpperCase()] ?? 3;
    return [colour, Number(m[2])];
  };
  return [...files].sort((a, z) => {
    const [ca, na] = score(a), [cz, nz] = score(z);
    return ca - cz || na - nz;
  })[0];
}

/**
 * The renders are 3–5 MB PNGs — far larger than the API needs, and large images cost
 * more tokens. macOS ships sips, so downscale to 1024px with no extra dependency.
 */
function shrink(file) {
  try {
    const out = path.join(os.tmpdir(), `desc-${Date.now()}-${path.basename(file)}.jpg`);
    execFileSync('sips', ['-s', 'format', 'jpeg', '-Z', '1024', file, '--out', out], { stdio: 'ignore' });
    return { path: out, media: 'image/jpeg', temp: true };
  } catch {
    const ext = path.extname(file).toLowerCase();
    return { path: file, media: ext === '.png' ? 'image/png' : 'image/jpeg', temp: false };
  }
}

// ------------------------------------------------------------------- api ---

const SYSTEM = `You write product copy for a lab-grown diamond jewellery brand.

You will be shown ONE render of a piece of jewellery, plus its item code, category and
total carat weight. Identify the diamond cut(s), the setting style and the piece type from
the image, and write a title and description.

TITLE FORMAT — follow exactly:
  "<carats> CTW <Cut> Lab-Grown Diamond <Piece Type>"
examples:
  "3 CTW Round Brilliant Lab-Grown Diamond Stud Earrings"
  "1.5 CTW Emerald Cut Lab-Grown Diamond Huggie Hoop Earrings"
Drop trailing zeros in the carat figure (3.0 becomes 3). If no carat weight is supplied,
omit the "<carats> CTW " prefix entirely and start with the cut.

DESCRIPTION FORMAT — return HTML in exactly this shape:
<p><strong>Description</strong></p><p>FIRST PARAGRAPH</p><p>SECOND PARAGRAPH</p><p><strong>Key Features:</strong></p><ul><li>…</li></ul>

First paragraph: what the piece is, the cut, the setting, and the carat weight. Two or
three sentences. Second paragraph: how it wears and when — one or two sentences.
Then 5–7 key features as short bullets. Include one bullet reading exactly
"Available in white, yellow and rose metal options".

RULES
- Use the supplied facts (cut, stone count, sizes, carat weight) as true — they come from
  the supplier's packing list. For anything NOT supplied, describe only what you can see in
  the image. Never invent stone counts, millimetre sizes, clarity or colour grades.
- Always say "lab-grown", never imply mined.
- British spelling. Warm but restrained — no "stunning", "exquisite", "breathtaking".
- Return ONLY a JSON object: {"title": "...", "description": "..."}. No other text.`;

export async function describeItem(item) {
  const chosen = pickImage(item.files);
  const img = shrink(chosen);
  const b64 = fs.readFileSync(img.path).toString('base64');
  if (img.temp) { try { fs.unlinkSync(img.path); } catch {} }

  const carats = caratsFrom(item.folder) ?? item.sheet?.carats ?? null;
  const s = item.sheet || {};
  const facts = [
    `Item code: ${item.code}`,
    `Category: ${CATEGORY[item.category] || item.category}`,
    carats !== null ? `Total carat weight: ${carats} CTW` : 'Total carat weight: not supplied',
    // Everything below comes from the packing list, so it is fact rather than inference.
    s.diamondCut ? `Diamond cut (from the packing list): ${s.diamondCut}` : null,
    s.diamondSize ? `Stone size: ${s.diamondSize} mm` : null,
    s.diamondPcs ? `Number of stones: ${s.diamondPcs}` : null,
    s.metals ? `Offered in: ${s.metals}` : null,
    s.netWt ? `Net metal weight: ${s.netWt} g` : null,
  ].filter(Boolean).join('\n');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1200,
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: img.media, data: b64 } },
          { type: 'text', text: facts },
        ],
      }],
    }),
  });

  if (!res.ok) {
    const body = (await res.text()).slice(0, 400);
    if (res.status === 404 || /model/i.test(body)) {
      throw new Error(`The API rejected model "${MODEL}".\n  ${body}\n` +
        `  Set a current model id in config.json under "describe": { "model": "..." }.`);
    }
    throw new Error(`HTTP ${res.status}: ${body}`);
  }

  const json = await res.json();
  const text = (json.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`Could not read a JSON reply:\n  ${text.slice(0, 200)}`);

  const out = JSON.parse(m[0]);
  if (!out.title || !out.description) throw new Error('Reply was missing title or description.');
  return { ...out, usage: json.usage, sourceImage: path.basename(chosen) };
}

// ------------------------------------------------------------------- run ---

async function main() {
  const items = indexRenderItems(cfg.imagesDir);
  const content = fs.existsSync(CONTENT_FILE)
    ? JSON.parse(fs.readFileSync(CONTENT_FILE, 'utf8'))
    : {};

  let todo = items.filter((i) => FORCE || !content[i.code]?.title);
  if (ONLY) todo = todo.filter((i) => ONLY.includes(i.code.toUpperCase()));

  console.log(`\nRender    ${cfg.imagesDir} — ${items.length} items`);
  console.log(`Content   ${CONTENT_FILE} — ${Object.keys(content).filter((k) => !k.startsWith('_')).length} already written`);
  console.log(`To write  ${todo.length}`);
  console.log(`Model     ${MODEL}`);
  console.log(`Mode      ${WRITE ? 'LIVE — will call the API' : 'DRY RUN — no API calls'}\n`);

  if (!todo.length) { console.log('Nothing to do.\n'); return; }

  if (!WRITE) {
    for (const i of todo) {
      const c = caratsFrom(i.folder);
      console.log(`· ${i.code.padEnd(12)} ${i.category}  ${c !== null ? c + ' CTW' : 'carats unknown'}  →  ${path.basename(pickImage(i.files))}`);
    }
    console.log(`\nRun again with --write to generate copy for these ${todo.length}.\n`);
    return;
  }

  if (!KEY) die('Set ANTHROPIC_API_KEY first.\n  Create one at https://console.anthropic.com → API keys.');

  let ok = 0, failed = 0, inTok = 0, outTok = 0;
  for (const item of todo) {
    process.stdout.write(`  ${item.code.padEnd(12)} describing…`);
    try {
      const r = await describeItem(item);
      content[item.code] = { title: r.title, description: r.description };
      inTok += r.usage?.input_tokens || 0;
      outTok += r.usage?.output_tokens || 0;
      process.stdout.write(`\r✓ ${item.code.padEnd(12)} ${r.title}\n`);
      ok++;
      // Save as we go, so a failure halfway doesn't lose the work already paid for.
      fs.writeFileSync(CONTENT_FILE, JSON.stringify(content, null, 2) + '\n');
    } catch (e) {
      process.stdout.write(`\r✖ ${item.code.padEnd(12)} ${e.message}\n`);
      failed++;
    }
  }

  console.log(`\n${ok} written, ${failed} failed.`);
  console.log(`Tokens: ${inTok} in, ${outTok} out.`);
  console.log(`\nRead through ${CONTENT_FILE} and edit anything that reads wrong,`);
  console.log(`then run: node import.js --audit\n`);
}

import { pathToFileURL } from 'node:url';
// Only run the CLI when this file is executed directly — import.js imports describeItem.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => die(e.stack || e.message));
}
