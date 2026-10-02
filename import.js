#!/usr/bin/env node
/**
 * Shopify bulk product creator — Asimi packing list + Render folder.
 *
 * Sheet  : Render/<CATEGORY>/<ITEM CODE>/<CODE>-<R|W|Y><n>.<png|mp4>
 * Product: one product per item code, two options —
 *            Metal  (925 Silver / 10K / 14K / 18K Gold)  → sets the price
 *            Colour (Rose / White / Yellow)              → sets the image
 *
 * Safe to re-run: item codes already in the store are skipped.
 *
 *   export SHOPIFY_ADMIN_TOKEN=shpat_xxx
 *   node import.js                    # dry run — parses and reports, creates nothing
 *   node import.js --live --limit 1   # one product, then eyeball it in Admin
 *   node import.js --live             # the lot
 *   node import.js --live --no-video  # stills only, much faster
 */

import fs from 'node:fs';
import path from 'node:path';
import { describeItem, HAS_KEY } from './describe.js';
import { execFileSync } from 'node:child_process';

// ---------------------------------------------------------------- config ---

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const value = (n) => { const i = args.indexOf(n); return i === -1 ? null : args[i + 1]; };

const configPath = value('--config') || './config.json';
if (!fs.existsSync(configPath)) die(`Config not found: ${configPath}\nCopy config.example.json to config.json and edit it.`);
const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));

let TOKEN = process.env.SHOPIFY_ADMIN_TOKEN || null;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID || null;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET || null;
const LIVE = flag('--live');
const DRY = !LIVE;
const WITH_VIDEO = cfg.media.uploadVideos && !flag('--no-video');
const FORCE = flag('--force');
const AUDIT = flag('--audit');
const ALLOW_UNTITLED = flag('--untitled');
const SYNC_CONTENT = flag('--sync-content');
const CHECK = flag('--check');
const SYNC_PRICES = flag('--sync-prices');
const SYNC_CATEGORIES = flag('--sync-categories');
const SYNC_COLLECTIONS = flag('--sync-collections');
const SHOW_SKIPPED = flag('--show-skipped');
const THEME_GREP = args.includes('--theme-grep') ? (value('--theme-grep') || '') : null;
const THEME_FILE = value('--theme-file') || null;
const RENDERS_REPORT = flag('--renders');
const FIX_OPTIONS = flag('--fix-options');
const TITLES_REPORT = flag('--titles');
const PUSH_TITLES = flag('--push-titles');
const PRICE_OF = value('--price-of') || null;
const DESC_DUMP = flag('--desc');
const RESTORE_DESC = args.includes('--restore-descriptions') ? (value('--restore-descriptions') || true) : null;
const IGNORED_REPORT = flag('--ignored');
const VERIFY = flag('--verify');
const SYNC_SKUS = flag('--sync-skus');
const SYNC_VARIANT_IMAGES = flag('--sync-variant-images');
const SYNC_LENGTHS = flag('--sync-lengths');
const SYNC_BANGLES = flag('--sync-bangles');
const SET_STATUS = value('--set-status') || null;
const HARVEST_SPECS = flag('--harvest-specs');
const LINKED_VALUES = flag('--linked-values');
const REMAP_VALUES = flag('--remap-values');
const REMAP_MAP = value('--map') || null;
const RENAME = value('--rename') || null;
const RENAME_TO = value('--to') || null;
const STOCK_REPORT = flag('--stock');
const PRODUCT_FILTER = value('--product') || null;
const LEGACY_SPECS = flag('--legacy-specs');
const METAL_FILTER = flag('--metal-filter');
const FIX_METAL_FILTER = flag('--fix-metal-filter');
const METAOBJECTS = flag('--metaobjects');
const SYNC_SHAPE_REF = flag('--sync-shape-ref');
const PUBLISH = flag('--publish');
const CHANNELS = flag('--channels');
const FIX_MEDIA = flag('--fix-media');
const MEDIA_LIST = flag('--media-list');
const PRICE_REPORT = flag('--prices');
const DUPES = flag('--duplicates');
const COLLECT_SPECS = flag('--collect-specs');
const SYNC_SPECS = flag('--sync-specs');
const WIPE = flag('--wipe');
const VIDEO_ALT = flag('--video-alt');
const OPTIONS_REPORT = flag('--options');
const SYNC_INVENTORY = flag('--sync-inventory');
const SYNC_MEDIA = flag('--sync-media');
const SYNC_VARIANTS = flag('--sync-variants');
const SYNC_FACETS = flag('--sync-facets');
const EXPORT_UNTITLED = flag('--export-untitled');
const COLLECT = flag('--collect-images');
const ALLOW_NO_PRICE = flag('--allow-no-price') || !!cfg.defaults.allowMissingPrice;
const ONLY = value('--only') ? value('--only').split(',').map((s) => s.trim().toUpperCase()) : null;
const LIMIT = (() => {
  if (!args.includes('--limit')) return Infinity;
  const raw = value('--limit');
  const n = Number(raw);
  // "--limit" with nothing after it used to silently mean "no limit" and create everything.
  if (!raw || !Number.isFinite(n) || n < 1) {
    console.error('\n✖ --limit needs a number, e.g. --limit 1\n');
    process.exit(1);
  }
  return n;
})();


const ENDPOINT = `https://${cfg.store}/admin/api/${cfg.apiVersion}/graphql.json`;
const C = cfg.columnIndex;

function die(msg) { console.error(`\n✖ ${msg}\n`); process.exit(1); }

/**
 * Shopify's Dev Dashboard apps don't hand out a long-lived token. Instead the app's
 * client id + secret are exchanged for a short-lived one on each run, which means
 * there's no token to copy, store or lose. A legacy SHOPIFY_ADMIN_TOKEN still works
 * and takes precedence if it's set.
 */
let AUTH_USED = null;
async function ensureToken() {
  if (AUTH_USED) return TOKEN;
  // Client credentials win whenever they're set. A leftover SHOPIFY_ADMIN_TOKEN from an
  // older setup used to take priority silently, and a revoked one fails with a bare 401.
  if (!CLIENT_ID || !CLIENT_SECRET) {
    if (TOKEN) { AUTH_USED = 'legacy SHOPIFY_ADMIN_TOKEN'; return TOKEN; }
    return null;
  }
  if (process.env.SHOPIFY_ADMIN_TOKEN) {
    console.log('  (ignoring SHOPIFY_ADMIN_TOKEN \u2014 using client ID and secret instead)');
  }

  // Shopify's token endpoint returns 503/502/429 under load. That is not a credentials
  // problem, so retry a few times before giving up — otherwise a blip costs a whole run.
  let res = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    res = await fetch(`https://${cfg.store}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'client_credentials',
      }),
    });
    if (res.ok) break;
    const transient = res.status === 429 || res.status >= 500;
    if (!transient || attempt === 5) break;
    const wait = 2000 * attempt;
    console.log(`  (token endpoint returned ${res.status} — retrying in ${wait / 1000}s, attempt ${attempt + 1} of 5)`);
    await new Promise((r) => setTimeout(r, wait));
  }
  if (!res.ok) {
    const transient = res.status === 429 || res.status >= 500;
    throw new Error(
      transient
        ? `Shopify's token endpoint is unavailable (HTTP ${res.status}) after 5 tries. ` +
          `This is Shopify being busy, not your credentials — run the command again in a minute.`
        : `Could not exchange client credentials for a token (HTTP ${res.status}). ` +
          `Check the app is installed on ${cfg.store} and the id/secret are right.\n` +
          (await res.text()).slice(0, 300)
    );
  }
  const json = await res.json();
  if (!json.access_token) throw new Error('Token exchange returned no access_token.');
  TOKEN = json.access_token;
  AUTH_USED = 'client credentials';
  return TOKEN;
}

// ------------------------------------------------------------- csv parser ---

/** Minimal RFC-4180 CSV parser — quotes, embedded commas and newlines. */
function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const rows = [];
  let row = [], field = '', inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.map((r) => r.map((c) => c.trim()));
}

// ---------------------------------------------------------------- helpers ---

const num = (v) => {
  const n = String(v ?? '').replace(/[^0-9.\-]/g, '');
  return n === '' || isNaN(Number(n)) ? null : Number(n);
};
const money = (v) => { const n = num(v); return n === null ? null : n.toFixed(2); };
// Selling prices go down to a round step when config.json sets "priceList.roundDownTo"
// (10 turns 1222 into 1220 and 1238 into 1230). Unset or 0 leaves prices exact.
const roundPrice = (n) => {
  const step = Number(cfg.priceList?.roundDownTo);
  if (!(step > 0) || n < step) return n; // never round a real price down to 0
  return Math.floor(n / step + 1e-9) * step;
};
const priceMoney = (v) => { const n = num(v); return n === null ? null : roundPrice(n).toFixed(2); };
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const rxEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp'];
const VIDEO_EXT = ['.mp4', '.mov', '.m4v'];

const isVideo = (f) => VIDEO_EXT.includes(path.extname(f).toLowerCase());
const mime = (f) => ({
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v',
}[path.extname(f).toLowerCase()] || 'application/octet-stream');

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);

function metalKey(raw) {
  const s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return cfg.metals.find((m) => m.sheetCodes.map((c) => c.toUpperCase()).includes(s)) || null;
}

/** The first metal in config order — used to spot where a new item's rows begin. */
const firstMetal = () => cfg.metals[0];

const colourByCode = (code) => cfg.colours.find((c) => c.code.toUpperCase() === String(code).toUpperCase()) || null;

/**
 * Pull the item code out of a folder or file name. The renderer isn't consistent about
 * the separator or the carat suffix, so match the leading letters+digits and drop the rest:
 *   "AJNT26-33.00CTS"   -> "AJNT26"
 *   "AJER666 3.0 CTS"   -> "AJER666"
 *   "AJNT27"            -> "AJNT27"
 */
const baseCode = (code) => {
  const m = String(code).trim().match(/^([A-Za-z]+\s*\d+)/);
  return m ? m[1].replace(/\s+/g, '') : String(code).trim();
};

/** Carat weight where the folder name carries it: "AJER666 3.0 CTS" -> 3. */
const caratsFrom = (name) => {
  const m = String(name).match(/(\d+(?:\.\d+)?)\s*CTS?\b/i);
  return m ? Number(m[1]) : null;
};

// ----------------------------------------------------------- sheet parser ---

/**
 * The packing list is nested: a metal row carries Sr. + Code, and the item code sits on a
 * following sub-row in the "Item No." column. A new item begins when the metal cycle
 * restarts or all metals have been collected.
 */
function parseSheet(rows) {
  const items = [];
  let current = null;

  for (const row of rows) {
    if (!row.length) continue;

    const sr = num(row[C.sr]);
    const metal = metalKey(row[C.code]);

    if (sr !== null && metal) {
      const isFirst = metal === firstMetal();
      if (!current || isFirst || current.rows.length >= cfg.metals.length) {
        current = { code: null, rows: [], sheetLine: sr };
        items.push(current);
      }
      current.rows.push({
        metal,
        grossWt: num(row[C.metalGrossWt]),
        netWt: num(row[C.metalNetWt]),
        diamondCode: row[C.diamondCode] || '',
        diamondSize: row[C.diamondSize] || '',
        diamondPcs: num(row[C.diamondPcs]),
        diamondCts: num(row[C.diamondWt]),
        price: priceMoney(row[C.totalUsd]),
      });
      continue;
    }

    const cell = row[C.itemNo] || '';
    if (current && cell && !/^qty\s*:/i.test(cell) && !/^item\s*no/i.test(cell) && !current.code) {
      current.code = cell;
    }
  }

  return items.filter((i) => i.rows.length);
}

/**
 * Diamond and metal specs from the packing list. parseSheet keeps one stone type per
 * metal row, but multi-stone pieces list a second stone on the item-code line below it
 * (AJNT27: marquise on the metal row, pear underneath). This reads every stone line and
 * takes the 18K block for metal weight.
 */
function packingSpecs(rows) {
  const blocks = [];
  let cur = null;
  const addStone = (row) => {
    const code = String(row[C.diamondCode] || '').trim();
    if (!code) return;
    cur.stones.push({
      code, size: String(row[C.diamondSize] || '').trim(),
      pcs: num(row[C.diamondPcs]), cts: num(row[C.diamondWt]),
    });
  };
  for (const row of rows) {
    if (!row.length) continue;
    const sr = num(row[C.sr]);
    const metal = metalKey(row[C.code]);
    if (sr !== null && metal) {
      cur = { metal, netWt: num(row[C.metalNetWt]), stones: [], code: null, done: false };
      blocks.push(cur);
      addStone(row);
      continue;
    }
    if (!cur || cur.done) continue;
    // The block ends at its totals row: a metal weight with no Sr. and no metal code.
    // Stones carry on past the "Qty : 1" line, so that can't be the end marker.
    if (num(row[C.metalGrossWt]) !== null) { cur.done = true; continue; }
    const cell = String(row[C.itemNo] || '').trim();
    if (cell && !cur.code && !/^qty\s*:/i.test(cell) && !/^item\s*no/i.test(cell)) cur.code = cell;
    addStone(row);
  }

  const out = new Map();
  const is18k = (m) => /18/.test(String(m?.key || m?.sku || m?.label || ''));
  for (const b of blocks) {
    if (!b.code) continue;
    const key = baseCode(b.code).toUpperCase();
    // Stones are the same in every metal; take them from the first block. Metal weight
    // comes from the 18K block specifically.
    if (!out.has(key)) {
      out.set(key, {
        netWt: null,
        stones: b.stones,
        count: b.stones.reduce((n, x) => n + (x.pcs || 0), 0),
        cts: b.stones.reduce((n, x) => n + (x.cts || 0), 0),
      });
    }
    if (is18k(b.metal)) out.get(key).netWt = b.netWt;
  }
  return out;
}

/**
 * The flat price list: one row per SKU with a price for every metal. Simpler and more
 * complete than the packing list, but it carries no diamond specs — so the packing list
 * still wins where both have the item.
 */
function parsePriceList(file) {
  if (!file || !fs.existsSync(file)) return new Map();
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  const header = rows.shift().map((h) => h.trim());
  const col = (n) => header.indexOf(n);

  const cur = (cfg.priceList?.currency || 'USD').toUpperCase();
  const cols = {
    G18K: col(`${cur}_18K`), G14K: col(`${cur}_14K`),
    G10K: col(`${cur}_10K`), S925: col(`${cur}_Silver`),
  };
  if (Object.values(cols).some((i) => i < 0)) {
    die(`${file} has no ${cur} columns. Expected ${cur}_18K, ${cur}_14K, ${cur}_10K, ${cur}_Silver.`);
  }

  const out = new Map();
  for (const r of rows) {
    const code = baseCode(r[col('SKU')] || '');
    if (!code) continue;
    const prices = {};
    for (const [metal, i] of Object.entries(cols)) {
      const v = priceMoney(r[i]);
      if (v !== null) prices[metal] = v;
    }
    if (!Object.keys(prices).length) continue;
    out.set(code.toUpperCase(), {
      prices,
      carats: num(r[col('TotalDiamondWt')]),
      netWt: num(r[col('MetalWt18K')]),
      category: (r[col('Category')] || '').trim(),
    });
  }
  return out;
}

/** Build the same shape parseSheet produces, from a price-list row. */
function itemFromPriceList(code, entry) {
  return {
    code,
    fromPriceList: true,
    rows: cfg.metals
      .filter((m) => entry.prices[m.key] != null)
      .map((m) => ({
        metal: m,
        grossWt: null,
        netWt: m.key === 'G18K' ? entry.netWt : null,
        diamondCode: '', diamondSize: '',
        diamondPcs: null, diamondCts: entry.carats,
        price: entry.prices[m.key],
      })),
  };
}

// ------------------------------------------------------------------ media ---

/**
 * The Drive folder is the source of truth for WHAT EXISTS — the renderer uploads a folder
 * per item, and that's the signal a piece is ready to list. The packing list is only a
 * lookup for price and specs. So we walk the renders first and join the sheet to them,
 * not the other way round.
 *
 * Layout: <Render>/<CATEGORY>/<ITEM CODE>/<files>   e.g. Render/NK/AJNT63/AJNT63-Y1.png
 * Falls back to grouping loose files by their code prefix if an item has no folder.
 */
const IGNORE_PREFIXES = (cfg.ignorePrefixes || []).map((x) => String(x).toUpperCase());

function indexRenderItems(dir) {
  if (!fs.existsSync(dir)) die(`Render folder not found: ${dir}`);
  const exts = [...IMAGE_EXT, ...VIDEO_EXT];
  const isMedia = (n) => exts.includes(path.extname(n).toLowerCase());
  const items = [];

  const filesIn = (d) => {
    const out = [];
    (function walk(x) {
      for (const e of fs.readdirSync(x, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(x, e.name);
        if (e.isDirectory()) walk(full);
        else if (isMedia(e.name)) out.push(full);
      }
    })(d);
    return out;
  };

  for (const cat of fs.readdirSync(dir, { withFileTypes: true })) {
    if (cat.name.startsWith('.') || !cat.isDirectory()) continue;
    const catDir = path.join(dir, cat.name);

    for (const entry of fs.readdirSync(catDir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      // Folders from other designers, with their own naming, are skipped outright rather
      // than reported as broken every run. Set "ignorePrefixes" in config.json.
      // "includeCodes" is the escape hatch: a single code from an otherwise-ignored
      // prefix, so one item can be trialled without un-ignoring the whole supplier.
      const KEEP = (cfg.includeCodes || []).map((x) => String(x).toUpperCase());
      const kept = KEEP.includes(baseCode(entry.name).toUpperCase());
      if (!kept && IGNORE_PREFIXES.some((x) => entry.name.toUpperCase().startsWith(x))) continue;
      if (entry.isDirectory()) {
        const files = filesIn(path.join(catDir, entry.name));
        if (files.length) items.push({ code: entry.name, category: cat.name, files });
      }
    }

    // loose files sitting directly in the category folder
    const loose = fs.readdirSync(catDir, { withFileTypes: true })
      .filter((e) => e.isFile() && isMedia(e.name))
      .map((e) => path.join(catDir, e.name));
    for (const f of loose) {
      const m = path.basename(f).match(/^([A-Za-z]+\d+)/);
      if (!m) continue;
      let it = items.find((i) => i.category === cat.name && baseCode(i.code).toUpperCase() === m[1].toUpperCase());
      if (!it) { it = { code: m[1], category: cat.name, files: [] }; items.push(it); }
      it.files.push(f);
    }
  }

  return items.sort((a, z) => a.category.localeCompare(z.category) || a.code.localeCompare(z.code, undefined, { numeric: true }));
}

function indexMedia(dir) {
  if (!fs.existsSync(dir)) die(`Render folder not found: ${dir}`);
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if ([...IMAGE_EXT, ...VIDEO_EXT].includes(path.extname(e.name).toLowerCase())) files.push(full);
    }
  })(dir);
  return files;
}

/**
 * Group an item's files by colour.
 *
 * A file belongs to the item when its name starts with the item code and the next
 * character isn't a digit (so AJLB26 never swallows AJLB260). The colour and sequence
 * come from the tail: AJLB26-R1.png -> R, 1;  AJLB20-12CT-Y3.png -> Y, 3.
 *
 * Returns { R: {images:[], videos:[]}, W: {...}, Y: {...} } — only colours that exist.
 */
function mediaForItem(allFiles, code) {
  const base = baseCode(code);
  const codeRx = new RegExp(`^${rxEsc(base)}(?![0-9])`, 'i');
  const tailRx = new RegExp(`-(${cfg.colours.map((c) => rxEsc(c.code)).join('|')})\\s*(\\d+)?$`, 'i');

  const out = {};
  for (const file of allFiles) {
    const stem = path.basename(file, path.extname(file));
    if (!codeRx.test(stem)) continue;

    const m = stem.match(tailRx);
    if (!m) continue;
    const colour = colourByCode(m[1]);
    if (!colour) continue;

    const bucket = (out[colour.code] ||= { images: [], videos: [], colour });
    (isVideo(file) ? bucket.videos : bucket.images).push({ file, seq: Number(m[2] || 0) });
  }

  for (const b of Object.values(out)) {
    const bySeq = (a, z) => a.seq - z.seq;
    b.images = b.images.sort(bySeq).slice(0, cfg.media.maxImagesPerColour).map((x) => x.file);
    b.videos = b.videos.sort(bySeq).slice(0, cfg.media.maxVideosPerColour).map((x) => x.file);
  }
  return out;
}

/**
 * Shopify appends _1, _2 … when the same filename is uploaded twice, so two media rows
 * that normalise to the same stem are the same render uploaded more than once.
 */
const UUID_TAIL = /_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_TAIL = /_[0-9a-f]{32}$/i;

const normStem = (stem) => {
  // Shopify keeps the original name but appends a UUID when that name is already in the
  // Files library, so "AJLB130-Y1_a23f8182-…" and "AJLB130-Y1" are the same render.
  let t = String(stem).toLowerCase().trim()
    .replace(UUID_TAIL, '').replace(HEX_TAIL, '').replace(/_\d+$/, '');
  // Also "AJLB52-W1-1" → "AJLB52-W1", but only when what's left still ends in a colour
  // tail, so a real "-2" sequence number is never mistaken for a copy suffix.
  const cut = t.replace(/-\d+$/, '');
  if (cut !== t && /-[a-z]\d*$/.test(cut)) t = cut;
  return t;
};

/** Which colour a render filename belongs to, from its -R / -W / -Y tail. */
function colourFromStem(stem) {
  const tail = new RegExp(`-(${cfg.colours.map((c) => rxEsc(c.code)).join('|')})\\s*\\d*$`, 'i');
  const m = normStem(stem).match(tail);
  return m ? colourByCode(m[1]) : null;
}

/**
 * Alt text for a render. The storefront theme reads this to decide which images belong to
 * which material variant, so the configured tag must match the theme code exactly.
 * `altSuffix` appends the product title for SEO — only safe if the theme does a
 * "contains" match rather than an exact one.
 */
function altTextFor(colour, title) {
  if (!colour.altText) return `${title} — ${colour.label}`;
  return cfg.media.altSuffix ? `${colour.altText} ${title}` : colour.altText;
}

/** Turn the packing list's diamond codes into words the copywriter can use. */
const CUT_NAMES = {
  DRDLBG: 'round brilliant', DMQLBG: 'marquise', DPELBG: 'pear', DOVLBG: 'oval',
  DEDLBG: 'emerald', DASLBG: 'asscher', DHTLBG: 'heart', DBGLBG: 'baguette',
};
const cutWords = (raw) => String(raw || '')
  .split('/')
  .map((c) => CUT_NAMES[c.trim().toUpperCase()] || null)
  .filter(Boolean)
  .join(' and ') || null;

/** The facts describe.js should treat as true, drawn from the packing list. */
function sheetFacts(item, plan) {
  const r = item.rows?.[0];
  if (!r || item.needsPrice) return null;
  return {
    carats: r.diamondCts || null,
    diamondCut: cutWords(r.diamondCode),
    diamondSize: r.diamondSize || null,
    diamondPcs: r.diamondPcs || null,
    netWt: r.netWt || null,
    metals: plan?.materials?.length ? [...new Set(plan.materials.map((m) => m.label))].join(', ') : null,
  };
}

/**
 * Stone shape, jewellery type and setting style, read out of the title.
 *
 * Titles are written to a fixed shape ("2.29 CTW Pear Cut Lab-Grown Diamond Twist
 * Engagement Ring"), so the facets can be derived rather than maintained by hand —
 * which means they stay right when a title is edited.
 */
const SHAPES = [
  ['round brilliant', 'Round'], ['round', 'Round'], ['princess', 'Princess'], ['radiant', 'Radiant'],
  ['marquise', 'Marquise'], ['emerald', 'Emerald'], ['asscher', 'Asscher'],
  ['cushion', 'Cushion'], ['oval', 'Oval'], ['pear', 'Pear'], ['heart', 'Heart'],
  ['baguette', 'Baguette'], ['mixed cut', 'Mixed'], ['mixed-cut', 'Mixed'],
];
const TYPES = [
  ['huggie hoop earrings', 'Huggie Hoops'], ['hoop earrings', 'Hoops'],
  ['stud earrings', 'Studs'], ['drop earrings', 'Drops'], ['earrings', 'Earrings'],
  ['engagement ring', 'Engagement Ring'], ['eternity ring', 'Eternity Ring'],
  ['band ring', 'Band'], ['ring', 'Ring'],
  ['tennis bracelet', 'Tennis Bracelet'], ['bracelet', 'Bracelet'],
  ['tennis necklace', 'Tennis Necklace'], ['station necklace', 'Station Necklace'],
  ['riviera necklace', 'Riviera Necklace'], ['necklace', 'Necklace'],
  ['pendant', 'Pendant'],
  // Singular fallbacks, checked last — catches titles written "Stud" or "Hoop".
  ['stud', 'Studs'], ['huggie', 'Huggie Hoops'], ['hoop', 'Hoops'], ['drop', 'Drops'], ['earring', 'Earrings'],
];
const STYLES = [
  ['solitaire', 'Solitaire'], ['three stone', 'Three Stone'], ['toi et moi', 'Toi et Moi'],
  ['infinity', 'Infinity'], ['cross', 'Cross'], ['two stone', 'Two Stone'],
  ['double row', 'Double Row'], ['milgrain', 'Milgrain'],
  ['halo', 'Halo'], ['cluster', 'Cluster'], ['rope', 'Rope'], ['twist', 'Twist'], ['pavé', 'Pavé'],
  ['pave', 'Pavé'], ['eternity', 'Eternity'], ['station', 'Station'],
  ['fringe', 'Fringe'], ['statement', 'Statement'], ['riviera', 'Riviera'],
  ['two-stone', 'Two Stone'], ['cuban link', 'Cuban Link'],
  // Shapes the pendant itself is cut into, rather than settings. Multi-word first,
  // because firstMatch stops at the earliest entry that matches.
  ['evil eye', 'Evil Eye'], ['toi et moi', 'Toi et Moi'],
  ['clover', 'Clover'], ['smile', 'Smile'], ['initial', 'Initial'],
  ['bezel', 'Bezel'], ['star', 'Star'], ['key', 'Key'], ['bar', 'Bar'], ['tag', 'Tag'],
  ['bangle', 'Bangle'], ['flower', 'Flower'],
];

/**
 * Whole-word match only. Plain includes() made "Fringe" match "ring", which typed a
 * necklace as a ring. \b won't do — needles like "pavé" end in a non-word character.
 */
const wordAt = (t, needle) => {
  const rx = new RegExp(`(?<![a-z0-9])${rxEsc(needle)}(?![a-z0-9])`, 'i');
  const m = rx.exec(t);
  return m ? m.index : -1;
};

const firstMatch = (title, table) => {
  const t = title.toLowerCase();
  for (const [needle, label] of table) if (wordAt(t, needle) !== -1) return label;
  return null;
};

/** Every distinct shape named in the title — a toi et moi has two. */
function allShapes(title) {
  const t = title.toLowerCase();
  const found = new Map();                      // label -> first position in the title
  for (const [needle, label] of SHAPES) {
    const at = wordAt(t, needle);
    if (at === -1) continue;
    if (!found.has(label) || at < found.get(label)) found.set(label, at);
  }
  // In the order the title names them: "Pear & Emerald" stays Pear first.
  return [...found.entries()].sort((a, z) => a[1] - z[1]).map(([label]) => label);
}

function facetsFor(title) {
  const shapes = allShapes(title);
  return {
    shapes,
    shape: shapes[0] || null,
    type: firstMatch(title, TYPES),
    style: firstMatch(title, STYLES),
  };
}

/** Facets as tags, which is what most themes filter on. */
function facetTags(title) {
  const f = facetsFor(title);
  const pre = cfg.facets?.tagPrefixes || { shape: 'Shape', type: 'Type', style: 'Style' };
  return [
    ...f.shapes.map((s) => `${pre.shape}:${s}`),
    f.type ? `${pre.type}:${f.type}` : null,
    f.style ? `${pre.style}:${f.style}` : null,
  ].filter(Boolean);
}

// ---------------------------------------------------------------- content ---

let CONTENT = cfg.contentFile && fs.existsSync(cfg.contentFile)
  ? JSON.parse(fs.readFileSync(cfg.contentFile, 'utf8'))
  : {};

const contentFor = (item) => CONTENT[baseCode(item.code)] || CONTENT[item.code] || null;

/**
 * Diamond and metal details per item code. Written by hand (or by Claude from the CAD
 * sheets) into product-specs.json; anything missing falls back to the price sheet, which
 * carries 18K metal weight and total diamond weight for every priced item.
 *
 *   "AJPD411": {
 *     "metalWeight18k": 2.85,          // grams, 18K
 *     "totalCarat": 1.2,
 *     "stones": [
 *       { "role": "Centre", "count": 1, "shape": "Marquise", "size": "10 x 5 mm", "carat": 1.0 },
 *       { "role": "Halo",   "count": 22, "shape": "Round",   "size": "1.1 mm",    "carat": 0.2 }
 *     ]
 *   }
 */
let PRICE_LIST_GLOBAL = new Map();
let PACKING_SPECS = new Map();
const SPECS_FILE = cfg.specsFile || './product-specs.json';
const SPECS = fs.existsSync(SPECS_FILE) ? JSON.parse(fs.readFileSync(SPECS_FILE, 'utf8')) : {};

const fmtNum = (n) => {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return String(Math.round(x * 100) / 100);
};

function specsFor(code) {
  const c = String(code).toUpperCase();
  const own = SPECS[c] || SPECS[code] || {};
  const pl = PRICE_LIST_GLOBAL.get(c) || {};
  const pk = PACKING_SPECS.get(c) || {};
  const def = cfg.specDefaults || {};

  // Stone sizes: only ones given in millimetres ("4.00x2.00"). Round-stone sieve ranges
  // like "20.5-21" aren't millimetres, so they're left out rather than mislabelled.
  const mm = (pk.stones || [])
    .filter((x) => /\d\s*x\s*\d/i.test(x.size))
    .map((x) => {
      const cut = (CUT_NAMES[String(x.code).toUpperCase()] || '').replace(/\b\w/g, (m) => m.toUpperCase());
      const dims = x.size.split(/\s*x\s*/i).map((v) => String(Number(v))).join(' x ');
      return { cut, dims };
    });
  const uniq = [...new Map(mm.map((x) => [x.cut + x.dims, x])).values()];
  const measurement = !uniq.length ? null
    : uniq.length === 1 ? `${uniq[0].dims} mm each`
    : uniq.map((x) => `${x.cut} ${x.dims} mm`).join(', ');

  return {
    shape: own.shape || null,
    totalCarat: own.totalCarat ?? (pk.cts || pl.carats || null),
    color: own.color || def.color || null,
    clarity: own.clarity || def.clarity || null,
    // The unfilled versions, so a hand-written value in the description can sit between
    // a real CAD figure and the config default instead of being outranked by it.
    ownColor: own.color || null,
    ownClarity: own.clarity || null,
    measurement: own.measurement || measurement,
    size: own.size || null,
    style: own.style || null,
    diamondCount: own.diamondCount ?? (pk.count || null),
    metalWeight18k: own.metalWeight18k ?? pk.netWt ?? pl.netWt ?? null,
    // From a CAD sheet: { "18K": 1.7, "14K": 1.5, "Silver": 1.3 } — beats the single 18K figure.
    metalWeights: own.metalWeights && typeof own.metalWeights === 'object' ? own.metalWeights : null,
    metalWeightNote: own.metalWeightNote || null,
  };
}

/** "Round" -> "Round Brilliant Cut", ["Pear","Emerald"] -> "Pear & Emerald Cut". */
function shapeLabel(shapes) {
  if (!shapes.length) return null;
  if (shapes.length === 1) return shapes[0] === 'Round' ? 'Round Brilliant Cut' : `${shapes[0]} Cut`;
  return `${shapes.join(' & ')} Cut`;
}

/** "Solitaire" + "Engagement Ring" -> "Solitaire Engagement Ring"; no doubled words. */
function styleLabel(f) {
  if (!f.type) return f.style || null;
  if (!f.style || f.type.toLowerCase().includes(f.style.toLowerCase())) return f.type;
  return `${f.style} ${f.type}`;
}

const SPEC_MARK = '<li>Shape:';
const SPEC_MARK_OLD = '→ Shape:';   // the arrow format, so old blocks are still recognised

/**
 * Chain length by item-code prefix, from config.json:
 *   "chainLength": { "AJPD": "18 inch" }
 * Longest prefix wins, so a single code can override its whole category.
 */
function chainLengthFor(code) {
  const table = cfg.chainLength || {};
  const c = String(code || '').toUpperCase();
  let best = null;
  for (const [prefix, value] of Object.entries(table)) {
    const px = prefix.toUpperCase();
    if (!c.startsWith(px)) continue;
    if (!best || px.length > best[0].length) best = [px, value];
  }
  return best ? best[1] : null;
}

/**
 * Values a human wrote into the description by hand, before this script existed:
 * a "Diamond Details" list, a "Necklace Length" line, stone size in the opening
 * paragraph. They are the only record of colour, clarity and length for some products,
 * so they are read out and folded into the generated block rather than deleted.
 */
function legacySpecs(html) {
  const body = String(html || '')
    .replace(/<li>/gi, '\n• ')
    .replace(/<\/?(p|ul|ol|br|div|h\d|strong|em|b|i|span)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ');
  // Only the hand-written part — our own block must not be read back as a source.
  const cut = body.search(/KEY FEATURES|Shape:\s/i);
  const src = cut === -1 ? body : body.slice(0, cut);
  const grab = (rx) => { const m = rx.exec(src); return m ? m[1].trim() : null; };
  return {
    color: grab(/Colou?r:\s*([A-Z][A-Z0-9\-\/ ]{0,12}?)\s*(?:\n|$)/i),
    clarity: grab(/Clarity:\s*([A-Z0-9\-,\/ ]{2,16}?)\s*(?:\n|$)/i),
    diamondCount: grab(/(\d+)\s+Diamonds\b/i),
    stoneSize: grab(/([\d.]+\s*mm)[^\n]{0,24}Stones?/i),
    totalCarat: grab(/([\d.]+)\s*Carat Total Weight/i),
    length: grab(/(?:Necklace|Bracelet|Chain)?\s*Length:\s*([^\n]{2,28})/i)
         || grab(/Measures\s+([\d.]+\s*(?:inch|inches|cm)[^.\n]{0,18})/i),
  };
}

/** Cut the hand-written spec sections out, keeping the opening paragraphs. */
function stripLegacyBlocks(html) {
  let h = String(html || '');
  // Shopify's rich-text editor writes <p dir="ltr"> and <ul dir="ltr">, so every tag
  // here has to tolerate attributes — matching bare <p> silently removed nothing.
  const inP = '(?:(?!<\\/p>)[\\s\\S])';

  // "Diamond Details" / "Specifications" heading plus the list that follows it
  h = h.replace(
    new RegExp(`<p[^>]*>\\s*(?:<strong>)?\\s*(?:Diamond\\s*Details|Specifications)\\s*:?\\s*(?:<\\/strong>)?\\s*<\\/p>\\s*(?:<ul[^>]*>[\\s\\S]*?<\\/ul>)?`, 'gi'),
    ''
  );

  // A short paragraph whose only job is a length line. Bounded so it can never swallow
  // a body paragraph that happens to mention length in passing.
  h = h.replace(new RegExp(`<p[^>]*>${inP}{0,60}Length\\s*:${inP}{0,60}<\\/p>`, 'gi'), '');

  return h.replace(/(\s*<p[^>]*>(?:\s|&nbsp;|<br\s*\/?>)*<\/p>)+/gi, '').trimEnd();
}

/**
 * "Metal Weight: Silver 0.75 g, 14K 0.9 g, 18K 1 g", lightest karat first.
 * config.json "showMetalWeight": true (always) | false (never) | "multi" (only when the
 * sheet gives two or more metals, so one metal's weight is never shown as if it were all).
 */
const METAL_ORDER = ['silver', '925', '9k', '10k', '14k', '18k', '22k', 'platinum'];
function metalWeightLine(sp) {
  const mode = cfg.showMetalWeight;
  const w = sp.metalWeights;
  if (mode === false || mode == null || !w) return null;
  const keys = Object.keys(w);
  if (!keys.length) return null;
  if (mode === 'multi' && keys.length < 2) return null;
  const rank = (k) => {
    const i = METAL_ORDER.findIndex((m) => String(k).toLowerCase().includes(m));
    return i === -1 ? METAL_ORDER.length : i;
  };
  const text = keys.sort((a, z) => rank(a) - rank(z))
    .map((m) => `${m} ${fmtNum(w[m])} g`).join(', ');
  return text + (sp.metalWeightNote ? ` (${sp.metalWeightNote})` : '');
}

/** NECKLACE or BRACELET for a code, by prefix first and then by title. */
let PRICE_LIST = null;   // set in main() once the sheet is parsed
const CATEGORY_WARNED = new Set();

function categoryOfCode(code, title) {
  const c = String(code).toUpperCase();
  // The code prefix is the reliable signal. The price sheet's Category column is filled in
  // by hand and gets AJNT65 wrong — an NT code, titled a necklace, sat in the bracelet block
  // and labelled BRACELET. So prefix wins, but say so when the sheet disagrees rather than
  // picking one silently: a wrong category means the wrong lengths and the wrong base price.
  const fromPrefix = /^AJLB/.test(c) ? 'BRACELET' : (/^AJ(NT|PD)/.test(c) ? 'NECKLACE' : null);
  const declared = String((PRICE_LIST ? PRICE_LIST.get(c) : null)?.category || '').trim().toUpperCase();
  if (fromPrefix && (declared === 'BRACELET' || declared === 'NECKLACE') && declared !== fromPrefix
      && !CATEGORY_WARNED.has(c)) {
    CATEGORY_WARNED.add(c);
    console.log(`  ⚠ ${c}: price-list.csv says ${declared}, the code says ${fromPrefix} — using ${fromPrefix}. Fix the sheet if that's wrong.`);
  }
  if (fromPrefix) return fromPrefix;
  if (declared === 'BRACELET' || declared === 'NECKLACE') return declared;
  const t = String(title || CONTENT?.[c]?.title || '').toLowerCase();
  if (/bracelet|bangle|anklet/.test(t)) return 'BRACELET';
  if (/necklace|pendant|choker/.test(t)) return 'NECKLACE';
  return null;
}

/** Dollars to add for a length, from the flat per-inch rate. 0 when it cannot be worked out. */
function lengthDeltaFor(cat, len) {
  const rate = Number(cfg.lengthPricePerInch);
  const base = (cfg.lengthBase || {})[cat];
  if (!Number.isFinite(rate) || !base) return 0;
  const num = (x) => { const m = /([\d.]+)/.exec(String(x)); return m ? Number(m[1]) : null; };
  const a = num(len), b = num(base);
  if (a == null || b == null) return 0;
  return (a - b) * rate;
}

/**
 * The config.json "bangles" settings when this code is a bangle, otherwise null. A bangle
 * is rigid and sized by inside diameter, so it gets its own Size option instead of the
 * bracelet chain lengths.
 */
function bangleFor(code) {
  const b = cfg.bangles;
  if (!b || !Array.isArray(b.sizes) || !b.sizes.length) return null;
  const c = String(code).toUpperCase();
  return (b.codes || []).some((x) => String(x).toUpperCase() === c) ? b : null;
}

/** One bangle size's price: the metal's base price plus that size's percentage, rounded like every other price. */
function banglePrice(base, size) {
  return roundPrice(base * (1 + (Number(size.surchargePct) || 0) / 100));
}

/** A variant's value for one option, from the index's "Material=… | Size=…" string. */
function variantOption(v, name) {
  const raw = String(v.options || '').split(' | ')
    .find((x) => x.split('=')[0].trim().toLowerCase() === String(name).trim().toLowerCase());
  return raw ? raw.slice(raw.indexOf('=') + 1).trim() : '';
}

function specsHtml(code, title, existingHtml) {
  const sp = specsFor(code);
  const lg = legacySpecs(existingHtml);
  const f = facetsFor(String(title || CONTENT?.[code]?.title || ''));
  const rows = [
    ['Shape', sp.shape || shapeLabel(f.shapes)],
    ['Carat', sp.totalCarat ? `${fmtNum(sp.totalCarat)} CTW`
      : lg.totalCarat ? `${fmtNum(Number(lg.totalCarat))} CTW` : null],
    // The product's own stated grade beats the config default — defaults are a
    // fallback for products that never had one, not an overwrite.
    ['Color', sp.ownColor || lg.color || (cfg.specDefaults || {}).color || null],
    ['Clarity', sp.ownClarity || lg.clarity || (cfg.specDefaults || {}).clarity || null],
    ['Measurement', sp.measurement || lg.stoneSize],
    ['Size', sp.size || null],
    ['Diamonds', sp.diamondCount ? `${sp.diamondCount}` : (lg.diamondCount || null)],
    ['Metal', (cfg.specDefaults || {}).metal || null],
    // A single metal's weight is misleading when the product sells in ten, so "multi"
    // shows the row only where the sheet covers more than one.
    ['Metal Weight', metalWeightLine(sp)],
    // Chain length is the same for a whole category, so it comes from config by code
    // prefix rather than from the CAD sheets. A per-item override in product-specs.json
    // still wins.
    ...(lg.length
      ? [['Length', lg.length]]
      : [['Chain', sp.chain || chainLengthFor(code)]]),
    ['Style', sp.style || styleLabel(f)],
  ].filter(([, v]) => v);
  // Shape leads every block and is what re-runs look for, so without it there's no block.
  if (!rows.length || rows[0][0] !== 'Shape') return '';
  return '<ul>' + rows.map(([k, v]) => `<li>${k}: ${esc(v)}</li>`).join('') + '</ul>';
}

/** Remove any spec block we added earlier, so re-runs replace rather than stack. */
function stripSpecs(html) {
  let h = stripLegacyBlocks(html);
  const legacy = h.indexOf('<p><strong>Specifications</strong></p>');
  if (legacy !== -1) h = h.slice(0, legacy);

  for (const mark of [SPEC_MARK, SPEC_MARK_OLD]) {
    const at = h.indexOf(mark);
    if (at === -1) continue;
    // Cut from the start of the block: its <ul> or <p>, and the Key Features heading
    // above it when that heading belongs to this block rather than to real bullets.
    const open = Math.max(h.lastIndexOf('<ul', at), h.lastIndexOf('<p', at));
    let cut = open === -1 ? at : open;
    // …and so did the walk back to the Key Features heading.
    const head = h.slice(0, cut);
    const kfm = [...head.matchAll(/<p[^>]*>\s*(?:<strong>)?\s*key features/gi)];
    const kf = kfm.length ? kfm[kfm.length - 1].index : -1;
    if (kf !== -1 && !h.slice(kf, cut).includes('</ul>')) cut = kf;
    h = h.slice(0, cut);
  }
  return h.trimEnd();
}

/**
 * The spec lines replace the Key Features bullets rather than repeating them underneath:
 * Description heading, the two paragraphs, then Key Features: with the \u2192 lines.
 */
/**
 * The line above the spec list. config.json "specHeading": "" removes it entirely and
 * the list simply follows the body copy.
 */
function specHeadingHtml() {
  const t = cfg.specHeading === undefined ? 'Key Features:' : cfg.specHeading;
  return t ? `<p><strong>${esc(t)}</strong></p>` : '';
}

function composeDescription(baseHtml, block) {
  // "specs-only" in config.json drops the prose entirely and leaves just the spec list.
  if ((cfg.descriptionStyle || 'full') === 'specs-only') {
    return block ? specHeadingHtml() + block : '';
  }
  let h = stripSpecs(baseHtml);
  if (!block) return h;
  h = h.replace(/<p[^>]*>\s*(?:<strong>)?\s*Key Features:?\s*(?:<\/strong>)?\s*<\/p>\s*<ul[^>]*>[\s\S]*?<\/ul>/i, '').trimEnd();
  return h + specHeadingHtml() + block;
}


const buildTitle = (item) =>
  contentFor(item)?.title || cfg.defaults.untitledTitle || 'Untitled — description needed';

function buildDescription(item) {
  const authored = contentFor(item)?.description;
  if (authored) return composeDescription(authored, specsHtml(baseCode(item.code), buildTitle(item)));

  // No authored copy yet (a render with no packing-list row). Keep it minimal and
  // obviously unfinished rather than padding it out with empty spec rows.
  return `<p>${esc(buildTitle(item))}</p>`;
}

// --------------------------------------------------------------- graphql ---

async function gql(query, variables = {}, attempt = 0) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': TOKEN },
    body: JSON.stringify({ query, variables }),
  });

  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    return gql(query, variables, attempt + 1);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors).slice(0, 400));

  const throttle = json.extensions?.cost?.throttleStatus;
  if (throttle && throttle.currentlyAvailable < 200) await new Promise((r) => setTimeout(r, 1200));

  return json.data;
}

function checkErrors(payload, label) {
  const errs = payload?.userErrors || payload?.mediaUserErrors || [];
  if (errs.length) throw new Error(`${label}: ${errs.map((e) => `${(e.field || []).join('.')} ${e.message}`).join('; ')}`);
}

// ----------------------------------------------------------- shopify ops ---

/** Find a collection by its exact title. Cached. */
const collectionCache = new Map();

/**
 * Product metafields that point at a metaobject, with the metaobject's type resolved.
 * Shopify's own taxonomy metafields (shopify.stone-shape and friends) don't show up under
 * metaobjectDefinitions, so the type has to come from the definition's validations.
 */
async function refMetafieldDefs() {
  const d = await gql(
    `{ metafieldDefinitions(ownerType: PRODUCT, first: 100) {
         nodes { namespace key name type { name } validations { name value } }
       } }`
  );
  const out = [];
  for (const n of d.metafieldDefinitions?.nodes || []) {
    if (!/metaobject_reference/.test(n.type.name)) continue;
    const v = (n.validations || []).find((x) => /metaobject_definition/i.test(x.name));
    let moType = null, why = null;
    if (v?.value) {
      try {
        const r = await gql(`query($id: ID!) { metaobjectDefinition(id: $id) { type } }`, { id: v.value });
        moType = r.metaobjectDefinition?.type || null;
        if (!moType) why = `definition came back empty  [id ${v.value}]`;
      } catch (e) { why = e.message.slice(0, 90); }
      if (why) why += `  [id ${v.value}]`;
    } else {
      why = 'the definition carries no metaobject_definition validation';
    }
    out.push({ namespace: n.namespace, key: n.key, name: n.name, type: n.type.name, moType, why });
  }
  return out;
}

async function metaobjectEntries(type) {
  try {
    const e = await gql(
      `query($t: String!) { metaobjects(type: $t, first: 250) { nodes { id handle displayName } } }`,
      { t: type }
    );
    return e.metaobjects?.nodes || [];
  } catch { return []; }
}

async function resolveCollection(title, create = false) {
  if (collectionCache.has(title)) return collectionCache.get(title);
  const data = await gql(
    `query($q: String!) { collections(first: 20, query: $q) { nodes { id title } } }`,
    { q: `title:'${String(title).replace(/'/g, "\\'")}'` }
  );
  let hit = (data.collections?.nodes || []).find((c) => c.title.toLowerCase() === title.toLowerCase())
    || data.collections?.nodes?.[0] || null;

  // A collection named in config but missing from the store is almost always one that
  // simply hasn't been made yet, so make it — a plain manual collection, no rules.
  if (!hit && create) {
    const d = await gql(
      `mutation($input: CollectionInput!) {
         collectionCreate(input: $input) { collection { id title } userErrors { field message } }
       }`,
      { input: { title } }
    );
    checkErrors(d.collectionCreate, 'collectionCreate');
    hit = d.collectionCreate?.collection || null;
    if (hit) console.log(`+ ${title.padEnd(18)} collection created`);
  }

  collectionCache.set(title, hit);
  return hit;
}

/**
 * Facet collections: "Pear Cut Bracelets", "Halo Necklaces", "Stud Earrings". Built from
 * the product's own shape / style / type and the category collection it already belongs
 * to. Nothing here is ever created — a name that doesn't exist in the store is skipped,
 * so these follow whatever collections you've actually made.
 */
function facetCollectionsFor(title, base) {
  if (!base) return [];
  const f = facetsFor(String(title || ''));
  const singular = base.replace(/s$/, '');
  const out = [];

  for (const shape of f.shapes) out.push(`${shape} Cut ${base}`);
  if (f.style) out.push(`${f.style} ${base}`);
  if (f.type) {
    // "Tennis Bracelet" -> "Tennis Bracelets"; "Studs" -> "Stud Earrings".
    out.push(f.type.endsWith(singular) ? `${f.type}s` : `${f.type.replace(/s$/, '')} ${base}`);
  }
  return [...new Set(out)];
}

/** Which collection titles this item code belongs in, from config. */
function collectionsFor(code) {
  const prefix = Object.keys(cfg.collections || {})
    .sort((a, z) => z.length - a.length)
    .find((p) => code.toUpperCase().startsWith(p.toUpperCase()));
  const named = prefix ? cfg.collections[prefix] : [];
  return [...(cfg.defaults.alwaysCollections || []), ...(Array.isArray(named) ? named : [named])].filter(Boolean);
}

/**
 * Shopify's product Category comes from its own taxonomy, so it has to be looked up by
 * name rather than set as free text. Cached — the same few categories repeat all run.
 */
const categoryCache = new Map();

async function resolveCategory(code) {
  const prefix = Object.keys(cfg.categories || {})
    .sort((a, z) => z.length - a.length)
    .find((p) => code.toUpperCase().startsWith(p.toUpperCase()));
  if (!prefix) return null;

  const name = cfg.categories[prefix];
  if (categoryCache.has(name)) return categoryCache.get(name);

  let hit = null;
  try {
    const data = await gql(
      `query($q: String!) {
         taxonomy { categories(first: 20, search: $q) { nodes { id name fullName } } }
       }`,
      { q: name }
    );
    const nodes = data.taxonomy?.categories?.nodes || [];
    // Prefer an exact name inside Jewelry, so "Rings" doesn't match "Napkin Rings".
    hit = nodes.find((n) => /jewelry/i.test(n.fullName) && n.name.toLowerCase() === name.toLowerCase())
       || nodes.find((n) => /jewelry/i.test(n.fullName))
       || null;
  } catch (e) {
    console.log(`  (category lookup failed: ${e.message.slice(0, 80)})`);
  }
  categoryCache.set(name, hit);
  return hit;
}

/**
 * Look for an item that's already in the store — including products added by hand before
 * this script existed, which won't carry our SKUs. Checks, in order of confidence:
 *   1. a variant SKU we would have created
 *   2. a product tagged with the item code
 *   3. the item code appearing in a product title or handle
 * Returns { product, matchedBy } or null.
 */
async function findExisting(code, sku) {
  const q = (s) => String(s).replace(/'/g, "\\'");

  const bySku = await gql(
    `query($q: String!) { productVariants(first: 1, query: $q) { nodes { product { id title } } } }`,
    { q: `sku:'${q(sku)}'` }
  );
  if (bySku.productVariants.nodes[0]) {
    return { product: bySku.productVariants.nodes[0].product, matchedBy: 'SKU' };
  }

  const byCode = await gql(
    `query($q: String!) { products(first: 5, query: $q) { nodes { id title handle tags } } }`,
    { q: `tag:'${q(code)}' OR title:'${q(code)}' OR handle:'${q(code)}'` }
  );

  const rx = new RegExp(`(^|[^A-Z0-9])${rxEsc(code)}([^0-9]|$)`, 'i');
  for (const p of byCode.products.nodes) {
    if (p.tags?.some((t) => t.toUpperCase() === code.toUpperCase())) return { product: p, matchedBy: 'tag' };
    if (rx.test(p.title)) return { product: p, matchedBy: 'title' };
    if (rx.test(p.handle.replace(/-/g, ' '))) return { product: p, matchedBy: 'handle' };
  }
  return null;
}

async function createProduct(item, plan) {
  const input = {
    title: buildTitle(item),
    descriptionHtml: buildDescription(item),
    vendor: cfg.defaults.vendor,
    productType: cfg.defaults.productType,
    status: item.needsPrice ? 'DRAFT' : cfg.defaults.status,
    tags: [
      ...cfg.defaults.tags,
      ...(cfg.facets?.asTags === false ? [] : facetTags(buildTitle(item))),
      ...(cfg.defaults.tagItemCode === false ? [] : [baseCode(item.code)]),
      ...(item.needsPrice ? [cfg.defaults.missingPriceTag || 'needs-price'] : []),
    ],
    productOptions: [
      { name: cfg.optionName, values: plan.materials.map((m) => ({ name: m.label })) },
    ],
  };

  const cat = await resolveCategory(baseCode(item.code));
  if (cat) input.category = cat.id;

  const data = await gql(
    `mutation($input: ProductInput!) {
       productCreate(input: $input) { product { id title } userErrors { field message } }
     }`,
    { input }
  );
  checkErrors(data.productCreate, 'productCreate');
  return data.productCreate.product;
}

async function stageUpload(file) {
  const filename = path.basename(file);
  const size = fs.statSync(file).size;
  const video = isVideo(file);

  const data = await gql(
    `mutation($input: [StagedUploadInput!]!) {
       stagedUploadsCreate(input: $input) {
         stagedTargets { url resourceUrl parameters { name value } }
         userErrors { field message }
       }
     }`,
    { input: [{ filename, mimeType: mime(file), httpMethod: 'POST', resource: video ? 'VIDEO' : 'IMAGE', fileSize: String(size) }] }
  );
  checkErrors(data.stagedUploadsCreate, 'stagedUploadsCreate');

  const target = data.stagedUploadsCreate.stagedTargets[0];
  const form = new FormData();
  for (const p of target.parameters) form.append(p.name, p.value);
  form.append('file', new Blob([fs.readFileSync(file)], { type: mime(file) }), filename);

  const up = await fetch(target.url, { method: 'POST', body: form });
  if (!up.ok) throw new Error(`Upload failed for ${filename}: HTTP ${up.status}`);
  return target.resourceUrl;
}

/**
 * Uploads every colour's media in the product's colour order, so the gallery reads
 * Rose 1-5, White 1-5, Yellow 1-5. Returns colour code -> first image media id,
 * used to set each variant's featured image.
 */
async function attachMedia(product, plan, media, title, onProgress) {
  const featured = {};
  let count = 0;

  for (const colour of plan.colours) {
    const bucket = media[colour.code];
    const files = [...bucket.images, ...(WITH_VIDEO ? bucket.videos : [])];

    for (const file of files) {
      const source = await stageUpload(file);
      const data = await gql(
        `mutation($productId: ID!, $media: [CreateMediaInput!]!) {
           productCreateMedia(productId: $productId, media: $media) {
             media { ... on MediaImage { id } ... on Video { id } }
             mediaUserErrors { field message }
           }
         }`,
        {
          productId: product.id,
          media: [{
            originalSource: source,
            mediaContentType: isVideo(file) ? 'VIDEO' : 'IMAGE',
            alt: altTextFor(colour, title),
          }],
        }
      );
      checkErrors(data.productCreateMedia, 'productCreateMedia');

      const id = data.productCreateMedia.media[0]?.id;
      if (!isVideo(file) && id && !featured[colour.code]) featured[colour.code] = id;
      count++;
      onProgress?.(count);
    }
  }
  return { featured, count };
}

async function createVariants(product, item, plan, featured) {
  const variants = plan.materials.map((m) => {
    const row = item.rows.find((r) => r.metal.key === m.metal);
    const v = {
      optionValues: [{ optionName: cfg.optionName, name: m.label }],
      price: m.price,
      inventoryItem: {
        ...(cfg.defaults.setSku ? { sku: `${baseCode(item.code)}-${m.metal}-${m.colour}` } : {}),
        tracked: !!cfg.defaults.trackInventory,
        ...(row && row.netWt ? { measurement: { weight: { value: row.netWt, unit: 'GRAMS' } } } : {}),
      },
    };
    // Point the variant at its own colour's first image, so picking 18k Rose shows rose.
    if (featured[m.colour]) v.mediaId = featured[m.colour];
    return v;
  });

  const data = await gql(
    `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
       productVariantsBulkCreate(productId: $productId, variants: $variants, strategy: REMOVE_STANDALONE_VARIANT) {
         productVariants { id sku price }
         userErrors { field message }
       }
     }`,
    { productId: product.id, variants }
  );
  checkErrors(data.productVariantsBulkCreate, 'productVariantsBulkCreate');
  return data.productVariantsBulkCreate.productVariants;
}

/**
 * Pull every product in the store once, so items added by hand can be recognised.
 *
 * The strongest signal is the image FILENAME — renders are named AJLB157-Y1.png, and
 * Shopify keeps that name in the CDN URL, so a hand-built product still carries its
 * item code there even when the title, tags and SKUs don't mention it.
 */
let STORE_INDEX = null;

async function loadStoreIndex() {
  const products = [];
  let cursor = null;

  for (;;) {
    const data = await gql(
      `query($cursor: String) {
         products(first: 50, after: $cursor) {
           pageInfo { hasNextPage endCursor }
           nodes {
             id title handle tags status
             options { id name optionValues { id name } }
             description(truncateAt: 400)
             descriptionHtml
             onlineStoreUrl
             category { id name fullName }
             collections(first: 20) { nodes { id title } }
             variants(first: 100) { nodes { id sku price selectedOptions { name value } inventoryItem { id tracked } } }
             media(first: 250) { nodes { id alt mediaContentType
               ... on MediaImage { image { url } }
               ... on Video { originalSource { url } } } }
           }
         }
       }`,
      { cursor }
    );
    const page = data.products;
    for (const p of page.nodes) {
      const urls = (p.media?.nodes || []).map((m) => m?.image?.url || '').filter(Boolean);
      // id + alt + filename together, so media can be audited and repaired in place.
      const mediaList = (p.media?.nodes || []).map((m, i) => {
        const url = m?.image?.url || m?.originalSource?.url || '';
        let file = '';
        try { file = decodeURIComponent(new URL(url).pathname.split('/').pop()); } catch { file = ''; }
        return {
          id: m?.id, position: i, alt: m?.alt || '', url, file,
          stem: file.replace(/\.[^.]+$/, ''),
          kind: m?.mediaContentType || 'IMAGE',
        };
      }).filter((m) => m.id);
      const mediaIds = (p.media?.nodes || []).map((m) => m?.id).filter(Boolean);
      const files = urls
        .map((u) => { try { return decodeURIComponent(new URL(u).pathname.split('/').pop()); } catch { return u; } });
      const alts = (p.media?.nodes || []).map((m) => m?.alt || '').filter(Boolean);
      const skus = (p.variants?.nodes || []).map((v) => v?.sku || '').filter(Boolean);

      products.push({
        id: p.id,
        title: p.title,
        status: p.status,
        onlineStoreUrl: p.onlineStoreUrl || null,
        options: (p.options || []).map((o) => ({ id: o.id, name: o.name, values: (o.optionValues || []).map((v) => v.name) })),
        category: p.category?.fullName || null,
        collections: (p.collections?.nodes || []).map((c) => c.title),
        description: p.description || '',
        descriptionHtml: p.descriptionHtml || '',
        imageUrls: urls,
        media: mediaList,
        mediaIds,
        prices: (p.variants?.nodes || []).map((v) => v?.price).filter((x) => x != null),
        variants: (p.variants?.nodes || []).map((v) => ({
          id: v.id,
          price: v.price,
          sku: v.sku || '',
          inventoryItemId: v.inventoryItem?.id || null,
          tracked: v.inventoryItem?.tracked === true,
          options: (v.selectedOptions || []).map((o) => `${o.name}=${o.value}`).join(' | '),
          material: (v.selectedOptions || []).find((o) => o.name === cfg.optionName)?.value || '',
          // Older products carry two options instead of one.
          legacyMetal: (v.selectedOptions || []).find((o) => /^metal$/i.test(o.name))?.value || '',
          legacyColour: (v.selectedOptions || []).find((o) => /^colou?r$/i.test(o.name))?.value || '',
        })),
        mediaCount: (p.media?.nodes || []).length,
        haystacks: {
          media: files.join(' | '),
          sku: skus.join(' | '),
          tag: (p.tags || []).join(' | '),
          title: p.title,
          handle: (p.handle || '').replace(/-/g, ' '),
        },
      });
    }
    if (!page.pageInfo.hasNextPage) break;
    cursor = page.pageInfo.endCursor;
  }
  return products;
}

/** Which product, if any, already covers this item code — and what gave it away. */
function findInIndex(code) {
  const rx = new RegExp(`(^|[^A-Za-z0-9])${rxEsc(code)}([^0-9]|$)`, 'i');
  for (const p of STORE_INDEX) {
    for (const key of ['sku', 'tag', 'media', 'title', 'handle']) {
      if (rx.test(p.haystacks[key])) return { product: p, matchedBy: key === 'media' ? 'image filename' : key };
    }
  }

  // Last resort: the title we wrote for this code. A product created with no images and
  // no SKU has nothing else to match on, and its title is the one thing we know for sure.
  const written = CONTENT?.[code]?.title || CONTENT?.[String(code).toUpperCase()]?.title;
  if (written) {
    const want = String(written).trim().toLowerCase();
    const hit = STORE_INDEX.find((p) => String(p.title).trim().toLowerCase() === want);
    if (hit) return { product: hit, matchedBy: 'written title' };
  }
  return null;
}

/** Push a written title and description onto a product that already exists. */
async function updateTitleOnly(productId, title) {
  const data = await gql(
    `mutation($input: ProductInput!) {
       productUpdate(input: $input) { product { id title } userErrors { field message } }
     }`,
    { input: { id: productId, title } }
  );
  checkErrors(data.productUpdate, 'productUpdate');
  return data.productUpdate.product;
}

async function updateContent(productId, title, descriptionHtml) {
  const data = await gql(
    `mutation($input: ProductInput!) {
       productUpdate(input: $input) { product { id title } userErrors { field message } }
     }`,
    { input: { id: productId, title, descriptionHtml } }
  );
  checkErrors(data.productUpdate, 'productUpdate');
  return data.productUpdate.product;
}

// ------------------------------------------------------------------ plan ---

/** Work out the metal × colour matrix actually available for this item. */
function planItem(item, media) {
  const priceFor = (metalKeyName) => {
    const row = item.rows.find((r) => r.metal.key === metalKeyName);
    return row && row.price !== null ? row.price : null;
  };

  // A material is offered when its metal has a price. By default it must also have a
  // render in that colour, which keeps a product from listing a metal with no picture —
  // but when the designer has only supplied one colour, that guard hides metals the piece
  // is genuinely sold in. config.json "requireRenderPerColour": false lifts it.
  // With no renders at all there is nothing to require — otherwise a product whose
  // images were deleted from Drive would lose every variant.
  const anyRenders = Object.keys(media).length > 0;
  const needRender = cfg.requireRenderPerColour !== false && anyRenders;
  const materials = cfg.materials
    .map((m) => ({ ...m, price: priceFor(m.metal), files: media[m.colour] }))
    .filter((m) => m.price !== null && (!needRender || (m.files && m.files.images.length)));

  const colours = cfg.colours.filter((c) => materials.some((m) => m.colour === c.code));

  // A colour can be offered with no files behind it — renders deleted from Drive once
  // they were on Shopify — so nothing here may assume media[c.code] exists.
  const bucket = (c) => media[c] || { images: [], videos: [] };
  const files = colours.reduce(
    (n, c) => n + bucket(c.code).images.length + (WITH_VIDEO ? bucket(c.code).videos.length : 0), 0
  );
  const bytes = colours.reduce((n, c) =>
    n + [...bucket(c.code).images, ...(WITH_VIDEO ? bucket(c.code).videos : [])]
      .reduce((s, f) => { try { return s + fs.statSync(f).size; } catch { return s; } }, 0), 0);

  return { materials, colours, variantCount: materials.length, files, bytes };
}

// ------------------------------------------------------------------- run ---

async function main() {
  await ensureToken();
  if (!TOKEN && LIVE) {
    die('No credentials. Set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET (Dev Dashboard app),\n' +
        '  or SHOPIFY_ADMIN_TOKEN for a legacy custom app.');
  }

  console.log(`\nStore     ${cfg.store}`);

  // Prove the credentials work before touching any files — this is the step most
  // likely to be misconfigured, and its error is the least obvious.
  if (TOKEN) {
    try {
      const d = await gql(`{ shop { name myshopifyDomain } }`);
      console.log(`Shop      ${d.shop.name} (${d.shop.myshopifyDomain}) — connected`);
    } catch (e) {
      die(`Connected to Shopify but the API rejected the request.\n  ${e.message}\n\n` +
          `  Usually this means the app isn't installed on ${cfg.store},\n` +
          `  or it's missing a scope. Check Settings > Apps in the admin.`);
    }
  } else {
    console.log(`Shop      no credentials set — store checks skipped`);
  }

  if (TOKEN) {
    process.stdout.write(`Products  reading your store\u2026`);
    STORE_INDEX = await loadStoreIndex();
    process.stdout.write(`\rProducts  ${STORE_INDEX.length} already in the store            \n`);
  }

  if (!fs.existsSync(cfg.sheetCsv)) {
    die(`Packing list not found: ${cfg.sheetCsv}\n\n` +
        `  Open the packing list in Google Sheets, then\n` +
        `  File > Download > Comma-separated values (.csv),\n` +
        `  and save it to that exact path.`);
  }

  const sheetRows = parseCsv(fs.readFileSync(cfg.sheetCsv, 'utf8'));
  const items = parseSheet(sheetRows);
  PACKING_SPECS = packingSpecs(sheetRows);
  // Drive is the main source; "extraImagesDirs" adds local folders (a test batch that
  // hasn't been filed into Drive yet) without moving anything.
  const renderRoots = [cfg.imagesDir, ...(cfg.extraImagesDirs || [])].filter((d) => fs.existsSync(d));
  const renderItems = renderRoots.flatMap((d) => indexRenderItems(d));

  // Renders can be deleted from Drive once they are uploaded to Shopify — storage runs
  // out. Without this, those products vanish from every sync command: no title, price or
  // spec update would ever reach them again. Anything with copy in product-content.json
  // stays workable, just with no files to upload.
  const haveFolder = new Set(renderItems.map((r) => baseCode(r.code).toUpperCase()));
  let fileless = 0;
  for (const code of Object.keys(CONTENT || {})) {
    if (code === '_comment') continue;
    const c = code.toUpperCase();
    if (haveFolder.has(c)) continue;
    renderItems.push({ code, category: null, files: [], noRenders: true });
    fileless++;
  }
  if (fileless) {
    renderItems.sort((a, z) => String(a.code).localeCompare(String(z.code), undefined, { numeric: true }));
  }
  const priceList = parsePriceList(cfg.priceListCsv);
  PRICE_LIST = priceList;

  PRICE_LIST_GLOBAL = priceList;

  // The renders drive the run; the sheet is looked up per item for price and specs.
  const sheetByCode = new Map(
    items.filter((i) => i.code).map((i) => [baseCode(i.code).toUpperCase(), i])
  );

  // Diagnostic: where does a code's price actually come from? Needs no credentials, so it
  // can be run without touching the store. Added because a price kept resolving to the cost
  // sheet and guessing at the precedence twice was worse than just printing it.
  if (PRICE_OF) {
    for (const raw of String(PRICE_OF).split(',').map((x) => x.trim()).filter(Boolean)) {
      const code = baseCode(raw).toUpperCase();
      console.log(`\n${code}`);
      const inPL = priceList.has(code);
      console.log(`  price-list.csv : ${inPL ? JSON.stringify(priceList.get(code).prices) : 'NOT PRESENT'}`);
      const sh = sheetByCode.get(code);
      console.log(`  packing-list   : ${sh ? sh.rows.map((r) => `${r.metal.key}=${r.price}`).join(' ') : 'not present'}`);
      const item = (inPL ? itemFromPriceList(code, priceList.get(code)) : null) || sh;
      console.log(`  WOULD USE      : ${item ? (item.fromPriceList ? 'price-list.csv (retail)' : 'packing-list.csv (COST)') : 'nothing'}`);
      if (item) console.log(`                   ${item.rows.map((r) => `${r.metal.key}=${r.price}`).join(' ')}`);
    }
    console.log('');
    return;
  }
  const mediaCount = renderItems.reduce((n, r) => n + r.files.length, 0);

  const withFiles = renderItems.filter((r) => !r.noRenders).length;
  console.log(`Render    ${renderRoots.join(' + ')} — ${withFiles} items, ${mediaCount} files`);
  if (renderItems.length > withFiles) {
    console.log(`          + ${renderItems.length - withFiles} product(s) with copy but no render folder (managed, nothing to upload)`);
  }
  console.log(`Sheet     ${cfg.sheetCsv} — ${items.length} items parsed`);
  if (priceList.size) {
    console.log(`Prices    ${cfg.priceListCsv} — ${priceList.size} items in ${(cfg.priceList?.currency || 'USD')}`);
  }
  console.log(`Video     ${WITH_VIDEO ? 'included' : 'skipped'}`);
  console.log(`Mode      ${DRY ? 'DRY RUN — nothing will be created' : 'LIVE'}\n`);

  if (AUDIT) {
    if (!STORE_INDEX) die('--audit needs credentials so it can read your store.');
    console.log(`\n${'ITEM'.padEnd(10)}  ${'CAT'.padEnd(4)}  ${'STATUS'.padEnd(24)}  PRODUCT`);
    console.log('-'.repeat(84));
    let present = 0;
    for (const r of renderItems) {
      const code = baseCode(r.code);
      const hit = findInIndex(code);
      const priced = sheetByCode.has(code.toUpperCase());
      if (hit) present++;
      const status = hit ? `in store (${hit.matchedBy})` : (priced ? 'NOT IN STORE' : 'NOT IN STORE, no price');
      console.log(
        `${code.padEnd(10)}  ${r.category.padEnd(4)}  ${status.padEnd(24)}  ` +
        `${hit ? hit.product.title.slice(0, 40) : ''}`
      );
    }
    console.log('-'.repeat(84));
    console.log(`${present} of ${renderItems.length} rendered items are in the store, ${renderItems.length - present} missing.`);

    const noPrice = renderItems.filter((r) => !sheetByCode.has(baseCode(r.code).toUpperCase()));
    if (noPrice.length) {
      console.log(`\nRendered but NOT in the packing list (no price):`);
      for (const r of noPrice) console.log(`  ${r.category}/${r.code}`);
    }
    const noRender = items
      .filter((i) => i.code && !renderItems.some((r) => baseCode(r.code).toUpperCase() === baseCode(i.code).toUpperCase()))
      .map((i) => baseCode(i.code));
    if (noRender.length) console.log(`\nIn the packing list but not yet rendered: ${noRender.join(', ')}`);

    const todo = renderItems
      .map((r) => baseCode(r.code))
      .filter((c) => !findInIndex(c) && sheetByCode.has(c.toUpperCase()));
    console.log(`\nTo create the missing ones:`);
    console.log(`  node import.js --live --no-video --only ${todo.join(',') || '(none ready)'}\n`);
    return;
  }

  if (COLLECT) {
    if (!STORE_INDEX) die('--collect-images needs credentials so it can see which products lack copy.');
    const placeholder = cfg.defaults.untitledTitle || 'Untitled — description needed';
    const outDir = './_identify';
    fs.mkdirSync(outDir, { recursive: true });

    const needs = STORE_INDEX.filter((p) =>
      p.title === placeholder || /^untitled/i.test(p.title) ||
      !p.description || p.description.trim().length < 80);

    let n = 0;
    const unreadable = [];
    for (const r of renderItems) {
      const code = baseCode(r.code);

      // Collect a preview when EITHER the product in the store still lacks copy, OR the
      // item has never been written up at all — so this works before an import as well
      // as after one.
      const inStoreNeedsCopy = needs.some((p) => new RegExp(
        `(^|[^A-Za-z0-9])${rxEsc(code)}([^0-9]|$)`, 'i'
      ).test([p.haystacks.sku, p.haystacks.media, p.haystacks.title].join(' | ')));
      const neverWritten = !CONTENT[code]?.title;
      if (!inStoreNeedsCopy && !neverWritten) continue;

      // One clear still, shrunk right down — just enough to identify the cut and setting.
      const media = mediaForItem(r.files, r.code);
      const first = (media.W || media.Y || media.R)?.images?.[0];
      if (!first) {
        // Files exist but none match <CODE>-<R|W|Y><n>. Silently skipping would hide the
        // item from every command, so say so loudly.
        unreadable.push({ code, folder: r.code, example: path.basename(r.files[0] || '') });
        continue;
      }

      const out = path.join(outDir, `${code}.jpg`);
      try {
        execFileSync('sips', ['-s', 'format', 'jpeg', '-Z', '700', first, '--out', out], { stdio: 'ignore' });
      } catch {
        fs.copyFileSync(first, out.replace(/\.jpg$/, path.extname(first)));
      }
      const why = neverWritten ? 'no copy written yet' : 'product in store needs copy';
      console.log(`  ${code.padEnd(10)} ${(caratsFrom(r.code) ?? '—').toString().padEnd(6)} ${why}`);
      n++;
    }
    console.log(`\n${n} preview${n === 1 ? '' : 's'} written to ${outDir}/`);
    if (unreadable.length) {
      console.log(`\n⚠ ${unreadable.length} folder(s) have files the script can't read as renders.`);
      console.log(`  Filenames must end with the colour and a number, e.g. AJER680-W1.png`);
      for (const u of unreadable) console.log(`    ${u.folder}  —  found: ${u.example || '(no image files)'}`);
      console.log(`  These are invisible to every command until the names are fixed.`);
    }
    if (n) {
      console.log(`\nSend that folder to Claude to have the titles and descriptions written,`);
      console.log(`or write them into ${cfg.contentFile} yourself. Then:`);
      console.log(`  node import.js --live              # create anything new`);
      console.log(`  node import.js --live --sync-content   # fix anything already created\n`);
    } else {
      console.log('');
    }
    return;
  }

  if (EXPORT_UNTITLED) {
    if (!STORE_INDEX) die('--export-untitled needs credentials so it can read your store.');
    const placeholder = cfg.defaults.untitledTitle || 'Untitled — description needed';

    const codeFor = (p) => {
      const hit = renderItems.find((r) => new RegExp(
        `(^|[^A-Za-z0-9])${rxEsc(baseCode(r.code))}([^0-9]|$)`, 'i'
      ).test([p.haystacks.sku, p.haystacks.media, p.haystacks.title].join(' | ')));
      return hit ? { code: baseCode(hit.code), folder: hit.code, category: hit.category } : null;
    };

    const out = [];
    for (const p of STORE_INDEX) {
      const untitled = p.title === placeholder || /^untitled/i.test(p.title) ||
        !p.description || p.description.trim().length < 80;
      if (!untitled) continue;
      const meta = codeFor(p) || {};
      out.push({
        code: meta.code || '',
        folder: meta.folder || '',
        category: meta.category || '',
        carats: meta.folder ? caratsFrom(meta.folder) : null,
        currentTitle: p.title,
        productId: p.id,
        // One image is enough to identify the design; the rest are other metal colours.
        image: p.imageUrls[0] || '',
      });
    }

    const file = 'untitled-products.json';
    fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
    console.log(`${out.length} product${out.length === 1 ? '' : 's'} need copy. Written to ${file}\n`);
    for (const o of out) {
      console.log(`  ${(o.code || '?').padEnd(10)} ${(o.carats !== null ? o.carats + ' CTW' : '').padEnd(9)} ${o.currentTitle.slice(0, 40)}`);
    }
    console.log('');
    return;
  }

  if (CHECK) {
    if (!STORE_INDEX) die('--check needs credentials so it can read your store.');

    const placeholder = cfg.defaults.untitledTitle || 'Untitled — description needed';
    const codeOf = (p) => {
      const hit = renderItems.find((r) => {
        const c = baseCode(r.code);
        return new RegExp(`(^|[^A-Za-z0-9])${rxEsc(c)}([^0-9]|$)`, 'i').test(
          [p.haystacks.sku, p.haystacks.media, p.haystacks.title, p.haystacks.tag].join(' | ')
        );
      });
      return hit ? baseCode(hit.code) : '';
    };

    const rows = [];
    for (const p of STORE_INDEX) {
      const problems = [];
      if (p.title === placeholder || /^untitled/i.test(p.title)) problems.push('placeholder title');
      if (!p.description || p.description.trim().length < 80) problems.push('description missing or very short');
      if (p.prices.length && p.prices.every((x) => Number(x) === 0)) problems.push('all prices are 0');
      else if (p.prices.some((x) => Number(x) === 0)) problems.push('some prices are 0');
      if (!p.mediaCount) problems.push('no images');
      // Active but with no storefront URL means it isn't on the Online Store channel —
      // the usual reason a product looks live in admin but can't be found on the site.
      if (p.status === 'ACTIVE' && !p.onlineStoreUrl) problems.push('ACTIVE but not published to Online Store');
      // The variant option has to be named consistently or the theme's colour filtering
      // can't find the product.
      const names = [...new Set((p.variants || [])
        .flatMap((v) => (v.options || '').split(' | ').map((o) => o.split('=')[0]))
        .filter((n) => n && n !== 'Title'))];
      if (names.length && !names.includes(cfg.optionName)) {
        problems.push(`option is "${names.join('/')}", expected "${cfg.optionName}"`);
      }
      if (!names.length) problems.push('no variant options (single default variant)');

      // Category and collections, judged against what the config says this code should get.
      const meta = renderItems.find((r) => new RegExp(
        `(^|[^A-Za-z0-9])${rxEsc(baseCode(r.code))}([^0-9]|$)`, 'i'
      ).test([p.haystacks.sku, p.haystacks.media, p.haystacks.title].join(' | ')));
      if (meta) {
        const c = baseCode(meta.code);
        if (!p.category) problems.push('no category');
        const want = collectionsFor(c);
        const missing = want.filter((t) => !p.collections.some((x) => x.toLowerCase() === t.toLowerCase()));
        if (missing.length) problems.push(`not in collection: ${missing.join(', ')}`);
      } else if (!p.category) {
        problems.push('no category');
      }
      if (!problems.length) continue;

      const code = codeOf(p);
      rows.push({ code, title: p.title, status: p.status, problems });
    }

    if (!rows.length) {
      console.log('✓ Nothing wrong found — every product has a real title, a description, a price and images.\n');
      return;
    }

    console.log(`${'ITEM'.padEnd(10)}  ${'PRODUCT'.padEnd(42)}  PROBLEM`);
    console.log('-'.repeat(100));
    for (const r of rows) {
      console.log(`${(r.code || '—').padEnd(10)}  ${r.title.slice(0, 42).padEnd(42)}  ${r.problems.join('; ')}`);
    }
    console.log('-'.repeat(100));
    console.log(`${rows.length} product${rows.length === 1 ? '' : 's'} need attention.\n`);

    const fixable = rows.filter((r) => r.code && r.problems.some((x) => /title|description/.test(x)));
    if (fixable.length) {
      const codes = [...new Set(fixable.map((r) => r.code))].join(',');
      console.log('Titles and descriptions — write the copy, then push it:');
      console.log(`  node describe.js --write --only ${codes}`);
      console.log(`  node import.js --live --sync-content\n`);
    }
    const priced = rows.filter((r) => r.problems.some((x) => x.includes('prices')));
    if (priced.length) {
      console.log(`Prices at 0 (${priced.map((r) => r.code || r.title.slice(0, 20)).join(', ')}) come from items with`);
      console.log('no packing-list row. Add them to the sheet, or set the price by hand in Shopify.\n');
    }
    return;
  }

  if (SYNC_FACETS) {
    if (!STORE_INDEX) die('--sync-facets needs credentials so it can read your store.');
    const ns = cfg.facets?.namespace || 'custom';
    const keys = cfg.facets?.metafieldKeys || {};
    let fixed = 0, skipped = 0;

    // Facets come off the title, so every product in the store can have them — including
    // the ones built by hand in Admin that have no render folder behind them.
    let targets = STORE_INDEX;
    if (ONLY) {
      const wanted = new Set();
      for (const code of ONLY) { const h = findInIndex(code); if (h) wanted.add(h.product.id); }
      targets = STORE_INDEX.filter((p) => wanted.has(p.id));
    }

    for (const product of targets) {
      const hit = { product };

      // Read the facets off the live title, so edits made in Shopify are respected.
      const title = product.title;
      const f = facetsFor(title);
      if (!f.shapes.length && !f.type && !f.style) { skipped++; continue; }

      const tags = cfg.facets?.asTags === false ? [] : facetTags(title);
      const metafields = cfg.facets?.asMetafields === false ? [] : [
        f.shapes.length && keys.shape ? { namespace: ns, key: keys.shape, type: 'single_line_text_field', value: f.shapes.join(', ') } : null,
        f.type && keys.type ? { namespace: ns, key: keys.type, type: 'single_line_text_field', value: f.type } : null,
        f.style && keys.style ? { namespace: ns, key: keys.style, type: 'single_line_text_field', value: f.style } : null,
      ].filter(Boolean);

      const label = [f.shapes.join('+') || null, f.type, f.style].filter(Boolean).join(' / ');
      if (DRY) { console.log(`· ${label.padEnd(34)} ${title.slice(0, 48)}`); fixed++; continue; }

      try {
        // tagsAdd keeps whatever is already on the product.
        if (tags.length) {
          const d = await gql(
            `mutation($id: ID!, $tags: [String!]!) {
               tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
             }`,
            { id: hit.product.id, tags }
          );
          checkErrors(d.tagsAdd, 'tagsAdd');
        }
        if (metafields.length) {
          const d2 = await gql(
            `mutation($input: ProductInput!) {
               productUpdate(input: $input) { product { id } userErrors { field message } }
             }`,
            { input: { id: hit.product.id, metafields } }
          );
          checkErrors(d2.productUpdate, 'productUpdate');
        }
        console.log(`✓ ${label.padEnd(34)} ${title.slice(0, 48)}`);
        fixed++;
      } catch (e) {
        console.log(`✖ ${title.slice(0, 40).padEnd(40)} ${e.message.slice(0, 70)}`);
      }
    }

    console.log(`\n${fixed} ${DRY ? 'would be tagged' : 'tagged'}, ${skipped} had nothing recognisable in the title.\n`);
    return;
  }

  if (SYNC_VARIANTS) {
    if (!STORE_INDEX) die('--sync-variants needs credentials so it can read your store.');

    for (const r of renderItems) {
      const code = baseCode(r.code);
      if (ONLY && !ONLY.includes(code.toUpperCase())) continue;

      const hit = findInIndex(code);
      if (!hit) continue;
      const p = hit.product;

      // price-list.csv (RETAIL) wins over packing-list.csv (the accountant's COST sheet).
      // The old order put the cost sheet first, so the 22 products it covers went live at
      // cost — AJLB53 at $130 against a $1,100 retail price. The cost sheet is now only a
      // fallback for a code with no retail price at all.
      const item = (priceList.has(code.toUpperCase())
        ? itemFromPriceList(code, priceList.get(code.toUpperCase()))
        : null) || sheetByCode.get(code.toUpperCase());
      if (!item) { console.log(`⚠ ${code.padEnd(12)} no price anywhere — skipped`); continue; }

      const media = mediaForItem(r.files, r.code);
      const plan = planItem(item, media);
      if (!plan.materials.length) { console.log(`⚠ ${code.padEnd(12)} no materials available — skipped`); continue; }

      const real = (p.options || []).filter((o) => o.name !== 'Title');

      // Case 1 — the option exists but is called something else. Rename in place; the
      // variants and their prices are untouched.
      if (real.length === 1 && real[0].name !== cfg.optionName) {
        if (DRY) { console.log(`· ${code.padEnd(12)} rename option "${real[0].name}" -> "${cfg.optionName}"`); continue; }
        try {
          const d = await gql(
            `mutation($productId: ID!, $option: OptionUpdateInput!) {
               productOptionUpdate(productId: $productId, option: $option) {
                 userErrors { field message }
               }
             }`,
            { productId: p.id, option: { id: real[0].id, name: cfg.optionName } }
          );
          checkErrors(d.productOptionUpdate, 'productOptionUpdate');
          console.log(`✓ ${code.padEnd(12)} option renamed to "${cfg.optionName}"`);
        } catch (e) {
          console.log(`✖ ${code.padEnd(12)} ${e.message.slice(0, 90)}`);
        }
        continue;
      }

      // Case 2 — no real option at all: a lone "Default Title" variant. Add the option
      // and build the full set.
      if (!real.length) {
        if (DRY) {
          console.log(`· ${code.padEnd(12)} add "${cfg.optionName}" with ${plan.materials.length} values, replacing the default variant`);
          continue;
        }
        try {
          const d = await gql(
            `mutation($productId: ID!, $options: [OptionCreateInput!]!) {
               productOptionsCreate(productId: $productId, options: $options,
                 variantStrategy: LEAVE_AS_IS) {
                 userErrors { field message }
               }
             }`,
            {
              productId: p.id,
              options: [{ name: cfg.optionName, values: plan.materials.map((m) => ({ name: m.label })) }],
            }
          );
          checkErrors(d.productOptionsCreate, 'productOptionsCreate');

          const variants = plan.materials.map((m) => ({
            optionValues: [{ optionName: cfg.optionName, name: m.label }],
            price: m.price,
            inventoryItem: {
              ...(cfg.defaults.setSku ? { sku: `${code}-${m.metal}-${m.colour}` } : {}),
              tracked: !!cfg.defaults.trackInventory,
            },
          }));
          const d2 = await gql(
            `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
               productVariantsBulkCreate(productId: $productId, variants: $variants,
                 strategy: REMOVE_STANDALONE_VARIANT) {
                 productVariants { id }
                 userErrors { field message }
               }
             }`,
            { productId: p.id, variants }
          );
          checkErrors(d2.productVariantsBulkCreate, 'productVariantsBulkCreate');
          console.log(`✓ ${code.padEnd(12)} ${variants.length} variants created under "${cfg.optionName}"`);
        } catch (e) {
          console.log(`✖ ${code.padEnd(12)} ${e.message.slice(0, 120)}`);
        }
        continue;
      }

      // Case 3 — the right option, but some of its values never got built. Happens when a
      // product was created before it had a price: only the priced metals got a variant.
      // Add the missing ones; existing variants, their prices and SKUs are left alone.
      const metalOpt = real.find((o) => o.name === cfg.optionName);
      const lenOpt = real.find((o) => o.name === (cfg.lengthOption || 'Length'));
      const unexpected = real.filter((o) => o !== metalOpt && o !== lenOpt);

      if (metalOpt && !unexpected.length) {
        // Work in whole combinations, not just metals. A product can have every metal
        // present and still be missing a length, and the reverse — comparing metal names
        // alone hid that and, when Length existed, skipped the product without a word.
        const lens = lenOpt ? (lenOpt.values || []) : [null];
        const cat = categoryOfCode(code, p.title);
        const valOf = (v, optName) => {
          const raw = String(v.options || '').split(' | ')
            .find((x) => x.split('=')[0].trim().toLowerCase() === String(optName).trim().toLowerCase());
          return raw ? raw.slice(raw.indexOf('=') + 1).trim() : '';
        };
        const key = (a, b) => `${String(a).trim().toLowerCase()}||${b === null ? '' : String(b).trim().toLowerCase()}`;
        const have = new Set((p.variants || []).map((v) => {
          const mv = valOf(v, cfg.optionName) || String(v.material || '');
          const lv = lenOpt ? valOf(v, lenOpt.name) : null;
          return key(mv, lenOpt ? lv : null);
        }));

        const wanted = [];
        for (const m of plan.materials) for (const len of lens) {
          if (have.has(key(m.label, len))) continue;
          wanted.push({ m, len });
        }
        if (!wanted.length) {
          console.log(`= ${code.padEnd(12)} all ${plan.materials.length * lens.length} combination(s) present`);
          continue;
        }
        if (DRY) {
          const shown = wanted.slice(0, 6).map((w) => `${w.m.label}${w.len ? ' ' + w.len : ''}`).join(', ');
          console.log(`· ${code.padEnd(12)} add ${wanted.length} missing combination(s): ${shown}${wanted.length > 6 ? ', …' : ''}`);
          continue;
        }
        try {
          // A metal option linked to a metafield (Shopify's "Jewelry material" category
          // option) takes the metaobject entry's handle, not a name. Sending a name failed
          // with "Cannot set name for an option value linked to a metafield", which is why
          // AJNT26 kept only the three values it was built with by hand.
          const d0 = await gql(
            `query($id: ID!) { product(id: $id) { options { name linkedMetafield { key } } } }`,
            { id: p.id }
          );
          const linked = (d0.product?.options || []).find((o) => o.name === cfg.optionName)?.linkedMetafield;
          let handleFor = null;
          if (linked) {
            const map = new Map();
            for (const n of await metaobjectEntries(`shopify--${linked.key}`)) {
              map.set(String(n.displayName || n.handle).trim().toLowerCase(), n.handle);
            }
            handleFor = (label) => map.get(String(label).trim().toLowerCase()) || null;
            const none = [...new Set(wanted.map((w) => w.m.label))].filter((l) => !handleFor(l));
            if (none.length) {
              console.log(`✖ ${code.padEnd(12)} "${cfg.optionName}" is linked to a metafield with no entry for: ${none.join(', ')} — add them in Shopify first`);
              continue;
            }
          }
          const lenTag = (x) => String(x).replace(/\s+/g, '').replace(/in$/i, '').toUpperCase() + 'IN';
          const variants = [];
          for (const { m, len } of wanted) {
            const price = len && Number(m.price) > 0
              ? roundPrice(Math.max(0, Number(m.price) + lengthDeltaFor(cat, len))).toFixed(2)
              : m.price;
            const sku = `${code}-${m.metal}-${m.colour}${len && cfg.skuIncludesLength ? `-${lenTag(len)}` : ''}`;
            variants.push({
              optionValues: [
                handleFor
                  ? { optionName: cfg.optionName, linkedMetafieldValue: handleFor(m.label) }
                  : { optionName: cfg.optionName, name: m.label },
                ...(len ? [{ optionName: lenOpt.name, name: len }] : []),
              ],
              price,
              inventoryItem: {
                ...(cfg.defaults.setSku ? { sku } : {}),
                tracked: !!cfg.defaults.trackInventory,
              },
            });
          }
          const d3 = await gql(
            `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
               productVariantsBulkCreate(productId: $productId, variants: $variants) {
                 productVariants { id }
                 userErrors { field message }
               }
             }`,
            { productId: p.id, variants }
          );
          checkErrors(d3.productVariantsBulkCreate, 'productVariantsBulkCreate');
          console.log(`✓ ${code.padEnd(12)} ${variants.length} missing variant(s) added`);
        } catch (e) {
          console.log(`✖ ${code.padEnd(12)} ${e.message.slice(0, 120)}`);
        }
        continue;
      }

      // Anything that reaches here was not handled above. Say so — a product must never
      // be skipped without a line explaining why.
      console.log(`= ${code.padEnd(12)} options "${real.map((o) => o.name).join('/')}" — ` +
        (unexpected.length ? `unexpected option "${unexpected.map((o) => o.name).join('/')}", left alone`
                           : `no "${cfg.optionName}" option, left alone`));
    }
    console.log('');
    return;
  }

  if (DUPES) {
    if (!STORE_INDEX) die('--duplicates needs credentials so it can read your store.');
    const byTitle = new Map();
    for (const p of STORE_INDEX) {
      const k = String(p.title).trim().toLowerCase();
      if (!byTitle.has(k)) byTitle.set(k, []);
      byTitle.get(k).push(p);
    }
    const groups = [...byTitle.values()].filter((g) => g.length > 1);
    if (!groups.length) { console.log('No two products share a title.\n'); return; }

    const admin = (id) => `https://admin.shopify.com/store/${cfg.store.split('.')[0]}/products/${String(id).split('/').pop()}`;
    console.log(`${groups.length} title(s) used by more than one product:\n`);
    for (const g of groups) {
      console.log(`  ${g[0].title}`);
      // The most complete copy first — that's the one to keep.
      const score = (p) => (p.variants?.length || 0) * 100 + (p.media?.length || 0);
      for (const p of [...g].sort((a, z) => score(z) - score(a))) {
        const skus = (p.variants || []).map((v) => v.sku).filter(Boolean);
        console.log(`    ${String(p.variants?.length || 0).padStart(2)} variants  ${String(p.media?.length || 0).padStart(2)} media  ${p.status.padEnd(7)} ${admin(p.id)}`);
        if (skus.length) console.log(`       sku: ${skus[0]}${skus.length > 1 ? ` (+${skus.length - 1})` : ''}`);
      }
      console.log('');
    }
    console.log('The first copy in each group is the complete one. Delete the others in Admin.\n');
    return;
  }

  if (PRICE_REPORT) {
    if (!STORE_INDEX) die('--prices needs credentials so it can read your store.');
    const bad = [];
    for (const p of STORE_INDEX) {
      const vs = p.variants || [];
      const zero = vs.filter((v) => v.price == null || Number(v.price) === 0);
      if (zero.length) bad.push({ p, zero, total: vs.length });
    }
    if (!bad.length) { console.log('Every variant in the store has a price.\n'); return; }

    console.log(`${bad.length} product(s) with unpriced variants:\n`);
    for (const { p, zero, total } of bad) {
      console.log(`  ${p.title.slice(0, 46).padEnd(46)} ${zero.length}/${total} at 0`);
      for (const v of zero.slice(0, 4)) {
        console.log(`      ${(v.sku || '(no sku)').padEnd(22)} ${v.options || '(no options)'}`);
      }
      if (zero.length > 4) console.log(`      \u2026 and ${zero.length - 4} more`);
    }
    console.log(`\nFix with: node import.js --sync-prices --live\n`);
    return;
  }

  if (MEDIA_LIST) {
    if (!STORE_INDEX) die('--media-list needs credentials so it can read your store.');
    const q = (value('--only') || '').toLowerCase();
    const targets = STORE_INDEX.filter((p) => {
      if (!q) return true;
      if (p.title.toLowerCase().includes(q)) return true;
      return q.split(',').some((code) => {
        const h = findInIndex(code.trim());
        return h && h.product.id === p.id;
      });
    });
    if (!targets.length) { console.log('Nothing matched. Pass --only with an item code or part of the title.\n'); return; }

    for (const p of targets) {
      console.log(`\n${p.title}`);
      console.log(`${p.media.length} media\n`);
      const groups = new Map();
      for (const m of p.media) {
        const k = normStem(m.stem);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(m);
      }
      for (const m of p.media) {
        const dup = groups.get(normStem(m.stem)).length > 1 ? ' ◀ same name as another' : '';
        console.log(`  ${String(m.position).padStart(3)}  ${m.kind.padEnd(5)} ${m.file.padEnd(34)} alt: ${m.alt || '(blank)'}${dup}`);
      }
    }
    console.log('');
    return;
  }

  if (FIX_MEDIA) {
    if (!STORE_INDEX) die('--fix-media needs credentials so it can read your store.');

    // Which render item sits behind each product, so a real filename can outrank a copy.
    const renderByProduct = new Map();
    for (const r of renderItems) {
      const hit = findInIndex(baseCode(r.code));
      if (hit) renderByProduct.set(hit.product.id, r);
    }

    let targets = STORE_INDEX;
    if (ONLY) {
      const wanted = new Set();
      for (const code of ONLY) { const h = findInIndex(code); if (h) wanted.add(h.product.id); }
      targets = STORE_INDEX.filter((p) => wanted.has(p.id));
    }

    let dupTotal = 0, altTotal = 0, unknown = 0, touched = 0;
    const unknownFiles = [], videoMismatch = [];

    for (const p of targets) {
      if (!p.media?.length) continue;
      const r = renderByProduct.get(p.id);
      const realStems = new Set((r?.files || []).map((f) => path.basename(f, path.extname(f)).toLowerCase()));

      // If the render folder itself has two different files that normalise the same way,
      // the _1 suffix is meaningful for this item — don't touch its duplicates.
      const seen = new Map();
      let unsafe = false;
      for (const st of realStems) {
        const k = normStem(st);
        if (seen.has(k) && seen.get(k) !== st) unsafe = true;
        seen.set(k, st);
      }

      // ---- duplicates -------------------------------------------------------
      const groups = new Map();
      for (const m of p.media) {
        const k = normStem(m.stem);
        if (!k) continue;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(m);
      }
      const doomed = [];
      if (!unsafe) {
        for (const [, list] of groups) {
          if (list.length < 2) continue;
          const keep = list.find((m) => realStems.has(m.stem.toLowerCase()))
            || [...list].sort((a, z) => a.position - z.position)[0];
          for (const m of list) if (m.id !== keep.id) doomed.push(m);
        }
      }

      // ---- alt text ---------------------------------------------------------
      const survivors = p.media.filter((m) => !doomed.some((d) => d.id === m.id));

      // Shopify discards a video's filename on upload, so a video's metal can't be read
      // back off the name. What we do know is the order they went up in: colour by colour,
      // in config order. So when the count on the product matches the count in the render
      // folder exactly, position tells us which is which. Opt-in, because it's inference.
      const videoAlt = new Map();
      if (VIDEO_ALT && r) {
        const onProduct = survivors.filter((m) => m.kind === 'VIDEO' || isVideo(m.file));
        const media = mediaForItem(r.files, r.code);
        const fromDrive = [];
        for (const c of cfg.colours) for (const f of (media[c.code]?.videos || [])) fromDrive.push(c);
        if (onProduct.length && onProduct.length === fromDrive.length) {
          onProduct.sort((a, z) => a.position - z.position)
            .forEach((m, i) => videoAlt.set(m.id, altTextFor(fromDrive[i], p.title)));
        } else if (onProduct.length) {
          videoMismatch.push(`${p.title.slice(0, 34).padEnd(34)} ${onProduct.length} on product, ${fromDrive.length} in Drive`);
        }
      }
      const altFixes = [];
      for (const m of survivors) {
        const colour = colourFromStem(m.stem);
        const want = colour ? altTextFor(colour, p.title) : videoAlt.get(m.id);
        if (!want) { unknown++; unknownFiles.push(`${p.title.slice(0, 26).padEnd(26)} ${m.file}`); continue; }
        if (m.alt !== want) altFixes.push({ id: m.id, alt: want, was: m.alt, file: m.file, guessed: !colour });
      }

      if (!doomed.length && !altFixes.length) continue;
      dupTotal += doomed.length;
      altTotal += altFixes.length;

      const label = p.title.slice(0, 44).padEnd(44);
      if (DRY) {
        console.log(`· ${label} ${doomed.length ? `${doomed.length} duplicate(s)` : ''}` +
          `${doomed.length && altFixes.length ? ', ' : ''}${altFixes.length ? `${altFixes.length} alt` : ''}` +
          `${unsafe && groups.size < p.media.length ? '  (duplicates left alone — renders use _n themselves)' : ''}`);
        for (const d of doomed) console.log(`    − ${d.file}`);
        for (const a of altFixes.slice(0, 3)) console.log(`    ↳ ${(a.file || '(video)').padEnd(40)} "${a.was || '(blank)'}" → "${a.alt}"${a.guessed ? '  [by position]' : ''}`);
        if (altFixes.length > 3) console.log(`    ↳ … and ${altFixes.length - 3} more`);
        continue;
      }

      try {
        if (doomed.length) {
          const d = await gql(
            `mutation($productId: ID!, $mediaIds: [ID!]!) {
               productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
                 deletedMediaIds
                 mediaUserErrors { field message }
               }
             }`,
            { productId: p.id, mediaIds: doomed.map((m) => m.id) }
          );
          checkErrors(d.productDeleteMedia, 'productDeleteMedia');
        }
        if (altFixes.length) {
          const d2 = await gql(
            `mutation($files: [FileUpdateInput!]!) {
               fileUpdate(files: $files) { files { id } userErrors { field message } }
             }`,
            { files: altFixes.map((a) => ({ id: a.id, alt: a.alt })) }
          );
          checkErrors(d2.fileUpdate, 'fileUpdate');
        }
        console.log(`✓ ${label} ${doomed.length} removed, ${altFixes.length} alt set`);
        touched++;
      } catch (e) {
        console.log(`✖ ${label} ${e.message.slice(0, 70)}`);
      }
    }

    console.log(`\n${dupTotal} duplicate${dupTotal === 1 ? '' : 's'} ${DRY ? 'to remove' : 'removed'}, ` +
      `${altTotal} alt text${altTotal === 1 ? '' : 's'} ${DRY ? 'to set' : 'set'}` +
      `${DRY ? '' : ` across ${touched} product(s)`}.`);
    if (videoMismatch.length) {
      console.log(`\n${videoMismatch.length} product(s) where the video count doesn't match Drive, so position can't be trusted — skipped:`);
      for (const line of videoMismatch.slice(0, 20)) console.log(`  ${line}`);
    }
    if (unknown) {
      console.log(`\n${unknown} file(s) have no -R/-W/-Y in the name, so the metal can't be told from the filename — left alone:`);
      for (const line of unknownFiles.slice(0, 80)) console.log(`  ${line}`);
      if (unknownFiles.length > 80) console.log(`  … and ${unknownFiles.length - 80} more`);
    }
    console.log(DRY ? '\nRun again with --live to apply.\n' : '');
    return;
  }

  if (SYNC_MEDIA) {
    if (!STORE_INDEX) die('--sync-media needs credentials so it can read your store.');

    const seen = new Set();
    for (const r of renderItems) {
      const code = baseCode(r.code);
      if (ONLY && !ONLY.includes(code.toUpperCase())) continue;
      seen.add(code.toUpperCase());

      const hit = findInIndex(code);
      if (!hit) {
        // Staying silent here hides the real problem, which is usually that the product
        // has no SKU, no tag and no images — nothing left to match it by.
        if (ONLY) console.log(`✖ ${code.padEnd(12)} no product in the store matches this code`);
        continue;
      }

      const media = mediaForItem(r.files, r.code);
      const colours = cfg.colours.filter((c) => media[c.code]?.images.length);
      if (!colours.length) {
        if (ONLY) console.log(`✖ ${code.padEnd(12)} renders found, but none end in -R/-W/-Y + a number`);
        continue;
      }

      // What's already on the product, by original filename — normalised, so Shopify's
      // "_<uuid>" collision suffix doesn't make an existing render look missing and get
      // uploaded a second time. Uses media, not imageUrls, so videos count too.
      const have = new Set((hit.product.media || []).map((m) => normStem(m.stem)).filter(Boolean));

      const wanted = [];
      for (const c of colours) {
        const b = media[c.code] || { images: [], videos: [] };
        for (const f of [...b.images, ...(WITH_VIDEO ? b.videos : [])]) {
          wanted.push({ file: f, colour: c, stem: normStem(path.basename(f, path.extname(f))) });
        }
      }
      // Videos can never be matched by name — Shopify drops the filename on upload — so
      // they are reconciled by count. Only the SURPLUS is uploaded: if the product has 3
      // videos and Drive now has 5, two go up, not five. Treating "counts differ" as
      // "none are there" re-uploaded a product's whole video set whenever one was added.
      const videosOnProduct = (hit.product.media || []).filter((m) => m.kind === 'VIDEO' || isVideo(m.file)).length;
      const wantedVideos = wanted.filter((w) => isVideo(w.file));
      const videoSurplus = new Set(wantedVideos.slice(videosOnProduct).map((w) => w.file));
      if (wantedVideos.length && videosOnProduct && videoSurplus.size) {
        console.log(`  ${code.padEnd(12)} ${videosOnProduct} video(s) already on the product, adding ${videoSurplus.size}`);
      }

      const missing = FORCE
        ? wanted
        : wanted.filter((w) => (isVideo(w.file) ? videoSurplus.has(w.file) : !have.has(w.stem)));

      if (!missing.length) {
        console.log(`= ${code.padEnd(12)} all ${wanted.length} render(s) already on the product`);
        continue;
      }

      // --force replaces this item's OWN renders. Anything else on the product — model
      // shots, lifestyle photos, anything not from the render folder — is left alone
      // unless --wipe is passed as well.
      const ourStems = new Set(r.files.map((f) => normStem(path.basename(f, path.extname(f)))));
      const codeRx = new RegExp(`^${rxEsc(code.toLowerCase())}(?![0-9])`);
      const isOurs = (m) => ourStems.has(normStem(m.stem)) || codeRx.test(normStem(m.stem));
      const toRemove = !FORCE ? []
        : WIPE ? hit.product.media
        : hit.product.media.filter(isOurs);
      const kept = hit.product.media.filter((m) => !toRemove.some((d) => d.id === m.id));

      if (DRY) {
        console.log(`· ${code.padEnd(12)} ${FORCE ? 'replace with' : 'add'} ${missing.length} file(s)` +
          `${FORCE ? ` — removing ${toRemove.length}, keeping ${kept.length}` : ` — ${have.size} already there`}`);
        if (FORCE && kept.length) {
          for (const m of kept.slice(0, 8)) console.log(`      keep  ${m.file}`);
          if (kept.length > 8) console.log(`      keep  … and ${kept.length - 8} more`);
        }
        continue;
      }

      try {
        if (FORCE && toRemove.length) {
          const d = await gql(
            `mutation($productId: ID!, $mediaIds: [ID!]!) {
               productDeleteMedia(productId: $productId, mediaIds: $mediaIds) {
                 deletedMediaIds
                 mediaUserErrors { field message }
               }
             }`,
            { productId: hit.product.id, mediaIds: toRemove.map((m) => m.id) }
          );
          checkErrors(d.productDeleteMedia, 'productDeleteMedia');
          console.log(`  ${code.padEnd(12)} removed ${toRemove.length}, kept ${kept.length}`);
        }

        let n = 0;
        for (const w of missing) {
          const source = await stageUpload(w.file);
          const d = await gql(
            `mutation($productId: ID!, $media: [CreateMediaInput!]!) {
               productCreateMedia(productId: $productId, media: $media) {
                 media { ... on MediaImage { id } ... on Video { id } }
                 mediaUserErrors { field message }
               }
             }`,
            {
              productId: hit.product.id,
              media: [{
                originalSource: source,
                mediaContentType: isVideo(w.file) ? 'VIDEO' : 'IMAGE',
                alt: altTextFor(w.colour, hit.product.title),
              }],
            }
          );
          checkErrors(d.productCreateMedia, 'productCreateMedia');
          n++;
          process.stdout.write(`\r  ${code.padEnd(12)} uploading ${n}/${missing.length}…   `);
        }
        process.stdout.write('\r');
        console.log(`✓ ${code.padEnd(12)} ${n} file(s) uploaded`);
      } catch (e) {
        console.log(`✖ ${code.padEnd(12)} ${e.message.slice(0, 90)}`);
      }
    }
    console.log('');
    if (ONLY) {
      const absent = ONLY.filter((c) => !seen.has(c.toUpperCase()));
      if (absent.length) console.log(`\n✖ No render folder found for: ${absent.join(', ')}`);
    }

    return;
  }

  if (SYNC_INVENTORY) {
    if (!STORE_INDEX) die('--sync-inventory needs credentials so it can read your store.');
    const want = !!cfg.defaults.trackInventory;   // false = "Track quantity" unticked

    let fixed = 0, already = 0;
    for (const p of STORE_INDEX) {
      const wrong = (p.variants || []).filter((v) => v.inventoryItemId && v.tracked !== want);
      if (!wrong.length) { already++; continue; }

      if (DRY) {
        console.log(`· ${p.title.slice(0, 52).padEnd(52)} ${wrong.length} variant(s) -> tracked ${want}`);
        fixed++;
        continue;
      }

      let ok = 0;
      for (const v of wrong) {
        try {
          const data = await gql(
            `mutation($id: ID!, $input: InventoryItemInput!) {
               inventoryItemUpdate(id: $id, input: $input) {
                 inventoryItem { id tracked }
                 userErrors { field message }
               }
             }`,
            { id: v.inventoryItemId, input: { tracked: want } }
          );
          checkErrors(data.inventoryItemUpdate, 'inventoryItemUpdate');
          ok++;
        } catch (e) {
          console.log(`✖ ${p.title.slice(0, 40)} — ${e.message.slice(0, 70)}`);
          break;
        }
      }
      if (ok) {
        console.log(`✓ ${p.title.slice(0, 52).padEnd(52)} ${ok} variant(s)`);
        fixed++;
      }
    }

    console.log(`\n${fixed} product(s) ${DRY ? 'would be' : ''} changed, ${already} already set to ${want ? 'tracked' : 'not tracked'}.\n`);
    return;
  }

  if (OPTIONS_REPORT) {
    if (!STORE_INDEX) die('--options needs credentials so it can read your store.');

    // What variant options do the products in this store actually use?
    const byName = new Map();
    for (const p of STORE_INDEX) {
      for (const v of p.variants || []) {
        for (const pair of (v.options || '').split(' | ')) {
          const [name, ...rest] = pair.split('=');
          const value = rest.join('=');
          if (!name || name === 'Title') continue;
          if (!byName.has(name)) byName.set(name, new Map());
          const vals = byName.get(name);
          vals.set(value, (vals.get(value) || 0) + 1);
        }
      }
    }

    for (const [name, vals] of [...byName].sort((a, z) => z[1].size - a[1].size)) {
      const products = STORE_INDEX.filter((p) =>
        (p.variants || []).some((v) => (v.options || '').startsWith(name + '='))).length;
      console.log(`\nOption "${name}"  — used on ${products} product(s), ${vals.size} distinct value(s)`);
      for (const [val, n] of [...vals].sort((a, z) => z[1] - a[1])) {
        console.log(`    ${String(n).padStart(4)} x  ${val}`);
      }
    }
    console.log('');
    return;
  }

  if (CHANNELS) {
    if (!STORE_INDEX) die('--channels needs credentials so it can read your store.');
    const wanted = (cfg.publishTo?.length ? cfg.publishTo : ['Online Store']).map((x) => String(x).toLowerCase());
    try {
      const d = await gql(`{ publications(first: 50) { nodes { id name } } }`);
      const all = d.publications?.nodes || [];
      if (!all.length) { console.log('No sales channels came back.\n'); return; }
      console.log(`Sales channels on this store — ✓ means config.json publishTo includes it:\n`);
      for (const c of all) {
        const on = wanted.some((w) => c.name.toLowerCase().includes(w));
        console.log(`  ${on ? '✓' : ' '} ${c.name}`);
      }
      console.log(`\nTo publish to more, add their names to "publishTo" in config.json.\n`);
    } catch (e) {
      console.log(`✖ Could not read sales channels: ${e.message.slice(0, 120)}`);
      console.log(`  This almost always means the app is missing read_publications.\n`);
    }
    return;
  }

  if (PUBLISH) {
    if (!STORE_INDEX) die('--publish needs credentials so it can read your store.');

    // A product only goes live if it is actually finished. Anything failing this stays
    // a draft — that is the whole point of the drafts.
    const ready = [], notReady = [];
    for (const p of STORE_INDEX) {
      const problems = [];
      if (/^untitled/i.test(p.title)) problems.push('placeholder title');
      if (!p.description || p.description.trim().length < 80) problems.push('no description');
      if (!p.prices.length || p.prices.some((x) => Number(x) === 0)) problems.push('price at 0');
      if (!p.mediaCount) problems.push('no images');
      // Being active already is not a problem — those are precisely the ones that still
      // need putting on the Online Store channel.
      (problems.length ? notReady : ready).push({ p, problems });
    }

    console.log(`${ready.length} ready to publish, ${notReady.length} not.\n`);
    for (const { p, problems } of notReady) {
      console.log(`  ${p.title.slice(0, 46).padEnd(46)} ${problems.join('; ')}`);
    }
    if (!ready.length) { console.log(''); return; }

    const toActivate = ready.filter((r) => r.p.status !== 'ACTIVE');
    const toPublish = ready.filter((r) => !r.p.onlineStoreUrl);
    console.log(`\nReady: ${toActivate.length} to set Active, ${toPublish.length} to put on the Online Store.`);
    for (const { p } of ready) {
      const need = [p.status !== 'ACTIVE' ? 'activate' : null, !p.onlineStoreUrl ? 'publish' : null]
        .filter(Boolean).join(' + ') || 'nothing to do';
      console.log(`  ${p.title.slice(0, 52).padEnd(52)} ${need}`);
    }

    if (DRY) {
      console.log(`\nRun with --live to set these ${ready.length} to Active and publish them.\n`);
      return;
    }

    // Which sales channels to put products on. Defaults to Online Store alone; add more
    // names to "publishTo" in config.json and they all get published in one pass.
    const wanted = cfg.publishTo?.length ? cfg.publishTo : ['Online Store'];
    let pubs = [];
    let pub = null;
    try {
      const d = await gql(`{ publications(first: 50) { nodes { id name } } }`);
      const all = d.publications?.nodes || [];
      pubs = wanted
        .map((w) => all.find((x) => x.name.toLowerCase() === String(w).toLowerCase())
                 || all.find((x) => x.name.toLowerCase().includes(String(w).toLowerCase())))
        .filter(Boolean);
      const missing = wanted.filter((w) => !pubs.some((x) => x.name.toLowerCase().includes(String(w).toLowerCase())));
      if (missing.length) {
        console.log(`\n⚠ Not a sales channel on this store: ${missing.join(', ')}`);
        console.log(`  Channels available: ${all.map((x) => x.name).join(', ') || '(none readable)'}`);
      }
      pub = pubs[0] || null;
    } catch (e) {
      console.log(`\n⚠ Could not read sales channels: ${e.message.slice(0, 80)}`);
      console.log(`  If that says access denied, the app needs read_publications and`);
      console.log(`  write_publications. Products will be set Active but stay off the`);
      console.log(`  Online Store until those scopes are added.`);
    }

    let done = 0, scopeWarned = false;
    for (const { p } of ready) {
      if (p.status === 'ACTIVE' && p.onlineStoreUrl) continue;
      try {
        if (p.status !== 'ACTIVE') {
          const d = await gql(
            `mutation($input: ProductInput!) {
               productUpdate(input: $input) { product { id status } userErrors { field message } }
             }`,
            { input: { id: p.id, status: 'ACTIVE' } }
          );
          checkErrors(d.productUpdate, 'productUpdate');
        }

        if (pubs.length) {
          const pd = await gql(
            `mutation($id: ID!, $input: [PublicationInput!]!) {
               publishablePublish(id: $id, input: $input) { userErrors { field message } }
             }`,
            { id: p.id, input: pubs.map((x) => ({ publicationId: x.id })) }
          );
          checkErrors(pd.publishablePublish, 'publishablePublish');
        }
        console.log(`✓ ${p.title.slice(0, 60)}`);
        done++;
      } catch (e) {
        const msg = e.message;
        if (/access denied|scope/i.test(msg)) {
          if (!scopeWarned) {
            console.log(`\n⚠ The app can't touch sales channels — it needs read_publications`);
            console.log(`  and write_publications. Add both in the Dev Dashboard, release a new`);
            console.log(`  version, then run this again. Status changes still worked.\n`);
            scopeWarned = true;
          }
          continue;
        }
        console.log(`✖ ${p.title.slice(0, 50)} — ${msg.slice(0, 80)}`);
      }
    }
    console.log(`\n${done} published${pubs.length ? ' to ' + pubs.map((x) => x.name).join(', ') : ' (status only — no sales channel reachable)'}.\n`);
    return;
  }

  if (SYNC_COLLECTIONS) {
    if (!STORE_INDEX) die('--sync-collections needs credentials so it can read your store.');

    // Group by collection so each one is a single call rather than one per product.
    const byCollection = new Map();
    const facetCollections = new Map();
    const unmapped = [];
    for (const r of renderItems) {
      const code = baseCode(r.code);
      if (ONLY && !ONLY.includes(code.toUpperCase())) continue;
      const hit = findInIndex(code);
      if (!hit) continue;

      const titles = collectionsFor(code);
      if (!titles.length) { unmapped.push(code); continue; }
      const facetTitles = facetCollectionsFor(hit.product.title, titles[titles.length - 1]);
      for (const t of titles) {
        if (!byCollection.has(t)) byCollection.set(t, []);
        byCollection.get(t).push({ code, id: hit.product.id });
      }
      for (const t of facetTitles) {
        if (titles.includes(t)) continue;
        if (!facetCollections.has(t)) facetCollections.set(t, []);
        facetCollections.get(t).push({ code, id: hit.product.id });
      }
    }

    // Category collections first (created if missing), then facet ones (never created).
    for (const [title, entries] of [...byCollection, ...facetCollections]) {
      const col = await resolveCollection(title, !DRY && byCollection.has(title));
      if (!col) {
        if (byCollection.has(title)) console.log(`✖ ${title.padEnd(26)} no collection with that title`);
        else if (!DRY || SHOW_SKIPPED) console.log(`· ${title.padEnd(26)} not a collection in the store — skipped`);
        continue;
      }
      if (DRY) {
        console.log(`· ${title.padEnd(26)} ${entries.length}: ${entries.map((e) => e.code).join(', ')}`);
        continue;
      }
      try {
        const data = await gql(
          `mutation($id: ID!, $productIds: [ID!]!) {
             collectionAddProductsV2(id: $id, productIds: $productIds) {
               job { id }
               userErrors { field message }
             }
           }`,
          { id: col.id, productIds: entries.map((e) => e.id) }
        );
        checkErrors(data.collectionAddProductsV2, 'collectionAddProductsV2');
        console.log(`✓ ${title.padEnd(26)} ${entries.length} product(s) added`);
      } catch (e) {
        const msg = e.message;
        if (/automat|smart|rule/i.test(msg)) {
          console.log(`✖ ${title.padEnd(18)} this is an automated collection — products join by rule, not by hand`);
        } else {
          console.log(`✖ ${title.padEnd(18)} ${msg.slice(0, 90)}`);
        }
      }
    }

    if (unmapped.length) {
      console.log(`\nNo collection mapped for: ${[...new Set(unmapped)].join(', ')}`);
      console.log(`Add the code prefix to "collections" in config.json.`);
    }
    console.log('');
    return;
  }

  if (SYNC_CATEGORIES) {
    if (!STORE_INDEX) die('--sync-categories needs credentials so it can read your store.');
    let fixed = 0, missed = [];

    for (const r of renderItems) {
      const code = baseCode(r.code);
      if (ONLY && !ONLY.includes(code.toUpperCase())) continue;

      const hit = findInIndex(code);
      if (!hit) continue;

      const cat = await resolveCategory(code);
      if (!cat) { missed.push(code); continue; }

      if (DRY) {
        console.log(`· ${code.padEnd(12)} ${cat.fullName}`);
      } else {
        try {
          const data = await gql(
            `mutation($input: ProductInput!) {
               productUpdate(input: $input) { product { id } userErrors { field message } }
             }`,
            { input: { id: hit.product.id, category: cat.id } }
          );
          checkErrors(data.productUpdate, 'productUpdate');
          console.log(`✓ ${code.padEnd(12)} ${cat.fullName}`);
        } catch (e) {
          console.log(`✖ ${code.padEnd(12)} ${e.message.slice(0, 90)}`);
          continue;
        }
      }
      fixed++;
    }

    console.log(`\n${fixed} ${DRY ? 'would be set' : 'set'}.`);
    if (missed.length) {
      console.log(`No category mapping for: ${[...new Set(missed)].join(', ')}`);
      console.log(`Add the code prefix to "categories" in config.json.`);
    }
    console.log('');
    return;
  }

  // Work out which configured material a live variant represents. Products have been
  // created in two shapes over time, so try each in turn rather than assuming one.
  function materialOf(v, code) {
    if (v.material) {
      const m = cfg.materials.find((x) => x.label === v.material);
      if (m) return m;
      // Generic values like "Gold" / "White gold" that predate the karat labels. Without
      // this they resolve to nothing, so every reprice skipped them and they sat at an old
      // price while the product still looked correct. config.materialAliases maps them.
      const alias = (cfg.materialAliases || {})[String(v.material).trim().toLowerCase()];
      if (alias) {
        const am = cfg.materials.find((x) => x.label === alias);
        if (am) return am;
      }
    }
    if (v.legacyMetal) {
      const LEGACY = { '925 SILVER': 'S925', '18K GOLD': 'G18K', '14K GOLD': 'G14K', '10K GOLD': 'G10K' };
      const metal = LEGACY[v.legacyMetal.toUpperCase()];
      const colour = (v.legacyColour || '').charAt(0).toUpperCase();
      const m = cfg.materials.find((x) => x.metal === metal && (!colour || x.colour === colour));
      if (m) return m;
    }
    // SKU was written as CODE-METAL-COLOUR, so it still identifies the variant.
    const m2 = String(v.sku || '').match(new RegExp(`^${rxEsc(code)}-(S925|G10K|G14K|G18K)-([RWY])`, 'i'));
    if (m2) {
      const m = cfg.materials.find((x) => x.metal === m2[1].toUpperCase() && x.colour === m2[2].toUpperCase());
      if (m) return m;
    }
    return null;
  }

  if (SYNC_PRICES) {
    if (!STORE_INDEX) die('--sync-prices needs credentials so it can read your store.');
    let fixed = 0, skipped = 0, noPrice = [];

    for (const r of renderItems) {
      const code = baseCode(r.code);
      if (ONLY && !ONLY.includes(code.toUpperCase())) continue;

      // price-list.csv (RETAIL) wins over packing-list.csv (the accountant's COST sheet).
      // The old order put the cost sheet first, so the 22 products it covers went live at
      // cost — AJLB53 at $130 against a $1,100 retail price. The cost sheet is now only a
      // fallback for a code with no retail price at all.
      const item = (priceList.has(code.toUpperCase())
        ? itemFromPriceList(code, priceList.get(code.toUpperCase()))
        : null) || sheetByCode.get(code.toUpperCase());
      if (!item) { noPrice.push(code); continue; }

      const hit = findInIndex(code);
      if (!hit) continue;

      // Match each live variant to its metal via the Material option, then to a price.
      const updates = [];
      let unmatched = 0;
      for (const v of hit.product.variants || []) {
        const mat = materialOf(v, code);
        if (!mat) { unmatched++; continue; }
        const row = item.rows.find((x) => x.metal.key === mat.metal);
        if (!row || row.price == null) continue;
        // Only touch a price that is zero, unless a full rewrite is asked for.
        if (Number(v.price) !== 0 && !FORCE) continue;
        // A bangle's larger sizes cost more, so each size gets its own price here rather
        // than every size being reset to the base until --sync-bangles runs.
        let price = row.price;
        const bangle = bangleFor(code);
        const size = bangle && bangle.sizes.find((s) => s.label === variantOption(v, bangle.optionName || 'Size'));
        if (size && Number(row.price) > 0) price = banglePrice(Number(row.price), size).toFixed(2);
        if (Number(v.price) === Number(price)) continue;
        updates.push({ id: v.id, price });
      }
      if (!updates.length) {
        // Say so rather than counting a failure to match as "already correct".
        if (unmatched) {
          const sample = (hit.product.variants || [])[0];
          console.log(`? ${code.padEnd(12)} couldn't match ${unmatched} variant(s) to a material`);
          if (sample) console.log(`  ${''.padEnd(12)} first variant: sku=${sample.sku || '(none)'}  options: ${sample.options || '(none)'}`);
        }
        skipped++;
        continue;
      }

      if (DRY) {
        console.log(`· ${code.padEnd(12)} ${updates.length} variant(s) — e.g. $${updates[0].price}`);
      } else {
        try {
          const data = await gql(
            `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
               productVariantsBulkUpdate(productId: $productId, variants: $variants) {
                 productVariants { id price }
                 userErrors { field message }
               }
             }`,
            { productId: hit.product.id, variants: updates }
          );
          checkErrors(data.productVariantsBulkUpdate, 'productVariantsBulkUpdate');
          console.log(`✓ ${code.padEnd(12)} ${updates.length} variant price(s) set`);
        } catch (e) {
          console.log(`✖ ${code.padEnd(12)} ${e.message}`);
          continue;
        }
      }
      fixed++;
    }

    console.log(`\n${fixed} product${fixed === 1 ? '' : 's'} ${DRY ? 'would be repriced' : 'repriced'}, ${skipped} already correct.`);
    if (noPrice.length) console.log(`No price anywhere for: ${noPrice.join(', ')}`);
    console.log('');
    return;
  }





  if (RENAME) {
    if (!STORE_INDEX) die('--rename needs credentials so it can read your store.');
    if (!RENAME_TO) die('--rename needs a new title:\n  node import.js --rename "old words" --to "New Title"');

    const needle = RENAME.trim().toLowerCase();
    const hits = STORE_INDEX.filter((p) => String(p.title).toLowerCase().includes(needle));

    if (!hits.length) die(`No product title contains "${RENAME}".`);
    // Renaming the wrong product is not easily undone, so an ambiguous match stops here.
    if (hits.length > 1) {
      console.log(`"${RENAME}" matches ${hits.length} products — be more specific:\n`);
      for (const p of hits) console.log(`  ${p.title}`);
      console.log('');
      return;
    }

    const p = hits[0];
    console.log(`  old:  ${p.title}`);
    console.log(`  new:  ${RENAME_TO}\n`);
    if (p.title === RENAME_TO) { console.log('Already that title — nothing to do.\n'); return; }

    if (DRY) {
      console.log('Dry run — nothing changed. Add --live to apply.');
      console.log('The web address (handle) stays as it is, so existing links keep working.\n');
      return;
    }
    try {
      const d = await gql(
        `mutation($input: ProductInput!) {
           productUpdate(input: $input) { product { id title } userErrors { field message } }
         }`,
        { input: { id: p.id, title: RENAME_TO } }
      );
      checkErrors(d.productUpdate, 'productUpdate');
      console.log(`✓ renamed\n`);
    } catch (e) {
      console.log(`✖ ${e.message.slice(0, 120)}\n`);
    }
    return;
  }






  if (RESTORE_DESC) {
    if (!STORE_INDEX) die('--restore-descriptions needs credentials so it can read your store.');
    const file = RESTORE_DESC === true ? null : RESTORE_DESC;
    const pick = file || fs.readdirSync('.').filter((f) => /^descriptions-before-.*\.json$/.test(f)).sort().pop();
    if (!pick) die('No descriptions-before-*.json file found here.');
    if (!fs.existsSync(pick)) die(`No such file: ${pick}`);

    const saved = JSON.parse(fs.readFileSync(pick, 'utf8'));
    const byId = new Map(saved.map((r) => [r.id, r]));
    console.log(`Restoring from ${pick} — ${saved.length} products saved.\n`);

    let done = 0, same = 0, missing = 0;
    for (const p of STORE_INDEX) {
      if (ONLY || PRODUCT_FILTER) {
        const hay = `${p.title} ${p.haystacks.sku} ${p.haystacks.media}`.toUpperCase();
        const wanted = ONLY ? ONLY.some((c) => hay.includes(c))
          : String(p.title).toLowerCase().includes(PRODUCT_FILTER.toLowerCase());
        if (!wanted) continue;
      }
      const was = byId.get(p.id);
      if (!was) { missing++; continue; }
      if ((was.descriptionHtml || '') === (p.descriptionHtml || '')) { same++; continue; }

      if (DRY) { console.log(`· ${p.title.slice(0, 58)}`); done++; continue; }
      try {
        const d = await gql(
          `mutation($input: ProductInput!) {
             productUpdate(input: $input) { product { id } userErrors { field message } }
           }`,
          { input: { id: p.id, descriptionHtml: was.descriptionHtml || '' } }
        );
        checkErrors(d.productUpdate, 'productUpdate');
        console.log(`✓ ${p.title.slice(0, 58)}`);
        done++;
      } catch (e) { console.log(`✖ ${p.title.slice(0, 40)} ${e.message.slice(0, 80)}`); }
    }

    console.log(`\n${done} restored, ${same} already matched the backup, ${missing} not in it.`);
    if (DRY) console.log('Dry run — nothing changed. Add --live to apply.\n');
    else console.log('Now re-run --sync-specs to put the spec list back under the copy.\n');
    return;
  }



  if (IGNORED_REPORT) {
    // Folders indexRenderItems drops before anything else runs, so they never appear in
    // any other report. If a new batch lands under an ignored prefix it looks like
    // nothing arrived at all — this is the only place that shows them.
    const roots = [cfg.imagesDir, ...(cfg.extraImagesDirs || [])].filter((d) => fs.existsSync(d));
    const known = new Set(renderItems.map((r) => baseCode(r.code).toUpperCase()));
    const rows = [];
    for (const root of roots) {
      for (const cat of fs.readdirSync(root, { withFileTypes: true })) {
        if (cat.name.startsWith('.') || !cat.isDirectory()) continue;
        const catDir = path.join(root, cat.name);
        for (const e of fs.readdirSync(catDir, { withFileTypes: true })) {
          if (e.name.startsWith('.') || !e.isDirectory()) continue;
          const code = baseCode(e.name).toUpperCase();
          if (known.has(code)) continue;
          let files = 0;
          try { files = fs.readdirSync(path.join(catDir, e.name)).filter((f) => !f.startsWith('.')).length; } catch {}
          const hitPrefix = IGNORE_PREFIXES.find((x) => e.name.toUpperCase().startsWith(x));
          rows.push({ cat: cat.name, folder: e.name, files, why: hitPrefix ? `ignorePrefixes "${hitPrefix}"` : 'no usable media' });
        }
      }
    }
    if (!rows.length) { console.log('Nothing in the render folders is being skipped.\n'); return; }
    console.log(`${rows.length} folder(s) in Drive are NOT being imported:\n`);
    for (const r of rows) console.log(`  ${r.cat}/${r.folder.padEnd(24)} ${String(r.files).padStart(3)} files   ${r.why}`);
    const byPrefix = rows.filter((r) => /ignorePrefixes/.test(r.why));
    if (byPrefix.length) {
      console.log(`\n${byPrefix.length} are skipped only because of "ignorePrefixes": ${JSON.stringify(cfg.ignorePrefixes || [])}`);
      console.log('To import one of them, add its code to "includeCodes" in config.json,');
      console.log('or remove the prefix from "ignorePrefixes" to take the whole supplier.');
    }
    console.log('');
    return;
  }



  if (VERIFY) {
    if (!STORE_INDEX) die('--verify needs credentials so it can read your store.');

    const lenOptName = cfg.lengthOption || 'Length';
    const canonMetals = (cfg.materials || []).map((m) => m.label);
    const rows = [];
    const matched = new Set();

    // Publication state needs a scope this app may not have; without it that one check
    // is reported as unknown rather than silently passing.
    let pubById = null;
    try {
      const m = new Map();
      let c = null;
      for (;;) {
        const d = await gql(
          `query($cursor: String) { products(first: 50, after: $cursor) {
             pageInfo { hasNextPage endCursor }
             nodes { id resourcePublicationsV2(first: 10) { nodes { isPublished publication { name } } } } } }`,
          { cursor: c }
        );
        for (const n of d.products.nodes) {
          m.set(n.id, (n.resourcePublicationsV2?.nodes || [])
            .filter((x) => x.isPublished).map((x) => x.publication?.name));
        }
        if (!d.products.pageInfo.hasNextPage) break;
        c = d.products.pageInfo.endCursor;
      }
      pubById = m;
    } catch { pubById = null; }

    for (const r of renderItems) {
      const code = baseCode(r.code).toUpperCase();
      if (ONLY && !ONLY.includes(code)) continue;
      const hit = findInIndex(code);
      if (!hit) { rows.push({ code, title: '(not in store)', issues: ['NOT IN STORE'] }); continue; }
      const p = hit.product;
      matched.add(p.id);
      const issues = [];

      // ---- what this product SHOULD be, from the source files ----
      // Retail first, same as everywhere else. With the cost sheet first, verify compared a
      // live cost price against an expected cost price and called the product clean.
      const item = (priceList.has(code) ? itemFromPriceList(code, priceList.get(code)) : null)
        || sheetByCode.get(code);
      const media = mediaForItem(r.files, r.code);
      const plan = item ? planItem(item, media) : null;
      const wantMetals = plan && plan.materials.length ? plan.materials.map((m) => m.label) : [];
      const basePrice = new Map((plan?.materials || []).map((m) => [m.label, Number(m.price)]));
      const cat = categoryOfCode(code, p.title);
      const bangle = bangleFor(code);
      const sizeOptName = bangle ? (bangle.optionName || 'Size') : lenOptName;
      const realOpts = (p.options || []).filter((o) => o.name !== 'Title');
      const hasLen = realOpts.some((o) => o.name === sizeOptName);
      // A bangle must always have its sizes, so a missing Size option shows as missing variants.
      const wantLens = bangle ? bangle.sizes.map((s) => s.label)
        : hasLen && cat && (cfg.lengths || {})[cat] ? cfg.lengths[cat] : [null];

      // ---- options ----
      const metalOpt = realOpts.find((o) => o.name === cfg.optionName);
      if (!metalOpt) issues.push(`option not called "${cfg.optionName}"`);
      const strays = realOpts.filter((o) => o.name !== cfg.optionName && o.name !== sizeOptName);
      if (strays.length) issues.push(`extra option: ${strays.map((o) => o.name).join(', ')}`);

      // ---- variants: every metal x length present, priced right ----
      const actual = new Map();
      for (const v of p.variants || []) {
        const parts = Object.fromEntries(String(v.options).split(' | ')
          .map((x) => { const i = x.indexOf('='); return [x.slice(0, i), x.slice(i + 1)]; }));
        const key = `${parts[cfg.optionName] || ''}||${parts[sizeOptName] || ''}`;
        actual.set(key, v);
      }
      if (!wantMetals.length) issues.push('no price in price-list.csv');
      const missing = [], badPrice = [], zero = [], noSku = [];
      for (const metal of wantMetals) {
        for (const len of wantLens) {
          const v = actual.get(`${metal}||${len || ''}`);
          if (!v) { missing.push(`${metal}${len ? ' ' + len : ''}`); continue; }
          const b = basePrice.get(metal) ?? 0;
          const size = bangle && len ? bangle.sizes.find((s) => s.label === len) : null;
          const want = b <= 0 ? 0
            : size ? banglePrice(b, size)
            : roundPrice(Math.max(0, b + (len ? lengthDeltaFor(cat, len) : 0)));
          const got = Number(v.price);
          if (got === 0 && want > 0) zero.push(`${metal}${len ? ' ' + len : ''}`);
          else if (Math.abs(got - want) > 0.01) badPrice.push(`${metal}${len ? ' ' + len : ''}: ${got} want ${want.toFixed(2)}`);
          if (!v.sku) noSku.push(`${metal}${len ? ' ' + len : ''}`);
          if (v.tracked) issues.push('inventory still tracked');
        }
      }
      // Variants the plan does not expect. Nothing above looks at these, because the loop
      // walks the EXPECTED combinations and looks each one up. An extra variant — a metal
      // or length no longer offered, or one left behind with a blank length when the Length
      // option was added — is therefore never repriced and never reported, so it keeps an
      // old price on the storefront while this check calls the product clean.
      if (wantMetals.length) {
        const expected = new Set();
        for (const m of wantMetals) for (const l of wantLens) expected.add(`${m}||${l || ''}`);
        const extra = [];
        for (const [k, v] of actual) {
          if (expected.has(k)) continue;
          const [m, l] = k.split('||');
          extra.push(`${m || '(no metal)'}${l ? ' ' + l : ' (no length)'} @ ${v.price}`);
        }
        if (extra.length) {
          issues.push(`${extra.length} unexpected variant(s), never repriced: ${extra.slice(0, 3).join('; ')}${extra.length > 3 ? '…' : ''}`);
        }
      }
      if (missing.length) issues.push(`${missing.length} variant(s) missing: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? '…' : ''}`);
      if (zero.length) issues.push(`${zero.length} variant(s) priced 0`);
      if (badPrice.length) issues.push(`${badPrice.length} wrong price — ${badPrice[0]}`);
      if (noSku.length) issues.push(`${noSku.length} variant(s) with no SKU`);

      // ---- media ----
      const coloursWithRenders = cfg.colours.filter((c) => media[c.code]?.images.length).map((c) => c.code);
      const onProduct = new Set();
      for (const m of p.media || []) {
        const t = /-([A-Za-z])\s*\d*$/.exec(normStem(m.stem));
        if (t) onProduct.add(t[1].toUpperCase());
      }
      const missingColours = coloursWithRenders.filter((c) => !onProduct.has(c));
      if (missingColours.length) issues.push(`no image uploaded for: ${missingColours.join(', ')}`);
      if (!(p.media || []).length) issues.push('no media at all');

      // ---- content ----
      const want = CONTENT?.[code];
      if (!want) issues.push('no entry in product-content.json');
      else if (String(p.title).trim() !== String(want.title).trim()) issues.push(`title differs from product-content.json`);
      const dh = String(p.descriptionHtml || '');
      if (!dh.trim()) issues.push('description empty');
      else {
        if (!dh.includes(SPEC_MARK) && !dh.includes(SPEC_MARK_OLD)) issues.push('no spec list');
        if ((dh.match(/Key Features/gi) || []).length > 1) issues.push('Key Features appears twice');
        if (/Diamond Details/i.test(dh)) issues.push('old "Diamond Details" section still present');
      }

      // ---- status ----
      if (p.status !== 'ACTIVE') issues.push(`status ${p.status}`);
      if (pubById) {
        const chans = pubById.get(p.id) || [];
        if (!chans.some((n) => /online store/i.test(n))) issues.push('not on the Online Store');
      }

      rows.push({ code, title: p.title, issues });
    }

    // products in the store that no render folder claims
    const orphans = STORE_INDEX.filter((p) => !matched.has(p.id));

    const bad = rows.filter((r) => r.issues.length);
    const good = rows.length - bad.length;

    console.log(`Checked ${rows.length} product(s) against Drive, price-list.csv and product-content.json.\n`);
    console.log(`  ✓ ${good} with nothing wrong`);
    console.log(`  ✖ ${bad.length} with something to fix`);
    if (orphans.length) console.log(`  ? ${orphans.length} in the store with no render folder (hand-built)`);
    if (!pubById) console.log(`  (publication check skipped — no read_publications scope)`);
    console.log('');

    // grouped by issue, so one fix can be applied across everything that needs it
    const byIssue = new Map();
    for (const r of bad) for (const i of r.issues) {
      const k = i.replace(/\d+/g, 'N').replace(/:.*$/, '');
      if (!byIssue.has(k)) byIssue.set(k, []);
      byIssue.get(k).push(r.code);
    }
    console.log('── BY PROBLEM ──\n');
    for (const [k, codes] of [...byIssue].sort((a, z) => z[1].length - a[1].length)) {
      console.log(`  ${String(codes.length).padStart(3)}  ${k}`);
      console.log(`       ${codes.slice(0, 10).join(' ')}${codes.length > 10 ? ` …+${codes.length - 10}` : ''}`);
    }

    if (bad.length) {
      console.log('\n── BY PRODUCT ──\n');
      for (const r of bad) {
        console.log(`  ${r.code.padEnd(11)} ${r.title.slice(0, 46)}`);
        for (const i of r.issues) console.log(`       ${i}`);
      }
    }
    if (orphans.length) {
      console.log('\n── HAND-BUILT (no render folder, this script does not manage them) ──\n');
      for (const p of orphans) console.log(`  ${p.title.slice(0, 60)}`);
    }

    const file = `verify-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
    const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
    fs.writeFileSync(file, 'code,title,issues\n' +
      rows.map((r) => [esc(r.code), esc(r.title), esc(r.issues.join(' | '))].join(',')).join('\n') + '\n');
    console.log(`\nWritten to ${file}\n`);
    return;
  }

  if (SYNC_SKUS) {
    if (!STORE_INDEX) die('--sync-skus needs credentials so it can read your store.');

    // <CODE>-<METAL>-<COLOUR>, plus the length when the product has one — without it
    // every length of the same metal would share a SKU, which breaks order picking.
    const byLabel = new Map();
    for (const m of cfg.materials || []) byLabel.set(String(m.label).trim().toLowerCase(), m);
    const lenTag = (s) => String(s).replace(/\s+/g, '').replace(/in$/i, '').toUpperCase() + 'IN';

    const seen = new Map();   // sku -> "CODE (metal/length)", to catch collisions
    let set = 0, ok = 0, skipped = 0;

    for (const r of renderItems) {
      const code = baseCode(r.code).toUpperCase();
      if (ONLY && !ONLY.includes(code)) continue;
      const hit = findInIndex(code);
      if (!hit) continue;
      const p = hit.product;
      // A bangle's SKUs carry its size (…-S, …-M, …-L) and are set by --sync-bangles.
      if (bangleFor(code)) continue;

      const d0 = await gql(
        `query($id: ID!) { product(id: $id) { variants(first: 250) {
           nodes { id sku selectedOptions { name value } } } } }`,
        { id: p.id }
      );
      const updates = [];
      let unmatched = 0;
      for (const v of d0.product?.variants?.nodes || []) {
        const metalLabel = (v.selectedOptions.find((o) => o.name === cfg.optionName) || {}).value;
        const m = metalLabel ? byLabel.get(String(metalLabel).trim().toLowerCase()) : null;
        if (!m) { unmatched++; continue; }
        // Length is deliberately left out — config.json "skuIncludesLength": true adds it.
        const len = cfg.skuIncludesLength
          ? (v.selectedOptions.find((o) => o.name === (cfg.lengthOption || 'Length')) || {}).value
          : null;
        const sku = `${code}-${m.metal}-${m.colour}${len ? `-${lenTag(len)}` : ''}`;

        const where = `${code} ${metalLabel}${len ? ` ${len}` : ''}`;
        if (seen.has(sku) && seen.get(sku) !== where && cfg.skuIncludesLength) {
          console.log(`✖ ${sku} would be used twice: ${seen.get(sku)} and ${where}`);
        } else seen.set(sku, where);

        if (v.sku === sku) { ok++; continue; }
        // An existing different SKU is left alone unless --force, in case it is one
        // someone set deliberately.
        if (v.sku && !FORCE) { skipped++; continue; }
        updates.push({ id: v.id, inventoryItem: { sku } });
      }
      if (unmatched) console.log(`⚠ ${code.padEnd(11)} ${unmatched} variant(s) have a metal not in config — no SKU built`);
      if (!updates.length) continue;

      console.log(`${DRY ? '·' : ' '} ${code.padEnd(11)} ${updates.length} SKU(s)  e.g. ${updates[0].inventoryItem.sku}`);
      set += updates.length;
      if (DRY) continue;
      try {
        for (let i = 0; i < updates.length; i += 100) {
          const d = await gql(
            `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
               productVariantsBulkUpdate(productId: $productId, variants: $variants) {
                 userErrors { field message }
               }
             }`,
            { productId: p.id, variants: updates.slice(i, i + 100) }
          );
          checkErrors(d.productVariantsBulkUpdate, 'productVariantsBulkUpdate');
        }
        console.log(`✓ ${code.padEnd(11)} ${updates.length} SKU(s) set`);
      } catch (e) {
        console.log(`✖ ${code.padEnd(11)} ${e.message.slice(0, 120)}`);
      }
    }

    console.log(`\n${set} SKU(s) ${DRY ? 'would be' : ''} set, ${ok} already correct, ${skipped} left alone (already had one — use --force to overwrite).`);
    if (DRY) console.log('Dry run — nothing changed. Add --live to apply.\n'); else console.log('');
    return;
  }

  if (SYNC_VARIANT_IMAGES) {
    if (!STORE_INDEX) die('--sync-variant-images needs credentials so it can read your store.');

    // Every variant of a given metal should show that metal's render. The renders are
    // already on the product; nothing has ever told Shopify which one belongs to which
    // variant, which is why the variant rows show an empty image box.
    const colourOf = new Map();
    for (const m of cfg.materials || []) colourOf.set(String(m.label).trim().toLowerCase(), m.colour);

    let touched = 0, already = 0, noMedia = 0;
    for (const r of renderItems) {
      const code = baseCode(r.code);
      if (ONLY && !ONLY.includes(code.toUpperCase())) continue;
      const hit = findInIndex(code);
      if (!hit) continue;
      const p = hit.product;

      // One representative image per colour, preferred in filename order so the same
      // shot is used every time rather than whichever came back first.
      const pick = new Map();
      for (const m of (p.media || []).filter((x) => x.kind === 'IMAGE' && x.id)) {
        const tail = /-([A-Za-z])\s*(\d+)?$/.exec(normStem(m.stem));
        const col = tail ? tail[1].toUpperCase() : null;
        if (!col) continue;
        const seq = Number(tail[2] || 0);
        const cur = pick.get(col);
        if (!cur || seq < cur.seq) pick.set(col, { id: m.id, seq, file: m.file });
      }
      if (!pick.size) { noMedia++; if (SHOW_SKIPPED) console.log(`- ${code} no colour-tagged images`); continue; }

      const d0 = await gql(
        `query($id: ID!) { product(id: $id) { variants(first: 250) {
           nodes { id media(first: 1) { nodes { id } } selectedOptions { name value } } } } }`,
        { id: p.id }
      );
      const updates = [];
      for (const v of d0.product?.variants?.nodes || []) {
        const metal = (v.selectedOptions.find((o) => o.name === cfg.optionName) || {}).value;
        const col = metal ? colourOf.get(String(metal).trim().toLowerCase()) : null;
        const want = col ? pick.get(String(col).toUpperCase()) : null;
        if (!want) continue;
        const has = v.media?.nodes?.[0]?.id;
        if (has === want.id) continue;
        updates.push({ id: v.id, mediaId: want.id });
      }
      if (!updates.length) { already++; if (SHOW_SKIPPED) console.log(`= ${code} every variant already has its image`); continue; }

      console.log(`${DRY ? '·' : ' '} ${code.padEnd(11)} ${updates.length} variant(s) -> ` +
        [...pick.entries()].map(([c, x]) => `${c}:${x.file}`).join('  '));
      touched++;
      if (DRY) continue;

      try {
        for (let i = 0; i < updates.length; i += 100) {
          const d = await gql(
            `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
               productVariantsBulkUpdate(productId: $productId, variants: $variants) {
                 userErrors { field message }
               }
             }`,
            { productId: p.id, variants: updates.slice(i, i + 100) }
          );
          checkErrors(d.productVariantsBulkUpdate, 'productVariantsBulkUpdate');
        }
        console.log(`✓ ${code.padEnd(11)} ${updates.length} variant image(s) set`);
      } catch (e) {
        console.log(`✖ ${code.padEnd(11)} ${e.message.slice(0, 120)}`);
      }
    }

    console.log(`\n${touched} product(s) ${DRY ? 'would be' : ''} updated, ${already} already correct, ${noMedia} with no colour-tagged images.`);
    if (DRY) console.log('Dry run — nothing changed. Add --live to apply.\n'); else console.log('');
    return;
  }

  if (SYNC_BANGLES) {
    if (!STORE_INDEX) die('--sync-bangles needs credentials so it can read your store.');
    const b = cfg.bangles;
    if (!b || !Array.isArray(b.sizes) || !b.sizes.length) die('config.json needs "bangles": { "codes": [...], "sizes": [...] }');
    const optName = b.optionName || 'Size';
    const labels = b.sizes.map((s) => s.label);
    const byLabel = new Map((cfg.materials || []).map((m) => [String(m.label).trim().toLowerCase(), m]));
    const materialOf2 = (label) => {
      const k = String(label || '').trim().toLowerCase();
      const al = (cfg.materialAliases || {})[k];
      return byLabel.get(k) || (al ? byLabel.get(String(al).toLowerCase()) : null);
    };
    const tracked = !!cfg.defaults.trackInventory;

    for (const raw of b.codes || []) {
      const code = String(raw).toUpperCase();
      if (ONLY && !ONLY.includes(code)) continue;
      const hit = findInIndex(code);
      if (!hit) { console.log(`⚠ ${code.padEnd(11)} not in the store yet — create it first`); continue; }
      const id = hit.product.id;
      const item = (priceList.has(code) ? itemFromPriceList(code, priceList.get(code)) : null) || sheetByCode.get(code);
      if (!item) { console.log(`⚠ ${code.padEnd(11)} no price in ${cfg.priceListCsv} — add its row first`); continue; }
      const baseByMetal = new Map(item.rows.filter((r) => r.price != null).map((r) => [r.metal.key, Number(r.price)]));

      const read = async () => (await gql(
        `query($id: ID!) { product(id: $id) {
           options { id name optionValues { name } }
           variants(first: 250) { nodes { id price sku selectedOptions { name value } inventoryItem { tracked } } } } }`,
        { id }
      )).product;
      let p = await read();

      // Every option except the metal goes, unless it is already exactly the right Size
      // option. That removes the bracelet "Length" (6.5 in - 8 in) this bangle was created with.
      const isRightSize = (o) => o.name === optName && o.optionValues.map((v) => v.name).join('|') === labels.join('|');
      const remove = p.options.filter((o) => o.name !== cfg.optionName && o.name !== 'Title' && !isRightSize(o));
      const hasSize = p.options.some(isRightSize);

      console.log(`· ${code.padEnd(11)} ${remove.length ? `replace "${remove.map((o) => o.name).join('/')}" with` : hasSize ? 'reprice' : 'add'} "${optName}": ${labels.join(', ')}`);
      for (const m of cfg.materials || []) {
        const base = baseByMetal.get(m.metal);
        if (base == null) continue;
        console.log(`    ${m.label.padEnd(20)} ${b.sizes.map((s) => `$${banglePrice(base, s).toFixed(2)}`.padStart(10)).join('')}`);
      }
      if (DRY) continue;

      try {
        if (remove.length) {
          // POSITION keeps the variants of each removed option's first value, one per metal.
          const d = await gql(
            `mutation($productId: ID!, $options: [ID!]!) {
               productOptionsDelete(productId: $productId, options: $options, strategy: POSITION) {
                 userErrors { field message }
               }
             }`,
            { productId: id, options: remove.map((o) => o.id) }
          );
          checkErrors(d.productOptionsDelete, 'productOptionsDelete');
        }
        if (!hasSize) {
          const d = await gql(
            `mutation($productId: ID!, $options: [OptionCreateInput!]!) {
               productOptionsCreate(productId: $productId, options: $options, variantStrategy: CREATE) {
                 userErrors { field message }
               }
             }`,
            { productId: id, options: [{ name: optName, values: labels.map((n) => ({ name: n })) }] }
          );
          checkErrors(d.productOptionsCreate, 'productOptionsCreate');
        }

        p = await read();
        const updates = [];
        for (const v of p.variants.nodes) {
          const pick = (n) => (v.selectedOptions.find((o) => o.name === n) || {}).value;
          const m = materialOf2(pick(cfg.optionName));
          const size = b.sizes.find((s) => s.label === pick(optName));
          if (!m || !size) {
            console.log(`  ⚠ variant "${v.selectedOptions.map((o) => o.value).join(' / ')}" not recognised — left alone`);
            continue;
          }
          const base = baseByMetal.get(m.metal);
          // No base price means it stays at 0 — a surcharge on nothing is not a price.
          const price = base > 0 ? banglePrice(base, size).toFixed(2) : '0.00';
          const sku = `${code}-${m.metal}-${m.colour}-${size.sku}`;
          if (price === Number(v.price).toFixed(2) && v.sku === sku && v.inventoryItem?.tracked === tracked) continue;
          updates.push({ id: v.id, price, inventoryItem: { sku, tracked } });
        }
        for (let i = 0; i < updates.length; i += 100) {
          const d = await gql(
            `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
               productVariantsBulkUpdate(productId: $productId, variants: $variants) {
                 userErrors { field message }
               }
             }`,
            { productId: id, variants: updates.slice(i, i + 100) }
          );
          checkErrors(d.productVariantsBulkUpdate, 'productVariantsBulkUpdate');
        }
        console.log(`✓ ${code.padEnd(11)} ${p.variants.nodes.length} variants, ${updates.length} updated`);
      } catch (e) {
        console.log(`✖ ${code.padEnd(11)} ${e.message.slice(0, 160)}`);
      }
    }
    console.log(DRY ? '\nDry run — nothing changed. Add --live to apply.\n' : '');
    return;
  }

  if (SYNC_LENGTHS) {
    if (!STORE_INDEX) die('--sync-lengths needs credentials so it can read your store.');
    const optName = cfg.lengthOption || 'Length';
    const LEN = cfg.lengths || {};
    const BASE = cfg.lengthBase || {};
    const SKIP = new Set((cfg.noLengthCodes || []).map((x) => String(x).toUpperCase()));
    if (!Object.keys(LEN).length) die('config.json needs "lengths": { "NECKLACE": [...], "BRACELET": [...] }');

    // Pricing is a flat rate per inch away from the base length, which is how the
    // business actually charges. length-prices.csv can still override any single
    // length with an exact figure.
    const rate = Number(cfg.lengthPricePerInch);
    if (!Number.isFinite(rate)) die('config.json needs "lengthPricePerInch": 25');
    const inches = (s2) => { const m = /([\d.]+)/.exec(String(s2)); return m ? Number(m[1]) : null; };
    const override = new Map();
    const mfile = cfg.lengthPricesCsv || './length-prices.csv';
    if (fs.existsSync(mfile)) {
      for (const r of parseCsv(fs.readFileSync(mfile, 'utf8')).slice(1)) {
        if (!r[0] || !r[1] || r[2] === undefined || String(r[2]).trim() === '') continue;
        const d = Number(r[2]);
        if (!Number.isFinite(d)) die(`Bad delta for ${r[0]} ${r[1]}: "${r[2]}"`);
        override.set(`${r[0].trim().toUpperCase()}|${r[1].trim()}`, d);
      }
    }
    // Price difference in dollars for a given category and length.
    const deltaFor = (cat, len) => {
      const o = override.get(`${cat}|${len}`);
      if (o !== undefined) return o;
      const a = inches(len), b = inches(BASE[cat]);
      if (a == null || b == null) return null;
      return (a - b) * rate;
    };
    for (const [cat, base] of Object.entries(BASE)) {
      const d = deltaFor(cat, base);
      if (d === null) die(`Cannot read inches from base length "${base}" for ${cat}`);
      if (Math.abs(d) > 1e-9) die(`Base length ${cat} ${base} must cost nothing extra, got ${d}`);
    }

    // Prefix first, then the title — so a bracelet that does not use an AJLB code
    // (a supplier item, a hand-built one) still gets bracelet lengths.
    const catOf = (code, title) => {
      const c = String(code).toUpperCase();
      if (/^AJLB/.test(c)) return 'BRACELET';
      if (/^AJ(NT|PD)/.test(c)) return 'NECKLACE';
      const t = String(title || CONTENT?.[c]?.title || '').toLowerCase();
      if (/bracelet|bangle|anklet/.test(t)) return 'BRACELET';
      if (/necklace|pendant|choker/.test(t)) return 'NECKLACE';
      return null;
    };

    const hitTitleFor = (code) => {
      const h = findInIndex(code);
      return h ? h.product.title : null;
    };

    let planned = 0, done = 0;
    // Every skip is counted, so "0 products" always says which test rejected them.
    const why = { filtered: 0, adjustable: 0, notNeckOrBracelet: 0, notInStore: 0 };
    for (const r of renderItems) {
      const code = baseCode(r.code);
      if (ONLY && !ONLY.includes(code.toUpperCase())) { why.filtered++; continue; }
      if (SKIP.has(code.toUpperCase())) {
        why.adjustable++;
        console.log(`- ${code.padEnd(11)} skipped: listed in config "noLengthCodes"`);
        continue;
      }
      if (bangleFor(code)) {
        console.log(`- ${code.padEnd(11)} skipped: a bangle — its sizes come from --sync-bangles`);
        continue;
      }
      const cat = catOf(code, hitTitleFor(code));
      if (!cat || !LEN[cat]) { why.notNeckOrBracelet++; continue; }
      const hit = findInIndex(code);
      if (!hit) { why.notInStore++; continue; }
      const p = hit.product;

      const real = (p.options || []).filter((o) => o.name !== 'Title');
      const hasLen = real.some((o) => o.name === optName);
      const metalOpt = real.find((o) => /materi|metal/i.test(o.name));
      if (!metalOpt) { console.log(`⚠ ${code.padEnd(11)} no metal option yet — run --sync-variants first`); continue; }
      // Normally a product that already has lengths is left alone; --force recomputes
      // its prices, which is how a bad surcharge gets corrected.
      if (hasLen && !FORCE) { if (SHOW_SKIPPED) console.log(`= ${code.padEnd(11)} already has "${optName}"`); continue; }

      const lengths = LEN[cat];
      const metals = [...new Set((p.variants || []).map((v) => v.material).filter(Boolean))];
      if (!metals.length) { console.log(`⚠ ${code.padEnd(11)} no metal values on its variants — skipped`); continue; }
      const total = metals.length * lengths.length;
      if (total > 100) {
        console.log(`✖ ${code.padEnd(11)} ${metals.length} metals x ${lengths.length} lengths = ${total} variants, over Shopify's limit of 100`);
        continue;
      }

      planned++;
      console.log(`· ${code.padEnd(11)} ${cat.toLowerCase()}  ${metals.length} metals x ${lengths.length} lengths = ${total} variants`);
      if (DRY) continue;

      try {
        // Only add the option when it is not there yet; with --force we are repricing.
        if (!hasLen) {
        const d = await gql(
          `mutation($productId: ID!, $options: [OptionCreateInput!]!) {
             productOptionsCreate(productId: $productId, options: $options, variantStrategy: CREATE) {
               userErrors { field message }
             }
           }`,
          { productId: p.id, options: [{ name: optName, values: lengths.map((n) => ({ name: n })) }] }
        );
        checkErrors(d.productOptionsCreate, 'productOptionsCreate');
        }

        // Re-read, then price each combination from its metal's base price.
        const d2 = await gql(
          `query($id: ID!) { product(id: $id) { variants(first: 200) {
             nodes { id price selectedOptions { name value } } } } }`,
          { id: p.id }
        );
        const basePrice = new Map();
        const item = (priceList.has(code.toUpperCase())
          ? itemFromPriceList(code, priceList.get(code.toUpperCase()))
          : null) || sheetByCode.get(code.toUpperCase());
        const plan = item ? planItem(item, mediaForItem(r.files, r.code)) : null;
        if (plan && plan.materials.length) {
          // Always the price list, never the live variant. Reading the variant back meant
          // a second run added the surcharge to a price that already included it — an
          // 8 in bracelet went 0 -> 25 -> 50.
          for (const m of plan.materials) basePrice.set(m.label, Number(m.price));
        } else {
          console.log(`⚠ ${code.padEnd(11)} no price in ${cfg.priceListCsv} — every length left at 0`);
          for (const v of p.variants || []) if (v.material) basePrice.set(v.material, 0);
        }

        const updates = [];
        for (const v of d2.product?.variants?.nodes || []) {
          const metal = (v.selectedOptions.find((o) => o.name === metalOpt.name) || {}).value;
          const len = (v.selectedOptions.find((o) => o.name === optName) || {}).value;
          // The variant's option value may be a generic legacy label ("Gold") while
          // basePrice is keyed by the canonical ones ("18k Yellow Gold"). Without the alias
          // step this returned undefined and the variant was skipped silently — AJNT26's
          // 15 variants reported "0 priced" and kept whatever price they already had.
          let b = basePrice.get(metal);
          if (b == null && metal) {
            const al = (cfg.materialAliases || {})[String(metal).trim().toLowerCase()];
            if (al != null) b = basePrice.get(al);
          }
          const d = deltaFor(cat, len);
          if (b == null || d == null) continue;
          // A product with no price yet must stay at 0. Adding a length surcharge to a
          // zero base invents a price out of nothing — a bracelet with no cost data was
          // ending up on sale at the surcharge alone.
          const price = b > 0 ? roundPrice(Math.max(0, b + d)).toFixed(2) : '0.00';
          if (price !== Number(v.price).toFixed(2)) updates.push({ id: v.id, price });
        }
        for (let i = 0; i < updates.length; i += 100) {
          const slice = updates.slice(i, i + 100);
          const d3 = await gql(
            `mutation($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
               productVariantsBulkUpdate(productId: $productId, variants: $variants) {
                 userErrors { field message }
               }
             }`,
            { productId: p.id, variants: slice }
          );
          checkErrors(d3.productVariantsBulkUpdate, 'productVariantsBulkUpdate');
        }
        console.log(`✓ ${code.padEnd(11)} ${total} variants, ${updates.length} priced`);
        done++;
      } catch (e) {
        console.log(`✖ ${code.padEnd(11)} ${e.message.slice(0, 120)}`);
      }
    }

    console.log(`\n${planned} product(s) would gain a "${optName}" option${DRY ? '' : `, ${done} done`}.`);
    if (!planned) {
      console.log(`\nOf ${renderItems.length} render items:`);
      console.log(`  ${why.filtered} excluded by --only`);
      console.log(`  ${why.adjustable} on the adjustable list`);
      console.log(`  ${why.notNeckOrBracelet} are not a necklace, pendant or bracelet code`);
      console.log(`  ${why.notInStore} could not be matched to a product in the store`);
    }
    if (DRY) {
      console.log('Dry run — nothing changed. Add --live to apply.');
      console.log('Adding an option multiplies variants and cannot be undone in one step, so');
      console.log('try one product first:  node import.js --sync-lengths --only AJPD455 --live\n');
    } else console.log('');
    return;
  }

  if (SET_STATUS) {
    if (!STORE_INDEX) die('--set-status needs credentials so it can read your store.');
    const want = String(SET_STATUS).toUpperCase();
    if (!['ACTIVE', 'DRAFT', 'ARCHIVED'].includes(want)) die('--set-status takes active, draft or archived.');

    const targets = STORE_INDEX.filter((p) => {
      if (PRODUCT_FILTER) return String(p.title).toLowerCase().includes(PRODUCT_FILTER.toLowerCase());
      if (ONLY) {
        const hay = [p.haystacks.sku, p.haystacks.media, p.haystacks.title].join(' | ').toUpperCase();
        return ONLY.some((c) => hay.includes(c));
      }
      return false;
    });
    if (!targets.length) die('--set-status needs --only CODE or --product "<title text>", and it must match something.');

    for (const p of targets) {
      if (p.status === want) { console.log(`= ${p.title.slice(0, 56)} already ${want}`); continue; }
      if (DRY) { console.log(`· ${p.title.slice(0, 56)}  ${p.status} -> ${want}`); continue; }
      try {
        const d = await gql(
          `mutation($input: ProductInput!) {
             productUpdate(input: $input) { product { id status } userErrors { field message } }
           }`,
          { input: { id: p.id, status: want } }
        );
        checkErrors(d.productUpdate, 'productUpdate');
        console.log(`✓ ${p.title.slice(0, 56)}  ${p.status} -> ${want}`);
      } catch (e) { console.log(`✖ ${p.title.slice(0, 40)} ${e.message.slice(0, 80)}`); }
    }
    if (DRY) console.log('\nDry run — nothing changed. Add --live to apply.\n'); else console.log('');
    return;
  }

  if (HARVEST_SPECS) {
    if (!STORE_INDEX) die('--harvest-specs needs credentials so it can read your store.');

    // Colour, clarity, stone size and length live ONLY in the hand-written part of some
    // descriptions. Once that text is deleted they are gone, and a later run would fall
    // back to the config defaults and quietly publish the wrong grade. So they are read
    // out and written into product-specs.json first, where they survive.
    const specsPath = cfg.specsFile || './product-specs.json';
    const SP = fs.existsSync(specsPath) ? JSON.parse(fs.readFileSync(specsPath, 'utf8')) : {};

    const codeOf = new Map();
    for (const r of renderItems) {
      const code = baseCode(r.code);
      const hit = findInIndex(code);
      if (hit) codeOf.set(hit.product.id, code);
    }

    let added = 0, skipped = 0;
    const orphans = [];
    for (const p of STORE_INDEX) {
      const lg = legacySpecs(p.descriptionHtml || '');
      const useful = ['color', 'clarity', 'stoneSize', 'length', 'diamondCount', 'totalCarat']
        .filter((k) => lg[k]);
      if (!useful.length) continue;

      const code = codeOf.get(p.id);
      if (!code) { orphans.push({ title: p.title, lg, useful }); continue; }

      const cur = SP[code] || {};
      const next = { ...cur };
      const put = (key, val) => { if (val != null && cur[key] == null) next[key] = val; };
      put('color', lg.color);
      put('clarity', lg.clarity);
      put('measurement', lg.stoneSize);
      put('chain', lg.length);
      if (lg.diamondCount && cur.diamondCount == null) next.diamondCount = Number(lg.diamondCount);
      if (lg.totalCarat && cur.totalCarat == null) next.totalCarat = Number(lg.totalCarat);

      const changed = JSON.stringify(next) !== JSON.stringify(cur);
      if (!changed) { skipped++; continue; }
      const gained = Object.keys(next).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(cur[k]));
      console.log(`${code.padEnd(10)} + ${gained.map((k) => `${k}=${next[k]}`).join(', ')}`);
      SP[code] = next;
      added++;
    }

    if (orphans.length) {
      console.log(`\n⚠ ${orphans.length} product(s) carry values but have no item code, so there is`);
      console.log(`  nowhere in product-specs.json to keep them. Their text must NOT be deleted:\n`);
      for (const o of orphans) {
        console.log(`  ${o.title.slice(0, 54)}`);
        console.log(`      ${o.useful.map((k) => `${k}=${o.lg[k]}`).join(', ')}`);
      }
    }

    console.log(`\n${added} product(s) would gain values, ${skipped} already covered.`);
    if (DRY) { console.log('Dry run — product-specs.json not written. Add --live to save.\n'); return; }
    fs.copyFileSync(specsPath, specsPath + '.bak');
    fs.writeFileSync(specsPath, JSON.stringify(SP, null, 2) + '\n');
    console.log(`Saved to ${specsPath} (previous copy at ${specsPath}.bak)\n`);
    return;
  }

  if (LINKED_VALUES) {
    if (!STORE_INDEX) die('--linked-values needs credentials so it can read your store.');

    // A "linked" option value is a pointer at a metaobject entry, not free text. Its name
    // cannot be set directly — the entry's handle has to be supplied instead. This shows
    // which products use linked values and what handles are available to link to.
    const sample = PRODUCT_FILTER
      ? STORE_INDEX.filter((p) => String(p.title).toLowerCase().includes(PRODUCT_FILTER.toLowerCase()))
      : STORE_INDEX;
    if (!sample.length) die(`No product title contains "${PRODUCT_FILTER}".`);

    let linkedType = null;
    const report = [];
    for (const p of sample.slice(0, PRODUCT_FILTER ? sample.length : 400)) {
      const d = await gql(
        `query($id: ID!) {
           product(id: $id) {
             options { id name
               linkedMetafield { namespace key }
               optionValues { id name linkedMetafieldValue } }
           }
         }`,
        { id: p.id }
      );
      for (const o of d.product?.options || []) {
        if (!o.linkedMetafield) continue;
        linkedType = linkedType || `${o.linkedMetafield.namespace}.${o.linkedMetafield.key}`;
        report.push({ title: p.title, option: o.name, mf: `${o.linkedMetafield.namespace}.${o.linkedMetafield.key}`,
          values: (o.optionValues || []).map((v) => `${v.name} [${v.linkedMetafieldValue || '—'}]`) });
      }
    }

    if (!report.length) {
      console.log('No product uses a metafield-linked option value.\n');
      return;
    }
    for (const r of report) {
      console.log(`\n${r.title.slice(0, 60)}`);
      console.log(`  option "${r.option}" is linked to ${r.mf}`);
      for (const v of r.values) console.log(`    ${v}`);
    }

    // Everything that could be linked to, so the ten labels can be mapped to handles.
    const moType = `shopify--${String(linkedType).split('.').pop()}`;
    console.log(`\n── entries available in ${moType} ──\n`);
    try {
      const list = await metaobjectEntries(moType);
      const canon = new Set((cfg.materials || []).map((m) => String(m.label).trim().toLowerCase()));
      for (const n of list) {
        const name = String(n.displayName || n.handle);
        const mark = canon.has(name.trim().toLowerCase()) ? '✓' : ' ';
        console.log(`  ${mark} ${name.padEnd(24)} handle: ${n.handle}`);
      }
      console.log(`\n  ✓ = one of your ten values in config.json`);
      const found = new Set(list.map((n) => String(n.displayName || n.handle).trim().toLowerCase()));
      const missing = (cfg.materials || []).map((m) => m.label).filter((l) => !found.has(l.toLowerCase()));
      if (missing.length) {
        console.log(`\n  ✖ no entry exists for: ${missing.join(', ')}`);
        console.log(`    Those have to be added to the metaobject before a variant can link to them.`);
      }
    } catch (e) {
      console.log(`  (could not read ${moType}: ${e.message.slice(0, 100)})`);
    }
    console.log('');
    return;
  }

  if (REMAP_VALUES) {
    if (!STORE_INDEX) die('--remap-values needs credentials so it can read your store.');
    if (!PRODUCT_FILTER) die('--remap-values needs --product "<part of the title>"');
    if (!REMAP_MAP) die('--remap-values needs --map "Old=New,Old2=New2"');

    const pairs = REMAP_MAP.split(',').map((s2) => {
      const i = s2.indexOf('=');
      if (i === -1) die(`--map entry "${s2.trim()}" needs the form Old=New`);
      return [s2.slice(0, i).trim(), s2.slice(i + 1).trim()];
    });

    const hits = STORE_INDEX.filter((p) =>
      String(p.title).toLowerCase().includes(PRODUCT_FILTER.toLowerCase()));
    if (!hits.length) die(`No product title contains "${PRODUCT_FILTER}".`);
    if (hits.length > 1) {
      console.log(`"${PRODUCT_FILTER}" matches ${hits.length} products — be more specific:\n`);
      for (const p of hits) console.log(`  ${p.title}`);
      console.log('');
      return;
    }
    const p = hits[0];

    const d0 = await gql(
      `query($id: ID!) {
         product(id: $id) {
           options { id name
             linkedMetafield { namespace key }
             optionValues { id name linkedMetafieldValue } }
         }
       }`,
      { id: p.id }
    );
    const opt = (d0.product?.options || []).find((o) => /materi|metal/i.test(o.name));
    if (!opt) die(`"${p.title}" has no material or metal option.`);
    const byName = new Map((opt.optionValues || []).map((v) => [v.name.trim().toLowerCase(), v]));

    // A linked value points at a metaobject entry; its name cannot be set directly, so
    // the target label has to be resolved to that entry's handle first.
    let handleFor = null;
    if (opt.linkedMetafield) {
      const moType = `shopify--${opt.linkedMetafield.key}`;
      const list = await metaobjectEntries(moType);
      const map = new Map();
      for (const n of list) map.set(String(n.displayName || n.handle).trim().toLowerCase(), n.handle);
      handleFor = (label) => map.get(String(label).trim().toLowerCase()) || null;
      console.log(`${p.title}\n  option "${opt.name}" is linked to ${opt.linkedMetafield.namespace}.${opt.linkedMetafield.key}\n`);
    } else {
      console.log(`${p.title}\n  option "${opt.name}" (plain text values)\n`);
    }

    const toUpdate = [];
    for (const [from, to] of pairs) {
      const v = byName.get(from.trim().toLowerCase());
      if (!v) { console.log(`  ✖ no value called "${from}"`); continue; }
      if (v.name === to) { console.log(`  = "${from}" already correct`); continue; }
      if (handleFor) {
        const h = handleFor(to);
        if (!h) {
          console.log(`  ✖ "${to}" has no entry in the metaobject — add it in Shopify first`);
          continue;
        }
        console.log(`  ${from}  ->  ${to}   [${h}]`);
        toUpdate.push({ id: v.id, linkedMetafieldValue: h });
      } else {
        console.log(`  ${from}  ->  ${to}`);
        toUpdate.push({ id: v.id, name: to });
      }
    }
    const untouched = (opt.optionValues || []).filter((v) => !toUpdate.some((u) => u.id === v.id));
    if (untouched.length) console.log(`\n  left alone: ${untouched.map((v) => v.name).join(', ')}`);

    if (!toUpdate.length) { console.log('\nNothing to change.\n'); return; }
    if (DRY) {
      console.log('\nDry run — nothing changed. Add --live to apply.');
      console.log('Relinking a value keeps its variant, so prices and inventory are untouched.\n');
      return;
    }
    try {
      const d = await gql(
        `mutation($productId: ID!, $option: OptionUpdateInput!, $upd: [OptionValueUpdateInput!]) {
           productOptionUpdate(productId: $productId, option: $option, optionValuesToUpdate: $upd) {
             userErrors { field message }
           }
         }`,
        { productId: p.id, option: { id: opt.id }, upd: toUpdate }
      );
      checkErrors(d.productOptionUpdate, 'productOptionUpdate');
      console.log(`\n✓ ${toUpdate.length} value(s) relinked\n`);
    } catch (e) {
      console.log(`\n✖ ${e.message.slice(0, 160)}\n`);
    }
    return;
  }

  if (DESC_DUMP) {
    if (!STORE_INDEX) die('--desc needs credentials so it can read your store.');
    if (!PRODUCT_FILTER) die('--desc needs a product:\n  node import.js --desc --product "Aveline"');
    const hits = STORE_INDEX.filter((p) =>
      String(p.title).toLowerCase().includes(PRODUCT_FILTER.toLowerCase()));
    if (!hits.length) die(`No product title contains "${PRODUCT_FILTER}".`);
    for (const p of hits) {
      console.log(`\n===== ${p.title}`);
      // Raw, one tag per line — the exact markup, so a strip rule can be written
      // against what is really there rather than what it is assumed to be.
      const raw = String(p.descriptionHtml || '');
      console.log(raw.replace(/></g, '>\n<'));
      console.log(`\n----- after stripSpecs() -----`);
      console.log(stripSpecs(raw).replace(/></g, '>\n<'));
    }
    console.log('');
    return;
  }

  if (PUSH_TITLES) {
    if (!STORE_INDEX) die('--push-titles needs credentials so it can read your store.');

    // Title only. Descriptions, options, prices and media are left untouched, so this is
    // safe to run while descriptions are mid-repair.
    let changed = 0, same = 0, noCopy = 0, notInStore = 0;
    for (const r of renderItems) {
      const code = baseCode(r.code);
      if (ONLY && !ONLY.includes(code.toUpperCase())) continue;
      const want = CONTENT?.[code];
      if (!want || !want.title) { noCopy++; continue; }
      const hit = findInIndex(code);
      if (!hit) { notInStore++; continue; }

      const live = String(hit.product.title).trim();
      const next = String(want.title).trim();
      if (live === next) { same++; continue; }

      if (DRY) {
        console.log(`· ${code.padEnd(12)} "${live}"\n             -> "${next}"`);
      } else {
        try {
          await updateTitleOnly(hit.product.id, next);
          console.log(`✓ ${code.padEnd(12)} ${next}`);
        } catch (e) {
          console.log(`✖ ${code.padEnd(12)} ${e.message}`);
          continue;
        }
      }
      changed++;
    }

    console.log(`\n${changed} ${DRY ? 'would be renamed' : 'renamed'}, ${same} already correct.`);
    if (noCopy) console.log(`${noCopy} with no title in product-content.json — skipped.`);
    if (notInStore) console.log(`${notInStore} not in the store yet — skipped.`);
    console.log('');
    return;
  }

  if (TITLES_REPORT) {
    if (!STORE_INDEX) die('--titles needs credentials so it can read your store.');

    // Which store products this script owns, matched the same way everything else is.
    const owned = new Map();
    for (const r of renderItems) {
      const code = baseCode(r.code);
      const hit = findInIndex(code);
      if (hit) owned.set(hit.product.id, code);
    }

    const CANON = /^[\d.]+ CTW .+ Lab-Grown Diamond /;
    const rows = STORE_INDEX.map((p) => {
      const code = owned.get(p.id) || null;
      const t = String(p.title);
      const flags = [];
      if (!/Lab-Grown/.test(t) && /Lab.?Grown|Lab Diamond/i.test(t)) flags.push('spells "Lab-Grown" differently');
      if (/\d\s*ct\b/i.test(t) && !/CTW/i.test(t)) flags.push('uses "ct" not "CTW"');
      if (!/[\d.]+\s*(CTW|ct)\b/i.test(t)) flags.push('no carat');
      if (/^[A-ZÉÈÀÎ][a-zéèàî]+\s/.test(t) && !/^[\d]/.test(t)) flags.push('starts with a name');
      if (/Shape\b/.test(t) && !/Cut\b/.test(t)) flags.push('says "Shape" not "Cut"');
      if (!CANON.test(t)) flags.push('not house format');
      return { code, title: t, managed: !!code, flags: [...new Set(flags)] };
    }).sort((a, z) => Number(a.managed) - Number(z.managed) || a.title.localeCompare(z.title));

    const unmanaged = rows.filter((r) => !r.managed);
    console.log(`${rows.length} products — ${rows.length - unmanaged.length} managed by this script, ${unmanaged.length} hand-built.\n`);

    console.log('── HAND-BUILT (not in product-content.json — --sync-content cannot touch these) ──\n');
    for (const r of unmanaged) {
      console.log(`  ${r.title}`);
      if (r.flags.length) console.log(`      ${r.flags.join('; ')}`);
    }

    const badManaged = rows.filter((r) => r.managed && r.flags.length);
    if (badManaged.length) {
      console.log(`\n── MANAGED BUT OFF-FORMAT ──\n`);
      for (const r of badManaged) console.log(`  ${String(r.code).padEnd(10)} ${r.title}\n      ${r.flags.join('; ')}`);
    }

    const file = `titles-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
    const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
    fs.writeFileSync(file, 'code,managed,title,issues\n' +
      rows.map((r) => [esc(r.code || ''), r.managed, esc(r.title), esc(r.flags.join('; '))].join(',')).join('\n') + '\n');
    console.log(`\nFull list written to ${file} — send it to Claude and it will write the corrected titles.\n`);
    return;
  }

  if (FIX_OPTIONS) {
    if (!STORE_INDEX) die('--fix-options needs credentials so it can read your store.');

    const canon = new Set((cfg.materials || []).map((m) => String(m.label).trim().toLowerCase()));
    const metalish = (s) => /materi|metal/i.test(String(s || ''));
    let planned = 0;

    for (const p of STORE_INDEX) {
      const real = (p.options || []).filter((o) => o.name !== 'Title');
      if (!real.length) continue;
      const metalOpt = real.find((o) => metalish(o.name));
      const extras = real.filter((o) => o !== metalOpt);
      const needsRename = metalOpt && metalOpt.name !== cfg.optionName;
      if (!needsRename && !extras.length) continue;

      // Values a variant actually uses, so a generic "White gold" is visible as the
      // separate problem it is — renaming the option will not repair the value.
      const used = [...new Set((p.variants || [])
        .map((v) => (v.options.split(' | ').find((x) => metalish(x.split('=')[0])) || '').split('=')[1])
        .filter(Boolean))];
      const odd = used.filter((v) => !canon.has(String(v).trim().toLowerCase()));

      planned++;
      console.log(`\n${p.title.slice(0, 62)}`);
      if (needsRename) console.log(`   rename option "${metalOpt.name}" -> "${cfg.optionName}"`);
      for (const o of extras) {
        const vals = o.values || [];
        const safe = vals.length <= 1;
        console.log(`   remove option "${o.name}" (${vals.length} value${vals.length === 1 ? '' : 's'}: ${vals.slice(0, 4).join(', ')})` +
          (safe ? '' : '   ⚠ more than one value — removing it MERGES variants'));
      }
      if (odd.length) {
        console.log(`   ⚠ values that are not one of your ten: ${odd.join(', ')}`);
        console.log(`     (renaming does not fix these — they need the right metal set on the variant)`);
      }

      if (DRY) continue;

      if (needsRename) {
        try {
          const d = await gql(
            `mutation($productId: ID!, $option: OptionUpdateInput!) {
               productOptionUpdate(productId: $productId, option: $option) { userErrors { field message } }
             }`,
            { productId: p.id, option: { id: metalOpt.id, name: cfg.optionName } }
          );
          checkErrors(d.productOptionUpdate, 'productOptionUpdate');
          console.log(`   ✓ renamed`);
        } catch (e) { console.log(`   ✖ rename: ${e.message.slice(0, 90)}`); }
      }

      if (extras.length) {
        // NON_DESTRUCTIVE refuses rather than quietly merging variants. --force opts in
        // to POSITION, which keeps the first variant of each group and drops the rest.
        const strategy = FORCE ? 'POSITION' : 'NON_DESTRUCTIVE';
        try {
          const d = await gql(
            `mutation($productId: ID!, $options: [ID!]!, $strategy: ProductOptionDeleteStrategy) {
               productOptionsDelete(productId: $productId, options: $options, strategy: $strategy) {
                 userErrors { field message }
               }
             }`,
            { productId: p.id, options: extras.map((o) => o.id), strategy }
          );
          checkErrors(d.productOptionsDelete, 'productOptionsDelete');
          console.log(`   ✓ removed ${extras.length} extra option(s)`);
        } catch (e) {
          console.log(`   ✖ remove: ${e.message.slice(0, 120)}`);
          if (!FORCE) console.log(`     add --force to allow variants to be merged`);
        }
      }
    }

    if (!planned) { console.log('\nEvery product already has one option, named correctly.\n'); return; }
    console.log(`\n${planned} product(s) affected.`);
    if (DRY) console.log('Dry run — nothing changed. Add --live to apply.\n'); else console.log('');
    return;
  }

  if (RENDERS_REPORT) {
    // Which metal colours Drive actually has a render for. A product only gets the
    // variants whose colour has images, so a missing colour here is why a product
    // shows up in one metal.
    const cols = cfg.colours.map((c) => c.code);
    let full = 0, partial = 0, none = 0;
    console.log(`code         ${cols.map((c) => c.padEnd(6)).join('')} unmatched   files`);
    for (const r of renderItems) {
      const code = baseCode(r.code);
      if (ONLY && !ONLY.includes(code.toUpperCase())) continue;
      const media = mediaForItem(r.files, r.code);
      const counts = cols.map((c) => {
        const b = media[c];
        if (!b) return '—';
        return `${b.images.length}${b.videos.length ? `+${b.videos.length}v` : ''}`;
      });
      const matched = cols.reduce((n, c) => n + (media[c] ? media[c].images.length + media[c].videos.length : 0), 0);
      const unmatched = r.files.length - matched;
      const have = cols.filter((c) => media[c] && media[c].images.length).length;
      if (have === cols.length) full++; else if (have) partial++; else none++;
      const mark = have === cols.length ? ' ' : have ? '⚠' : '✖';
      console.log(`${mark} ${code.padEnd(11)}${counts.map((x) => String(x).padEnd(6)).join('')}${String(unmatched || '').padStart(6)}      ${r.files.length}`);
    }
    console.log(`\n${full} item(s) have every colour, ${partial} partial, ${none} none.`);
    console.log('A colour with no images gets no variants in that metal.');
    console.log('"unmatched" counts files in the folder that the naming rule skipped');
    console.log(`(expected <CODE>-<${cols.join('|')}><n>.<ext>).\n`);
    return;
  }

  if (THEME_FILE) {
    let themes;
    try {
      const t = await gql(`{ themes(first: 20) { nodes { id name role } } }`);
      themes = t.themes?.nodes || [];
    } catch (e) {
      if (/ACCESS_DENIED|read_themes/i.test(e.message)) die('The app cannot read your theme files — add the "read_themes" scope.');
      throw e;
    }
    const live = themes.find((x) => x.role === 'MAIN') || themes[0];
    if (!live) die('No themes came back.');

    const d = await gql(
      `query($id: ID!, $names: [String!]) {
         theme(id: $id) {
           files(filenames: $names, first: 5) {
             nodes { filename body { ... on OnlineStoreThemeFileBodyText { content } } }
           }
         }
       }`,
      { id: live.id, names: [THEME_FILE] }
    );
    const nodes = d.theme?.files?.nodes || [];
    if (!nodes.length) die(`No file called "${THEME_FILE}" in theme "${live.name}".`);

    const range = value('--lines');           // e.g. --lines 30-70
    for (const f of nodes) {
      const lines = String(f.body?.content || '').split('\n');
      let from = 1, to = lines.length;
      if (range) {
        const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(range.trim());
        if (m) { from = Number(m[1]); to = m[2] ? Number(m[2]) : from + 40; }
      }
      console.log(`\n── ${f.filename}  (${lines.length} lines, showing ${from}-${Math.min(to, lines.length)})\n`);
      for (let i = from; i <= Math.min(to, lines.length); i++) {
        console.log(`${String(i).padStart(5)}  ${lines[i - 1]}`);
      }
    }
    console.log('');
    return;
  }

  if (THEME_GREP !== null) {
    const pattern = THEME_GREP || 'inventory_quantity|total_inventory|sold.?out';
    let rx;
    try { rx = new RegExp(pattern, 'i'); }
    catch (e) { die(`--theme-grep: "${pattern}" is not a valid pattern (${e.message})`); }

    let themes;
    try {
      const t = await gql(`{ themes(first: 20) { nodes { id name role } } }`);
      themes = t.themes?.nodes || [];
    } catch (e) {
      if (/ACCESS_DENIED|read_themes/i.test(e.message)) {
        die('The app cannot read your theme files.\n\n' +
            '  Add the "read_themes" scope to the app, release a new version, then retry:\n' +
            '  Shopify Dev Dashboard > your app > Versions > Create version > release > install.\n\n' +
            '  Or search the theme by hand: Admin > Online Store > Themes > ... > Edit code,\n' +
            `  then type ${pattern.split('|')[0]} into the SEARCH BOX in that editor.`);
      }
      throw e;
    }

    const live = themes.find((x) => x.role === 'MAIN') || themes[0];
    if (!live) die('No themes came back.');
    console.log(`Theme: ${live.name} (${live.role})\nLooking for /${pattern}/i\n`);

    let cursor = null, scanned = 0, hits = 0;
    for (;;) {
      const d = await gql(
        `query($id: ID!, $cursor: String) {
           theme(id: $id) {
             files(first: 50, after: $cursor) {
               pageInfo { hasNextPage endCursor }
               nodes { filename body { ... on OnlineStoreThemeFileBodyText { content } } }
             }
           }
         }`,
        { id: live.id, cursor }
      );
      const page = d.theme?.files;
      if (!page) break;
      for (const f of page.nodes) {
        const content = f.body?.content;
        if (!content) continue;
        scanned++;
        const lines = content.split('\n');
        const found = [];
        for (let i = 0; i < lines.length; i++) if (rx.test(lines[i])) found.push([i + 1, lines[i].trim()]);
        if (!found.length) continue;
        hits++;
        console.log(`\n── ${f.filename}  (${found.length} line${found.length === 1 ? '' : 's'})`);
        for (const [n, text] of found.slice(0, 12)) {
          console.log(`   ${String(n).padStart(5)}: ${text.slice(0, 150)}`);
        }
        if (found.length > 12) console.log(`   …and ${found.length - 12} more in this file`);
      }
      if (!page.pageInfo.hasNextPage) break;
      cursor = page.pageInfo.endCursor;
    }

    console.log(`\n${hits} file(s) matched out of ${scanned} scanned.`);
    if (!hits) console.log('Nothing matched — try a different pattern, e.g.\n  node import.js --theme-grep "available"');
    console.log('');
    return;
  }

  if (STOCK_REPORT) {
    if (!STORE_INDEX) die('--stock needs credentials so it can read your store.');

    // "Sold out" has several separate causes and they look identical on the storefront,
    // so every one of them is read back rather than inferred.
    // Stock levels need read_locations, which this app may not have. The scope only
    // affects one of the five checks, so it degrades rather than failing the whole run.
    let LEVELS = true;
    const pageQuery = (withLevels) => `query($cursor: String) {
      products(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id title status totalInventory
          options { id name optionValues { id name hasVariants } }
          variants(first: 100) { nodes {
            id sku price availableForSale inventoryPolicy inventoryQuantity
            selectedOptions { name value }
            inventoryItem { id tracked${withLevels ? '\n              inventoryLevels(first: 10) { nodes { id } }' : ''} }
          } }
        }
      }
    }`;

    const rows = [];
    let cursor = null;
    for (;;) {
      let d;
      try {
        d = await gql(pageQuery(LEVELS), { cursor });
      } catch (e) {
        if (!LEVELS || !/ACCESS_DENIED|read_locations|inventoryLevels/i.test(e.message)) throw e;
        console.log('(no read_locations scope — skipping the "stocked at a location" check)\n');
        LEVELS = false;
        d = await gql(pageQuery(false), { cursor });
      }
      for (const p of d.products.nodes) {
        const vs = p.variants.nodes;

        // --product prints everything for one product rather than a tally, because a
        // single item reading "sold out" needs the per-variant detail to explain it.
        if (PRODUCT_FILTER) {
          if (!String(p.title).toLowerCase().includes(PRODUCT_FILTER.toLowerCase())) continue;
          console.log(`\n${p.title}`);
          console.log(`  status ${p.status}   totalInventory ${p.totalInventory}   ${vs.length} variant(s)\n`);
          for (const o of p.options || []) {
            const dead = (o.optionValues || []).filter((x) => x.hasVariants === false).map((x) => x.name);
            console.log(`  option "${o.name}": ${(o.optionValues || []).length} value(s)` +
              (dead.length ? `   ✖ no variant behind: ${dead.join(', ')}` : ''));
          }
          console.log('');
          console.log(`  ${'SKU'.padEnd(20)} ${'price'.padStart(9)}  avail  tracked  policy  qty   options`);
          for (const v of vs) {
            const opts = (v.selectedOptions || []).map((o) => o.value).join('/');
            console.log(`  ${String(v.sku || '(none)').padEnd(20)} ${String(v.price).padStart(9)}  ` +
              `${v.availableForSale ? ' yes ' : ' NO  '}  ` +
              `${v.inventoryItem?.tracked ? ' YES  ' : ' no   '}  ` +
              `${String(v.inventoryPolicy || '').padEnd(6)}  ${String(v.inventoryQuantity ?? '').padStart(3)}   ${opts}`);
          }
          const bad = vs.filter((v) => !v.availableForSale);
          console.log('');
          if (!vs.length) console.log('  ✖ no variants at all — this always reads as sold out.');
          else if (bad.length === vs.length) console.log('  ✖ every variant is unavailable.');
          else if (bad.length) console.log(`  ⚠ ${bad.length} of ${vs.length} variants unavailable — picking one of those shows "sold out".`);
          else console.log('  ✓ Shopify says every variant is available. The "sold out" text is the theme.');
          console.log('');
        }

        rows.push({
          title: p.title,
          status: p.status,
          variants: vs.length,
          unavailable: vs.filter((v) => !v.availableForSale).length,
          tracked: vs.filter((v) => v.inventoryItem?.tracked).length,
          deny: vs.filter((v) => v.inventoryItem?.tracked && v.inventoryPolicy === 'DENY').length,
          noLocation: LEVELS
            ? vs.filter((v) => !(v.inventoryItem?.inventoryLevels?.nodes || []).length).length : 0,
          zeroQty: vs.filter((v) => (v.inventoryQuantity || 0) <= 0).length,
          deadValues: (p.options || []).flatMap((o) =>
            (o.optionValues || []).filter((x) => x.hasVariants === false).map((x) => `${o.name}: ${x.name}`)),
        });
      }
      if (!d.products.pageInfo.hasNextPage) break;
      cursor = d.products.pageInfo.endCursor;
    }

    if (PRODUCT_FILTER) {
      if (!rows.length) console.log(`No product title contains "${PRODUCT_FILTER}".\n`);
      return;
    }

    const n = rows.length;
    const anyUnavail = rows.filter((r) => r.unavailable);
    const anyTracked = rows.filter((r) => r.tracked);
    const anyDeny = rows.filter((r) => r.deny);
    const anyNoLoc = rows.filter((r) => r.noLocation);
    const anyDead = rows.filter((r) => r.deadValues.length);

    console.log(`${n} products.\n`);
    console.log(`Variants not available for sale   ${anyUnavail.length} product(s)`);
    console.log(`Still tracking quantity           ${anyTracked.length}`);
    console.log(`  …and set to "stop selling"      ${anyDeny.length}`);
    console.log(`Not stocked at any location       ${anyNoLoc.length}`);
    console.log(`Option values with no variant     ${anyDead.length}\n`);

    // The one that actually blocks a sale, named first.
    if (anyDeny.length) {
      console.log('── Tracking quantity AND set to stop selling when it hits 0 ──');
      console.log('   This is what makes a product read "Sold out". Fix:');
      console.log('   node import.js --sync-inventory --live\n');
      for (const r of anyDeny.slice(0, 15)) {
        console.log(`  ${String(r.deny).padStart(3)}/${r.variants} variants   ${r.title.slice(0, 54)}`);
      }
      if (anyDeny.length > 15) console.log(`  …and ${anyDeny.length - 15} more`);
      console.log('');
    } else if (anyTracked.length) {
      console.log('── Tracking quantity, but set to keep selling at 0 ──');
      console.log('   These should NOT show as sold out. Fix anyway:');
      console.log('   node import.js --sync-inventory --live\n');
    }

    if (anyNoLoc.length) {
      console.log('── Not stocked at any location ──');
      console.log('   A tracked variant with no location is unsellable. Untracking clears this.\n');
      for (const r of anyNoLoc.slice(0, 10)) console.log(`  ${r.title.slice(0, 60)}`);
      console.log('');
    }

    if (anyDead.length) {
      console.log('── Option values with no variant behind them ──');
      console.log('   The swatch shows on the storefront, but picking it has nothing to sell,');
      console.log('   so the theme falls back to "Sold out"/"Unavailable".\n');
      for (const r of anyDead.slice(0, 15)) {
        console.log(`  ${r.title.slice(0, 44).padEnd(44)} ${r.deadValues.slice(0, 4).join(', ')}${r.deadValues.length > 4 ? ` +${r.deadValues.length - 4}` : ''}`);
      }
      if (anyDead.length > 15) console.log(`  …and ${anyDead.length - 15} more`);
      console.log('');
    }

    // Everything above is about stock. A product can still read "sold out" because it
    // is not on the Online Store, or because its price is 0 — both are cheap to check.
    let pubRows = [];
    let PUBS = true;
    const pubQuery = (withPubs) => `query($cursor: String) {
      products(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id title status${withPubs ? `
          resourcePublicationsV2(first: 10) { nodes { publication { name } isPublished } }` : ''}
          variants(first: 100) { nodes { id price } } }
      }
    }`;
    try {
      let c2 = null;
      for (;;) {
        let d2;
        try {
          d2 = await gql(pubQuery(PUBS), { cursor: c2 });
        } catch (e) {
          if (!PUBS || !/ACCESS_DENIED|read_publications|publication/i.test(e.message)) throw e;
          console.log('(no read_publications scope — checking status and price only)\n');
          PUBS = false;
          d2 = await gql(pubQuery(false), { cursor: c2 });
        }
        for (const p2 of d2.products.nodes) {
          const chans = (p2.resourcePublicationsV2?.nodes || [])
            .filter((x) => x.isPublished).map((x) => x.publication?.name).filter(Boolean);
          const prices = (p2.variants?.nodes || []).map((v) => Number(v.price));
          pubRows.push({
            title: p2.title, status: p2.status, channels: chans,
            // Without the scope there is nothing to judge, so it is never reported as a fault.
            online: !PUBS || chans.some((n) => /online store/i.test(n)),
            zeroPrice: prices.filter((x) => !(x > 0)).length,
            variants: prices.length,
          });
        }
        if (!d2.products.pageInfo.hasNextPage) break;
        c2 = d2.products.pageInfo.endCursor;
      }
    } catch (e) {
      console.log(`(could not read publications: ${e.message.slice(0, 90)})\n`);
    }

    if (pubRows.length) {
      const notOnline = pubRows.filter((r) => !r.online);
      const drafts = pubRows.filter((r) => r.status !== 'ACTIVE');
      const zero = pubRows.filter((r) => r.zeroPrice);
      if (PUBS) console.log(`Not on the Online Store channel    ${notOnline.length}`);
      console.log(`Not ACTIVE (draft/archived)        ${drafts.length}`);
      console.log(`Have a variant priced 0            ${zero.length}\n`);
      for (const [label, list] of [['NOT ON THE ONLINE STORE', notOnline], ['STILL DRAFT', drafts], ['PRICED 0', zero]]) {
        if (!list.length) continue;
        console.log(`── ${label} ──`);
        for (const r of list.slice(0, 12)) {
          const extra = label === 'PRICED 0' ? `  ${r.zeroPrice}/${r.variants} variants` : '';
          console.log(`  ${r.title.slice(0, 56)}${extra}`);
        }
        if (list.length > 12) console.log(`  …and ${list.length - 12} more`);
        console.log('');
      }
      if (!notOnline.length && !drafts.length && !zero.length) {
        console.log('Published, active and priced too.\n');
      }
    }

    if (!anyUnavail.length && !anyTracked.length && !anyDead.length) {
      console.log('Stock, publication and price all read as sellable from the API.');
      console.log('A storefront that still says "Sold out" is the THEME reading');
      console.log('variant.inventory_quantity instead of variant.available — with tracking');
      console.log('off, Shopify reports quantity 0 for everything, so a theme that checks');
      console.log('the number sees every product as out of stock.\n');
    }
    return;
  }

  if (LEGACY_SPECS) {
    if (!STORE_INDEX) die('--legacy-specs needs credentials so it can read your store.');

    // Only the hand-written part of the description — our own block is removed first, so
    // the two can be compared rather than one matching itself.
    const grab = (text, rx) => { const m = rx.exec(text); return m ? m[1].trim() : null; };
    const plain = (html) => String(html || '')
      .replace(/<li>/gi, '\n• ').replace(/<\/?(p|ul|br|div|h\d)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
      .replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();

    const out = [];
    for (const p of STORE_INDEX) {
      const body = plain(stripSpecs(p.descriptionHtml));
      if (!body) continue;

      const legacy = {
        color: grab(body, /Colou?r:\s*([A-Z][A-Z0-9\- ]{0,12})/i),
        clarity: grab(body, /Clarity:\s*([A-Z0-9\-, ]{2,16})/i),
        diamondCount: grab(body, /(\d+)\s+Diamonds\b/i),
        stoneSize: grab(body, /([\d.]+\s*mm)[^\n]{0,20}Stones?/i) || grab(body, /([\d.]+\s*mm)\b/i),
        length: grab(body, /Length:?\s*([\d.]+\s*(?:inch|inches|in|cm)[^\n]{0,14})/i)
             || grab(body, /Measures\s+([\d.]+\s*(?:inch|inches)[^.\n]{0,16})/i),
        hasHeading: /Diamond Details|Necklace Length|Specifications/i.test(body),
      };
      const anyLegacy = Object.entries(legacy).some(([k, v]) => k !== 'hasHeading' && v);
      if (!anyLegacy && !legacy.hasHeading) continue;

      // What our block prints for the same product, so the two can be set side by side.
      const code = (p.variants.map((v) => v.sku).join(' ').match(/\b(AJ[A-Z]{2}\d+)/i) || [])[1]
        || (p.haystacks.media.match(/\b(AJ[A-Z]{2}\d+)/i) || [])[1] || null;
      const ours = code ? specsFor(code) : {};
      const d = (cfg.specDefaults || {});
      const mine = {
        color: ours.color || d.color || null,
        clarity: ours.clarity || d.clarity || null,
        diamondCount: ours.diamondCount ? String(ours.diamondCount) : null,
        measurement: ours.measurement || null,
      };

      const clash = [];
      const same = (a, b) => String(a || '').replace(/\s+/g, '').toLowerCase()
                          === String(b || '').replace(/\s+/g, '').toLowerCase();
      if (legacy.color && mine.color && !same(legacy.color, mine.color)) clash.push(`color ${legacy.color} vs ${mine.color}`);
      if (legacy.clarity && mine.clarity && !same(legacy.clarity, mine.clarity)) clash.push(`clarity ${legacy.clarity} vs ${mine.clarity}`);
      if (legacy.diamondCount && mine.diamondCount && !same(legacy.diamondCount, mine.diamondCount)) clash.push(`count ${legacy.diamondCount} vs ${mine.diamondCount}`);

      out.push({ code, title: p.title, legacy, mine, clash });
    }

    if (!out.length) { console.log('No hand-written spec sections found.\n'); return; }

    const clashing = out.filter((r) => r.clash.length);
    const losing = out.filter((r) => !r.clash.length && ((r.legacy.length && true) || (r.legacy.stoneSize && !r.mine.measurement)));

    console.log(`${out.length} product${out.length === 1 ? '' : 's'} still carry a hand-written spec section.\n`);
    if (clashing.length) {
      console.log(`── ${clashing.length} DISAGREE with what our block prints ──`);
      for (const r of clashing) {
        console.log(`\n  ${r.code || '?'}  ${r.title}`);
        for (const c of r.clash) console.log(`      ✖ ${c}`);
      }
      console.log('');
    }
    if (losing.length) {
      console.log(`── ${losing.length} hold detail our block does not ──`);
      for (const r of losing) {
        const bits = [];
        if (r.legacy.length) bits.push(`length ${r.legacy.length}`);
        if (r.legacy.stoneSize && !r.mine.measurement) bits.push(`stone ${r.legacy.stoneSize}`);
        console.log(`  ${(r.code || '?').padEnd(10)} ${bits.join(', ')}   — ${r.title.slice(0, 48)}`);
      }
      console.log('');
    }

    const file = `legacy-specs-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
    fs.writeFileSync(file, JSON.stringify(out, null, 2));
    console.log(`Full detail written to ${file}`);
    console.log('Nothing was changed. Send me that file and I will fold the real values into');
    console.log('product-specs.json, then the block can replace the hand-written section.\n');
    return;
  }

  if (METAL_FILTER || FIX_METAL_FILTER) {
    if (!STORE_INDEX) die('--metal-filter needs credentials so it can read your store.');

    // The ten values the storefront filter is supposed to show. Anything else that turns
    // up in a metal-ish option, metafield or tag is what makes the duplicate rows.
    const canon = new Set((cfg.materials || []).map((m) => String(m.label).trim().toLowerCase()));
    const isCanon = (s) => canon.has(String(s).trim().toLowerCase());
    const metalish = (s) => /materi|metal/i.test(String(s || ''));

    const found = new Map(); // "source\u0000value" -> { source, value, hits: [] }
    const note = (source, value, hit) => {
      const k = `${source}\u0000${value}`;
      if (!found.has(k)) found.set(k, { source, value, hits: [] });
      found.get(k).hits.push(hit);
    };

    // hasVariants tells an orphaned option value apart from a real one. It is not in
    // every API version, so fall back to the same query without it rather than failing.
    let HAS_VARIANTS = true;
    const pageQuery = (withHasVariants) => `query($cursor: String) {
      products(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id title tags
          options { id name optionValues { id name${withHasVariants ? ' hasVariants' : ''} } }
          metafields(first: 30) { nodes { id namespace key type
            references(first: 25) { nodes { ... on Metaobject { id type handle displayName } } } } }
        }
      }
    }`;

    let cursor = null, scanned = 0;
    for (;;) {
      let d;
      try {
        d = await gql(pageQuery(HAS_VARIANTS), { cursor });
      } catch (e) {
        if (!HAS_VARIANTS || !/hasVariants/i.test(e.message)) throw e;
        HAS_VARIANTS = false;
        d = await gql(pageQuery(false), { cursor });
      }
      for (const p of d.products.nodes) {
        scanned++;

        // 1. the variant option itself
        for (const o of p.options || []) {
          if (!metalish(o.name)) continue;
          for (const v of o.optionValues || []) {
            note(`option "${o.name}"`, v.name,
              { p, optionId: o.id, valueId: v.id,
                hasVariants: HAS_VARIANTS ? v.hasVariants !== false : true });
          }
        }

        // 2. a metaobject-backed metafield (this is what Shopify's own filters read)
        for (const m of p.metafields?.nodes || []) {
          const refs = (m.references?.nodes || []).filter((r) => r?.id);
          if (!refs.length) continue;
          const key = `${m.namespace}.${m.key}`;
          if (!metalish(key) && !metalish(refs[0].type)) continue;
          for (const r of refs) {
            note(`metafield ${key}`, r.displayName || r.handle,
              { p, metafield: m, refId: r.id, refs });
          }
        }

        // 3. a plain tag
        for (const t of p.tags || []) {
          const m = /^(?:metal|material)\s*[:_-]\s*(.+)$/i.exec(t);
          if (m) note('tag', m[1].trim(), { p, tag: t });
        }
      }
      if (!d.products.pageInfo.hasNextPage) break;
      cursor = d.products.pageInfo.endCursor;
    }

    const bySource = new Map();
    for (const e of found.values()) {
      if (!bySource.has(e.source)) bySource.set(e.source, []);
      bySource.get(e.source).push(e);
    }

    const strays = [];
    console.log(`Scanned ${scanned} products for anything a METAL filter could read.\n`);
    for (const [source, list] of [...bySource].sort()) {
      console.log(source);
      for (const e of list.sort((a, z) => z.hits.length - a.hits.length || a.value.localeCompare(z.value))) {
        const ok = isCanon(e.value);
        const dead = e.hits.every((h) => h.hasVariants === false);
        console.log(`  ${ok ? '✓' : '✖'} ${String(e.value).padEnd(24)} ${String(e.hits.length).padStart(3)} product${e.hits.length === 1 ? '' : 's'}${dead ? '   (no variants use it)' : ''}`);
        if (!ok) {
          strays.push(e);
          for (const h of e.hits.slice(0, 8)) console.log(`        ${h.p.title}`);
          if (e.hits.length > 8) console.log(`        …and ${e.hits.length - 8} more`);
        }
      }
      console.log('');
    }

    if (!strays.length) {
      console.log('Nothing outside your ten values — the filter rows must come from somewhere else.\n');
      return;
    }
    if (!FIX_METAL_FILTER) {
      console.log(`${strays.length} value${strays.length === 1 ? '' : 's'} above (✖) are what show up as duplicates.`);
      console.log('To clear them:  node import.js --fix-metal-filter        (dry run)');
      console.log('                node import.js --fix-metal-filter --live\n');
      return;
    }

    // ---- the fix. Only ever touches the ✖ values; canonical ones are left alone. ----
    const mfEdits = new Map(); // productId+ns.key -> { p, m, keep:Set(id) }
    const optEdits = new Map(); // productId+optionId -> { p, optionId, drop:Set(valueId), unsafe:[] }
    const tagEdits = new Map(); // productId -> { p, tags:Set }

    for (const e of strays) {
      for (const h of e.hits) {
        if (h.metafield) {
          const k = `${h.p.id}|${h.metafield.namespace}.${h.metafield.key}`;
          if (!mfEdits.has(k)) mfEdits.set(k, { p: h.p, m: h.metafield, keep: new Set(h.refs.map((r) => r.id)) });
          mfEdits.get(k).keep.delete(h.refId);
        } else if (h.optionId) {
          const k = `${h.p.id}|${h.optionId}`;
          if (!optEdits.has(k)) optEdits.set(k, { p: h.p, optionId: h.optionId, drop: new Set(), unsafe: [] });
          // A value a variant actually uses can't be removed without destroying the variant.
          if (h.hasVariants) optEdits.get(k).unsafe.push(e.value);
          else optEdits.get(k).drop.add(h.valueId);
        } else if (h.tag) {
          if (!tagEdits.has(h.p.id)) tagEdits.set(h.p.id, { p: h.p, tags: new Set() });
          tagEdits.get(h.p.id).tags.add(h.tag);
        }
      }
    }

    for (const { p, m, keep } of mfEdits.values()) {
      const label = `${m.namespace}.${m.key}`;
      if (keep.size) {
        if (DRY) { console.log(`· ${p.title}  ${label} → keep ${keep.size} reference${keep.size === 1 ? '' : 's'}`); continue; }
        try {
          const d = await gql(
            `mutation($mf: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $mf) { userErrors { field message } } }`,
            { mf: [{ ownerId: p.id, namespace: m.namespace, key: m.key, type: m.type, value: JSON.stringify([...keep]) }] }
          );
          checkErrors(d.metafieldsSet, 'metafieldsSet');
          console.log(`✓ ${p.title}  ${label} trimmed`);
        } catch (err) { console.log(`✖ ${p.title}  ${label} ${err.message.slice(0, 90)}`); }
      } else {
        if (DRY) { console.log(`· ${p.title}  ${label} → remove (nothing valid left on it)`); continue; }
        try {
          const d = await gql(
            `mutation($mf: [MetafieldIdentifierInput!]!) { metafieldsDelete(metafields: $mf) { userErrors { field message } } }`,
            { mf: [{ ownerId: p.id, namespace: m.namespace, key: m.key }] }
          );
          checkErrors(d.metafieldsDelete, 'metafieldsDelete');
          console.log(`✓ ${p.title}  ${label} removed`);
        } catch (err) { console.log(`✖ ${p.title}  ${label} ${err.message.slice(0, 90)}`); }
      }
    }

    for (const { p, optionId, drop, unsafe } of optEdits.values()) {
      for (const v of new Set(unsafe)) {
        console.log(`⚠ ${p.title}  option value "${v}" is used by a real variant — left alone.`);
        console.log(`     Give that variant one of your ten values first, then run this again.`);
      }
      if (!drop.size) continue;
      if (DRY) { console.log(`· ${p.title}  drop ${drop.size} unused option value${drop.size === 1 ? '' : 's'}`); continue; }
      try {
        const d = await gql(
          `mutation($productId: ID!, $option: OptionUpdateInput!, $del: [ID!]) {
             productOptionUpdate(productId: $productId, option: $option, optionValuesToDelete: $del) {
               userErrors { field message }
             }
           }`,
          { productId: p.id, option: { id: optionId }, del: [...drop] }
        );
        checkErrors(d.productOptionUpdate, 'productOptionUpdate');
        console.log(`✓ ${p.title}  ${drop.size} option value${drop.size === 1 ? '' : 's'} removed`);
      } catch (err) { console.log(`✖ ${p.title}  ${err.message.slice(0, 90)}`); }
    }

    for (const { p, tags } of tagEdits.values()) {
      if (DRY) { console.log(`· ${p.title}  remove tag${tags.size === 1 ? '' : 's'} ${[...tags].join(', ')}`); continue; }
      try {
        const d = await gql(
          `mutation($id: ID!, $tags: [String!]!) { tagsRemove(id: $id, tags: $tags) { userErrors { field message } } }`,
          { id: p.id, tags: [...tags] }
        );
        checkErrors(d.tagsRemove, 'tagsRemove');
        console.log(`✓ ${p.title}  tags removed`);
      } catch (err) { console.log(`✖ ${p.title}  ${err.message.slice(0, 90)}`); }
    }

    if (DRY) console.log('\nDry run — nothing changed. Add --live to apply.\n');
    else console.log('\nDone. The storefront filter can take a few minutes to catch up.\n');
    return;
  }

  if (METAOBJECTS) {
    if (!STORE_INDEX) die('--metaobjects needs credentials so it can read your store.');
    // What the token can actually do — settles scope questions rather than guessing.
    try {
      const w = await gql(`{ currentAppInstallation { accessScopes { handle } } }`);
      const have = (w.currentAppInstallation?.accessScopes || []).map((x) => x.handle).sort();
      console.log(`Granted scopes: ${have.join(', ') || '(none reported)'}`);
      for (const need of ['read_metaobjects', 'read_metaobject_definitions', 'read_publications', 'write_publications']) {
        if (!have.includes(need)) console.log(`  ✖ missing ${need}`);
      }
      console.log('');
    } catch (e) { console.log(`(could not read scopes: ${e.message.slice(0, 80)})\n`); }

    // Straight at the taxonomy definition, by type rather than by id.
    for (const t of ['shopify--stone-shape', 'stone_shape', 'shopify--2024-07--stone-shape']) {
      try {
        const r = await gql(`query($t: String!) { metaobjectDefinitionByType(type: $t) { id type name } }`, { t });
        if (r.metaobjectDefinitionByType) console.log(`byType("${t}") → ${r.metaobjectDefinitionByType.name}`);
      } catch (e) { console.log(`byType("${t}") ✖ ${e.message.slice(0, 70)}`); }
    }

    const defs = await refMetafieldDefs();
    if (!defs.length) { console.log('No product metafields point at a metaobject.\n'); return; }

    // Products already carry references, and reading those needs only read_products — so
    // this works even when the metaobject scopes are missing.
    try {
      const probe = await gql(
        `{ products(first: 50) { nodes {
             metafields(first: 25) { nodes { namespace key type
               references(first: 5) { nodes { ... on Metaobject { type handle displayName } } } } } } } }`
      );
      const seen = new Map();
      for (const pr of probe.products?.nodes || []) {
        for (const m of pr.metafields?.nodes || []) {
          for (const r of m.references?.nodes || []) {
            if (!r?.type) continue;
            const k = `${m.namespace}.${m.key}`;
            if (!seen.has(k)) seen.set(k, { type: r.type, examples: new Set() });
            seen.get(k).examples.add(r.displayName || r.handle);
          }
        }
      }
      if (seen.size) {
        console.log('From products that already have values set:');
        for (const [k, v] of seen) {
          console.log(`  ${k.padEnd(30)} ${v.type}   e.g. ${[...v.examples].slice(0, 5).join(', ')}`);
        }
      }
    } catch (e) {
      console.log(`(could not probe products: ${e.message.slice(0, 80)})`);
    }
    for (const d of defs) {
      console.log(`\n${(d.namespace + '.' + d.key).padEnd(30)} "${d.name}"  ${d.type}`);
      if (!d.moType) { console.log(`   ✖ ${d.why || 'could not resolve its metaobject definition'}`); continue; }
      console.log(`   metaobject type: ${d.moType}`);
      const list = await metaobjectEntries(d.moType);
      if (!list.length) console.log('   (no entries yet)');
      for (const n of list) console.log(`   • ${String(n.displayName || n.handle).padEnd(22)} ${n.handle}`);
    }
    console.log(`\nPut the one you want in config.json, e.g.`);
    console.log(`  "shapeMetafield": { "namespace": "shopify", "key": "stone-shape" }\n`);
    return;
  }

  if (SYNC_SHAPE_REF) {
    if (!STORE_INDEX) die('--sync-shape-ref needs credentials so it can read your store.');
    const mf = cfg.shapeMetafield;
    if (!mf?.namespace || !mf?.key) die('Set "shapeMetafield": { "namespace": "shopify", "key": "stone-shape" } in config.json.\n  Run --metaobjects to see what is available.');

    const def = (await refMetafieldDefs()).find((d) => d.namespace === mf.namespace && d.key === mf.key);
    if (!def) die(`No product metafield ${mf.namespace}.${mf.key} that points at a metaobject. Run --metaobjects.`);
    if (!def.moType) die(`Could not work out which metaobject ${mf.namespace}.${mf.key} points at.`);
    const isList = def.type === 'list.metaobject_reference';
    console.log(`${mf.namespace}.${mf.key} → ${def.moType} (${def.type})\n`);

    // Display name only. Handles are Shopify's own base shapes and don't line up — the
    // "Emerald" entry has the handle "cushion", so matching handles would link every
    // cushion-cut product to Emerald.
    const all = await metaobjectEntries(def.moType);
    const entries = new Map();
    for (const n of all) {
      if (n.displayName) entries.set(String(n.displayName).trim().toLowerCase(), n.id);
    }
    const names = new Set(entries.keys());
    for (const n of all) {
      const h = String(n.handle || '').trim().toLowerCase();
      if (h && !names.has(h) && !entries.has(h)) entries.set(h, n.id);
    }
    if (!entries.size) die(`"${def.moType}" has no entries. Add them in Settings > Custom data, then run this again.`);

    let set = 0, none = 0;
    const missing = new Set();
    const blocked = new Map();
    for (const p of STORE_INDEX) {
      const f = facetsFor(p.title);
      if (!f.shapes.length) { none++; continue; }
      const wanted = isList ? f.shapes : f.shapes.slice(0, 1);
      const ids = [];
      for (const sh of wanted) {
        const id = entries.get(sh.toLowerCase());
        if (id) ids.push(id); else missing.add(sh);
      }
      if (!ids.length) continue;
      const value = isList ? JSON.stringify(ids) : ids[0];

      if (DRY) { console.log(`· ${wanted.join(', ').padEnd(18)} ${p.title.slice(0, 50)}`); set++; continue; }
      try {
        const r = await gql(
          `mutation($input: ProductInput!) {
             productUpdate(input: $input) { product { id } userErrors { field message } }
           }`,
          { input: { id: p.id, metafields: [{ namespace: mf.namespace, key: mf.key, type: def.type, value }] } }
        );
        checkErrors(r.productUpdate, 'productUpdate');
        console.log(`✓ ${wanted.join(', ').padEnd(18)} ${p.title.slice(0, 50)}`);
        set++;
      } catch (err) {
        // "Owner subtype does not match" = this product's category isn't one the
        // definition applies to. Group those by category rather than printing 60 lines.
        if (/owner subtype/i.test(err.message)) {
          const c = p.category || '(no category)';
          blocked.set(c, (blocked.get(c) || 0) + 1);
        } else {
          console.log(`✖ ${p.title.slice(0, 40).padEnd(40)} ${err.message.slice(0, 80)}`);
        }
      }
    }
    if (blocked.size) {
      console.log(`\nRejected — the metafield definition doesn't cover these categories:`);
      for (const [c, n] of [...blocked].sort((a, z) => z[1] - a[1])) {
        console.log(`  ${String(c).padEnd(34)} ${n} product(s)`);
      }
      console.log(`\n  Fix: Settings > Custom data > Products > Stone shape > Edit,`);
      console.log(`  and add those categories to the ones it applies to.`);
    }
    console.log(`\n${set} ${DRY ? 'would be linked' : 'linked'}, ${none} product(s) name no shape in the title.`);
    if (missing.size) {
      console.log(`\nNo entry for: ${[...missing].join(', ')} — add them to the metaobject and run again.`);
    }
    console.log('');
    return;
  }

  if (COLLECT_SPECS) {
    // Everything in an item folder that isn't a render: CAD spec sheets, PDFs, notes.
    // Copied into _specs/<CODE>/ so they can be read and turned into product-specs.json.
    const outDir = './_specs';
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    const READABLE = ['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.txt', '.csv', '.xlsx', '.xls', '.docx', '.doc'];
    const renderTail = new RegExp(`-(${cfg.colours.map((c) => rxEsc(c.code)).join('|')})\\s*\\d*$`, 'i');

    const walk = (d) => {
      const out = [];
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const full = path.join(d, e.name);
        if (e.isDirectory()) out.push(...walk(full)); else out.push(full);
      }
      return out;
    };

    let items = 0, copied = 0;
    const unreadable = [];
    for (const cat of fs.readdirSync(cfg.imagesDir, { withFileTypes: true })) {
      if (!cat.isDirectory() || cat.name.startsWith('.')) continue;
      const catDir = path.join(cfg.imagesDir, cat.name);
      for (const it of fs.readdirSync(catDir, { withFileTypes: true })) {
        if (!it.isDirectory() || it.name.startsWith('.')) continue;
        if (IGNORE_PREFIXES.some((x) => it.name.toUpperCase().startsWith(x))) continue;
        const code = baseCode(it.name);
        if (ONLY && !ONLY.includes(code.toUpperCase())) continue;

        const extras = walk(path.join(catDir, it.name)).filter((f) => {
          const ext = path.extname(f).toLowerCase();
          const stem = path.basename(f, ext);
          const isRender = [...IMAGE_EXT, ...VIDEO_EXT].includes(ext) && renderTail.test(normStem(stem));
          return !isRender;
        });
        if (!extras.length) continue;
        items++;

        const dest = path.join(outDir, code);
        fs.mkdirSync(dest, { recursive: true });
        const names = [];
        for (const f of extras) {
          const ext = path.extname(f).toLowerCase();
          if (!READABLE.includes(ext)) { unreadable.push(`${code}  ${path.basename(f)}`); continue; }
          const target = path.join(dest, path.basename(f));
          // Big images are shrunk so the text on them stays legible but the file is small.
          if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
            try {
              execFileSync('sips', ['-s', 'format', 'jpeg', '-Z', '1800', f, '--out', target.replace(/\.[^.]+$/, '.jpg')], { stdio: 'ignore' });
            } catch { fs.copyFileSync(f, target); }
          } else {
            fs.copyFileSync(f, target);
          }
          names.push(path.basename(f));
          copied++;
        }
        console.log(`  ${code.padEnd(12)} ${names.length ? names.join(', ') : '(nothing readable)'}`);
      }
    }
    console.log(`\n${copied} spec file(s) from ${items} item(s) copied to ${outDir}/`);
    if (unreadable.length) {
      console.log(`\n${unreadable.length} file(s) are CAD models or other formats that can't be read as text — skipped:`);
      for (const u of unreadable.slice(0, 30)) console.log(`  ${u}`);
    }
    console.log(`\nTell Claude "specs collected" and it will read ${outDir}/ and fill product-specs.json.\n`);
    return;
  }

  if (SYNC_SPECS) {
    if (!STORE_INDEX) die('--sync-specs needs credentials so it can read your store.');

    // Deleting prose cannot be undone from Shopify, and for hand-built products the copy
    // exists nowhere else, so every live description is written to disk first.
    if (!DRY && (cfg.descriptionStyle || 'full') === 'specs-only') {
      const f = `descriptions-before-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
      fs.writeFileSync(f, JSON.stringify(
        STORE_INDEX.map((p) => ({ id: p.id, title: p.title, descriptionHtml: p.descriptionHtml })), null, 2));
      console.log(`Saved every current description to ${f} before changing anything.\n`);
    }

    let changed = 0, same = 0, none = 0;
    for (const r of renderItems) {
      const code = baseCode(r.code);
      if (ONLY && !ONLY.includes(code.toUpperCase())) continue;
      const hit = findInIndex(code);
      if (!hit) continue;

      const live = hit.product.descriptionHtml || hit.product.description || '';
      const block = specsHtml(code, hit.product.title, live);
      if (!block) { none++; continue; }

      // Build on the live description, so any edits made in Admin are kept.
      const next = composeDescription(live, block);
      if (next === hit.product.descriptionHtml) { same++; continue; }

      const summary = block.replace(/<[^>]+>/g, ' ').replace(/\u2192 /g, '').replace(/\s+/g, ' ').trim().slice(0, 100);

      if (DRY) { console.log(`· ${code.padEnd(12)} ${summary}`); changed++; continue; }
      try {
        const d = await gql(
          `mutation($input: ProductInput!) {
             productUpdate(input: $input) { product { id } userErrors { field message } }
           }`,
          { input: { id: hit.product.id, descriptionHtml: next } }
        );
        checkErrors(d.productUpdate, 'productUpdate');
        console.log(`✓ ${code.padEnd(12)} ${summary}`);
        changed++;
      } catch (e) {
        console.log(`✖ ${code.padEnd(12)} ${e.message.slice(0, 90)}`);
      }
    }
    console.log(`\n${changed} ${DRY ? 'would get' : 'got'} a Specifications block, ${same} already up to date, ${none} have no spec data yet.\n`);
    return;
  }

  if (SYNC_CONTENT) {
    if (!STORE_INDEX) die('--sync-content needs credentials so it can read your store.');
    const placeholder = cfg.defaults.untitledTitle || 'Untitled — description needed';
    let fixed = 0, skipped = 0;
    const noCopy = [];

    for (const r of renderItems) {
      const code = baseCode(r.code);
      if (ONLY && !ONLY.includes(code.toUpperCase())) continue;

      const item = sheetByCode.get(code.toUpperCase()) || { code: r.code };
      const hit = findInIndex(code);
      if (!hit) continue;

      let copy = contentFor(item);
      if (!copy && HAS_KEY() && !DRY) {
        process.stdout.write(`  ${code.padEnd(12)} writing copy from the render…`);
        try {
          const rr = await describeItem({ code, folder: r.code, category: r.category, files: r.files, sheet: sheetFacts(item) });
          CONTENT[code] = { title: rr.title, description: rr.description };
          fs.writeFileSync(cfg.contentFile, JSON.stringify(CONTENT, null, 2) + '\n');
          copy = CONTENT[code];
          process.stdout.write('\r');
        } catch (e) {
          process.stdout.write(`\r✖ ${code.padEnd(12)} ${e.message}\n`);
          continue;
        }
      }
      if (!copy) { noCopy.push(code); continue; }

      // A hand-written title is never overwritten. A thin description still gets filled
      // in, because that's a gap rather than a decision someone made.
      const isPlaceholder = hit.product.title === placeholder ||
        hit.product.title === code || /^untitled/i.test(hit.product.title);
      const thinDescription = !hit.product.description ||
        hit.product.description.trim().length < 80;

      if (!isPlaceholder && !thinDescription && !FORCE) { skipped++; continue; }

      const newTitle = (isPlaceholder || FORCE) ? copy.title : hit.product.title;
      const what = isPlaceholder || FORCE ? 'title + description' : 'description only';

      if (DRY) {
        console.log(`· ${code.padEnd(12)} ${what.padEnd(20)} "${hit.product.title.slice(0, 34)}" -> "${newTitle.slice(0, 34)}"`);
      } else {
        try {
          await updateContent(hit.product.id, newTitle, buildDescription(item));
          console.log(`✓ ${code.padEnd(12)} ${what.padEnd(20)} ${newTitle}`);
        } catch (e) {
          console.log(`✖ ${code.padEnd(12)} ${e.message}`);
          continue;
        }
      }
      fixed++;
    }

    console.log(`\n${fixed} ${DRY ? 'would be updated' : 'updated'}, ${skipped} already fine (use --force to rewrite).`);
    if (noCopy.length) {
      console.log(`\n${noCopy.length} in the store have nothing written for them yet:`);
      console.log(`  node describe.js --write --only ${noCopy.join(',')}`);
      console.log(`then run this again.`);
    }
    console.log('');
    return;
  }

  const report = [];
  let done = 0, totalBytes = 0;

  for (const rendered of renderItems) {
    if (done >= LIMIT) break;

    const code = baseCode(rendered.code);
    if (ONLY && !ONLY.includes(code.toUpperCase())) continue;

    // Price and specs come from the packing list. No row, no product.
    let item = sheetByCode.get(code.toUpperCase());

    // Not on the packing list? The flat price list may still have it, with real prices.
    if (!item && priceList.has(code.toUpperCase())) {
      item = itemFromPriceList(code, priceList.get(code.toUpperCase()));
    }

    if (!item && ALLOW_NO_PRICE) {
      // Rendered but not yet priced. Build it from the renders alone: every configured
      // metal at a placeholder price, forced to DRAFT and tagged, so it can never go live
      // at zero and is easy to find once the accountant sends the numbers.
      item = {
        code: rendered.code,
        needsPrice: true,
        rows: cfg.metals.map((m) => ({
          metal: m, grossWt: null, netWt: null,
          diamondCode: '', diamondSize: '', diamondPcs: null, diamondCts: null,
          price: cfg.defaults.placeholderPrice || '0.00',
        })),
      };
    }
    if (!item) {
      console.log(`⚠ ${code.padEnd(18)} rendered (${rendered.category}) but not in the packing list — no price`);
      report.push({ code, status: 'skipped', note: `no packing-list row (renders in ${rendered.category}/${rendered.code})` });
      continue;
    }

    const media = mediaForItem(rendered.files, rendered.code);
    const plan = planItem(item, media);

    const problems = [];
    if (item.rows.some((r) => r.price === null)) problems.push('some metals have no price');
    if (!contentFor(item)) problems.push('no title/description in product-content.json');
    if (!Object.keys(media).length) problems.push('no renders found');
    else if (plan.colours.length < cfg.colours.length) {
      problems.push(`only ${plan.colours.map((c) => c.code).join('/')} renders`);
    }

    // No copy yet? Write it now from the render rather than creating an "Untitled"
    // product, then carry on with the same run.
    if (!contentFor(item)) {
      if (HAS_KEY() && !DRY) {
        process.stdout.write(`  ${code.padEnd(18)} writing copy from the render…`);
        try {
          const r = await describeItem({ code, folder: rendered.code, category: rendered.category, files: rendered.files, sheet: sheetFacts(item, plan) });
          CONTENT[code] = { title: r.title, description: r.description };
          fs.writeFileSync(cfg.contentFile, JSON.stringify(CONTENT, null, 2) + '\n');
          process.stdout.write(`\r  ${code.padEnd(18)} ${r.title}\n`);
        } catch (e) {
          process.stdout.write(`\r✖ ${code.padEnd(18)} could not write copy: ${e.message}\n`);
          report.push({ code, status: 'skipped', note: `copy generation failed: ${e.message}` });
          continue;
        }
      } else if (!ALLOW_UNTITLED) {
        console.log(`⚠ ${code.padEnd(18)} no copy yet — ${HAS_KEY() ? 'dry run, would write it from the render' : 'set ANTHROPIC_API_KEY so it can be written from the render'}`);
        report.push({ code, status: 'skipped', note: 'no copy, and no ANTHROPIC_API_KEY to write it' });
        continue;
      }
    }

    if (!plan.variantCount) {
      console.log(`⚠ ${code.padEnd(18)} ${problems.join(', ') || 'nothing to create'}`);
      report.push({ code, status: 'skipped', note: problems.join('; ') });
      continue;
    }

    totalBytes += plan.bytes;

    // With a token available, check the store even on a dry run — so duplicates against
    // products you added by hand show up before you commit to a live run.
    const existing = STORE_INDEX ? findInIndex(code) : null;
    if (existing && !FORCE) {
      console.log(`= ${code.padEnd(18)} already in store (matched by ${existing.matchedBy}) — "${existing.product.title}"`);
      report.push({ code, status: 'exists', note: `matched by ${existing.matchedBy}: ${existing.product.title}` });
      continue;
    }

    if (DRY) {
      const prices = [...new Set(plan.materials.map((m) => `${m.metal} $${m.price}`))].join('  ');
      console.log(`· ${code.padEnd(18)} ${buildTitle(item)}`);
      console.log(`  ${''.padEnd(18)} ${plan.variantCount} variants — ${plan.materials.map((m) => m.label).join(', ')}`);
      console.log(`  ${''.padEnd(18)} ${prices}`);
      console.log(`  ${''.padEnd(18)} ${plan.files} media files, ${mb(plan.bytes)} MB`);
      if (item.needsPrice) console.log(`  ${''.padEnd(18)} NO PRICE YET — DRAFT at ${cfg.defaults.placeholderPrice || '0.00'}, tagged "${cfg.defaults.missingPriceTag || 'needs-price'}"`);
      if (problems.length) console.log(`  ${''.padEnd(18)} note: ${problems.join('; ')}`);
      report.push({ code, status: 'would create', variants: plan.variantCount, media: plan.files, mb: mb(plan.bytes), note: problems.join('; ') });
      done++;
      continue;
    }

    try {
      process.stdout.write(`  ${code.padEnd(18)} creating…`);
      const product = await createProduct(item, plan);

      const { featured, count } = await attachMedia(product, plan, media, buildTitle(item), (n) => {
        process.stdout.write(`\r  ${code.padEnd(18)} uploading ${n}/${plan.files}…    `);
      });

      const variants = await createVariants(product, item, plan, featured);
      const url = `https://${cfg.store}/admin/products/${product.id.split('/').pop()}`;

      process.stdout.write('\r');
      console.log(`✓ ${code.padEnd(18)} ${variants.length} variants, ${count} media  ${url}`);
      report.push({ code, status: 'created', variants: variants.length, media: count, mb: mb(plan.bytes), url, note: problems.join('; ') });
      done++;
    } catch (err) {
      process.stdout.write('\r');
      console.log(`✖ ${code.padEnd(18)} ${err.message}`);
      report.push({ code, status: 'error', note: err.message });
    }
  }

  const cols = ['code', 'status', 'variants', 'media', 'mb', 'note', 'url'];
  const csv = [cols.join(',')]
    .concat(report.map((r) => cols.map((c) => `"${String(r[c] ?? '').replace(/"/g, '""')}"`).join(',')))
    .join('\n');
  const out = `import-report-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
  fs.writeFileSync(out, csv);

  const tally = report.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] || 0) + 1 }), {});
  console.log(`\n${Object.entries(tally).map(([k, v]) => `${v} ${k}`).join('  ·  ')}`);
  console.log(`Media to upload: ${mb(totalBytes)} MB`);
  console.log(`Report: ${out}\n`);
}

main().catch((e) => die(e.stack || e.message));
