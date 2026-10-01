# Adding new products to Shopify

Everything lives in this folder. One command does the routine; it stops and tells you
whenever a decision is yours to make.

---

## The normal day

The renderer has added new pieces to Drive. Maybe the accountant has sent a new packing
list too. You want them in Shopify.

### 1. If there's a new packing list

Open it in Google Sheets → **File → Download → Comma-separated values (.csv)** →
save it into this folder as `packing-list.csv`, replacing the old one.

Don't open the download first — if Numbers opens it, it saves it back in the wrong format
and the script will say "0 items parsed".

No new packing list? Skip this. The old one stays valid.

### 2. Make sure Drive has synced

The renders come from:

    ~/Google Drive/My Drive/Asimi/C&B/Render

Open that folder in Finder and check the new item folders are there. Google Drive streams
files, so give it a minute after the renderer uploads.

### 3. Run it

    cd ~/Development/shopify-bulk-add
    ./update.sh

That's it. One of two things happens.

**Either it runs straight through** — creates the new products with their images,
variants and prices, fixes anything previously left unfinished, and prints a clean
report at the end.

**Or it stops at step 1** saying some items have no title or description yet. This is
normal for pieces nobody has written up before. When that happens:

- Message Claude here and say **"new items to describe"**
- Claude reads the previews in `_identify/`, writes the titles and descriptions
  into `product-content.json`, and tells you when it's done
- Run `./update.sh` again — it'll go straight through this time

Nothing reaches your store until the copy exists. That's deliberate: it's what stopped
products landing as "Untitled".

---

## What gets created

One product per item folder, with:

- **Title and description** — from `product-content.json`
- **Material** — one option with ten values: 925 Sterling Silver, then 10k/14k/18k in
  Yellow, White and Rose
- **Price** — from the packing list's `(USD)` column, per metal
- **Images** — all the renders, each tagged with your theme's colour alt text
  (`#Jewelry material_Gold` and so on) so the colour filtering works
- **Track quantity** — off
- **SKU** — `AJER680-G18K-Y` style, per variant

An item with renders but no packing-list row is created as a **draft at $0.00**, tagged
`needs-price`. It can't go live by accident. Add it to the sheet later and set the price.

---

## Checking and fixing

    node import.js --check

Reads your whole store and lists anything unfinished — placeholder titles, missing
descriptions, prices at 0, products with no images. Changes nothing.

    node import.js --audit

Shows every rendered item and whether it's in the store, plus what's rendered-but-unpriced
and priced-but-unrendered. Changes nothing.

    node import.js --live --sync-content

Pushes titles and descriptions from `product-content.json` onto products already in the
store. It never overwrites a title you wrote by hand — it only fills in placeholders and
missing descriptions. Add `--force` to rewrite everything.

---

## Useful flags

    node import.js                        dry run — shows what would happen, changes nothing
    node import.js --live                 create new products
    node import.js --live --limit 1       just one, for testing
    node import.js --live --only AJER680  one specific item
    node import.js --live --no-video      skip the .mp4 files (much faster)
    node import.js --collect-images       previews of anything not yet written up
    node import.js --export-untitled      list unfinished products to a JSON file

`--limit` needs a number after it. Without one the script stops rather than guessing.

---

## Files here

    update.sh              the one command
    import.js              the importer
    describe.js            writes copy from renders (needs a paid API key — unused)
    config.json            store, paths, materials, defaults
    product-content.json   every product's title and description — plain text, edit freely
    packing-list.csv       the current packing list
    _identify/             previews for Claude, rebuilt each run
    import-report-*.csv    one per run

`product-content.json` is the one worth knowing. It's just titles and descriptions keyed
by item code. Change anything in it, run `node import.js --live --sync-content`, and the
store follows.

---

## When something looks wrong

**"0 items parsed"** — `packing-list.csv` isn't really a CSV. Re-download it as
Comma-separated values and don't open it on the way.

**"Render folder not found"** — Drive hasn't synced, or the folder moved. Check the path
in `config.json`.

**"no renders found" for an item** — the folder name and the file names disagree. The
script reads the code from the start of the name (`AJER666`, `AJNT26-33CTS`,
`AJER666 3.0 CTS` all work), so something unusual is going on. Send the folder name.

**Everything says "already in store"** — that's right, and good. The script matches on
image filenames, so it recognises products you built by hand and won't duplicate them.

**A price looks wrong** — it came from the packing list. Check the sheet before editing
Shopify, or the next run will put it back.
