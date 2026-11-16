# Danbooru tag sheet generator

Builds `danbooruTags.ts` (in this folder), the data behind the SDXL tab's
**Danbooru Tag Rehberi**, from Danbooru's own tag group wiki pages
(<https://danbooru.donmai.us/wiki_pages/tag_groups>). The app never calls
Danbooru; this is run by hand when the list should change.

```sh
./run.sh               # cached downloads where present (fast, offline after the first run)
./run.sh --refresh     # re-download pages and post counts (a few minutes, ~90 requests)
OUT=/tmp/x.ts ./run.sh # write elsewhere instead
```

The app's copy is **not** touched. To use the new file (from the project root):

```sh
diff src/workflow/danbooruTags.ts scripts/danbooru/danbooruTags.ts   # see what changed
cp scripts/danbooru/danbooruTags.ts src/workflow/danbooruTags.ts
npm run build
```

| Step | Does | Output (in `cache/`, gitignored) |
|---|---|---|
| `1_fetch_pages.py` | Downloads the `tag_group:*` wiki pages listed in `PAGES` | `pages/*.json` |
| `2_parse.py` | Splits each page into its headings and the `[[tag]]` links under them | `parsed.json`, `alltags.json` |
| `3_counts.py` | Looks up post count / category / deprecated for every tag; resolves aliases of dead names | `taginfo.json`, `aliases.json` |
| `4_emit.py` | Keeps general, non-deprecated tags with 500+ posts, applies the adults-only blocklist, groups pages into the app's categories, adds Kalite/Negatif | `emitted.json` |
| `5_finalize.mjs` | De-duplicates (each tag once, on its most specific page), folds sections under 3 tags into "Diğer", adds the curated Yuri page, writes the `.ts` | `danbooruTags.ts` (this folder) |

Where to change what:

- **Add / remove a Danbooru page:** `PAGES` in `1_fetch_pages.py`, and put it
  in a category in `CATEGORIES` in `4_emit.py`.
- **Categories, threshold, blocklist, Kalite / Negatif lists:** `4_emit.py`.
- **Yuri page, de-dup rules, "Diğer" threshold:** `5_finalize.mjs`.

Hand edits to the generated `danbooruTags.ts` are overwritten by the next run — make the
change in these scripts instead.

Requires Python 3 (standard library only) and Node.
