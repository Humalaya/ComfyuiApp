// Step 5 — de-duplicate, add the curated Yuri page, and write
// danbooruTags.ts (next to these scripts) from cache/emitted.json (step 4).
// It does NOT touch the app: copy it over to src/workflow/ once it looks
// right (see README.md).
//
//   node 5_finalize.mjs [output.ts]     (default: ./danbooruTags.ts)
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const IN = path.join(HERE, 'cache', 'emitted.json')
const OUT = path.resolve(process.argv[2] ?? path.join(HERE, 'danbooruTags.ts'))
if (!fs.existsSync(IN)) {
  console.error('missing cache/emitted.json — run 4_emit.py first')
  process.exit(1)
}
const { categories: cats, counts } = JSON.parse(fs.readFileSync(IN, 'utf8'))

// --- De-duplication --------------------------------------------------------
// Danbooru lists many tags on several pages. Each tag is kept once, on its
// most specific home: broad "overview" pages and misc/more sections give way.
// (Face is deliberately not one: listing 'face-tags' here would move its
// emotes — xd, ;3, > < — over to Eyes.)
const OVERVIEW = new Set(['image-composition', 'body-parts', 'attire', 'nudity', 'sex-acts'])
const MISC = /^(misc|more|other|general)\b|miscellaneous|\/ more/i
const SKIP = new Set(['quality', 'negative']) // hand-made lists, left alone
const MIN_SECTION = 3 // smaller sections are gathered into the page's "Diğer"

const best = new Map() // tag → { rank, key }, lowest rank wins, first seen on ties
for (const c of cats) {
  if (SKIP.has(c.id)) continue
  for (const p of c.pages)
    for (const s of p.sections)
      for (const t of s.tags) {
        const rank = (OVERVIEW.has(p.id) ? 2 : 0) + (MISC.test(s.title) ? 1 : 0)
        const cur = best.get(t)
        if (!cur || rank < cur.rank) best.set(t, { rank, key: `${c.id}/${p.id}/${s.title}` })
      }
}
let before = 0
let after = 0
let merged = 0
const placed = new Set()
for (const c of cats) {
  if (SKIP.has(c.id)) continue
  for (const p of c.pages) {
    const kept = []
    for (const s of p.sections) {
      before += s.tags.length
      const key = `${c.id}/${p.id}/${s.title}`
      const tags = s.tags.filter((t) => best.get(t).key === key && !placed.has(t) && placed.add(t))
      if (tags.length) kept.push({ title: s.title, tags })
    }
    const big = kept.filter((s) => s.tags.length >= MIN_SECTION)
    const small = kept.filter((s) => s.tags.length < MIN_SECTION)
    if (small.length && big.length) {
      merged += small.length
      big.push({ title: 'Diğer', tags: small.flatMap((s) => s.tags) })
      p.sections = big
    } else p.sections = kept
    after += p.sections.reduce((n, s) => n + s.tags.length, 0)
  }
  c.pages = c.pages.filter((p) => p.sections.length)
}

// --- Curated Yuri page ------------------------------------------------------
// Real Danbooru tags (checked 2026-11-13). A themed shortcut, so it
// deliberately repeats tags that also live elsewhere. Counts are fixed here;
// refresh them by hand if they matter.
const YURI = [
  ['Basics', ['yuri', '2girls', 'multiple girls']],
  ['Kissing', ['kiss', 'french kiss', 'kissing cheek', 'kissing neck', 'after kiss', 'saliva trail']],
  ['Affection', ['hug', 'hug from behind', 'holding hands', 'interlocked fingers', 'face-to-face', 'forehead-to-forehead', 'cuddling', 'spooning']],
  ['Body contact', ['breast press', 'symmetrical docking', 'girl on top', 'straddling', 'lying on person', "grabbing another's breast", 'groping', 'undressing another']],
  ['Sex acts', ['cunnilingus', 'fingering', 'tribadism', 'mutual masturbation', 'licking nipple', 'breast sucking', 'licking ear', '69']],
  ['Toys', ['strap-on', 'double dildo', 'dildo', 'vibrator', 'shared object insertion']],
  ['Details', ['blush', 'naughty face', 'sweat', 'trembling', 'pussy juice', 'pussy juice trail', 'female ejaculation', 'on bed', 'bed sheet']],
]
const YURI_COUNTS = {
  'yuri': 342696, '2girls': 1481364, 'multiple girls': 2172343, 'kiss': 100158, 'french kiss': 24602, 'kissing cheek': 11306,
  'kissing neck': 2141, 'after kiss': 7436, 'saliva trail': 29064, 'hug': 180095, 'hug from behind': 40102, 'holding hands': 150441,
  'interlocked fingers': 70650, 'face-to-face': 22498, 'forehead-to-forehead': 2889, 'cuddling': 6100, 'spooning': 3837,
  'breast press': 70738, 'symmetrical docking': 14274, 'girl on top': 94929, 'straddling': 100270, 'lying on person': 8302,
  "grabbing another's breast": 82447, 'groping': 136209, 'undressing another': 3609, 'cunnilingus': 17028, 'fingering': 48329,
  'tribadism': 5086, 'mutual masturbation': 1182, 'licking nipple': 4770, 'breast sucking': 18308, 'licking ear': 1648, '69': 3795,
  'strap-on': 3941, 'double dildo': 1498, 'dildo': 32931, 'vibrator': 33087, 'shared object insertion': 1226, 'blush': 4216146,
  'naughty face': 37016, 'sweat': 796908, 'trembling': 111630, 'pussy juice': 158575, 'pussy juice trail': 7444,
  'female ejaculation': 16901, 'on bed': 181609, 'bed sheet': 126811,
}
// Fresh counts from step 3 win where the tag is also elsewhere in the sheet.
for (const [t, n] of Object.entries(YURI_COUNTS)) if (!(t in counts)) counts[t] = n
cats.find((c) => c.id === 'nsfw').pages.unshift({ id: 'yuri', title: 'Yuri', sections: YURI.map(([title, tags]) => ({ title, tags })) })

// --- Write the TypeScript file ---------------------------------------------
const today = new Date().toISOString().slice(0, 10)
const used = new Set(cats.flatMap((c) => c.pages.flatMap((p) => p.sections.flatMap((s) => s.tags))))
const q = (s) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

const L = [
  `// Danbooru tag cheat sheet for the SDXL tab (see TagCheatSheet.tsx).
//
// GENERATED by scripts/danbooru/ (see its README) from Danbooru's own "tag
// group" wiki pages (https://danbooru.donmai.us/wiki_pages/tag_groups) on
// ${today} — not fetched at runtime. Hand edits are lost on the next
// regeneration; change the scripts instead. Structure is Danbooru's: each
// page below is one tag group wiki page, each section one of its headings,
// tags in the page's own order. Only general tags with 500+ posts that
// aren't deprecated are kept (aliased names resolved to their current tag);
// post counts are Danbooru's.
//
// De-duplicated: a tag Danbooru lists on several pages is kept once — on its
// most specific page (overview pages like Attire / Body parts and "Misc"/
// "More" sections give way). Sections left with fewer than 3 tags are
// gathered into a page's closing "Diğer" section. Exception: the curated
// 🔞 Yuri page, a themed shortcut that repeats tags from other pages.
//
// "Kalite" and "Negatif" aren't Danbooru tag groups: they're the quality/
// rating vocabulary Illustrious/NoobAI/Pony were trained with (carried over
// from the earlier hand-made sheet) and have no post counts.
//
// Adults only: tags/sections implying minors, non-consent, incest, gore or
// scat are left out (see the generator's blocklist), as is the BDSM-and-
// torture group.

export interface TagSection {
  title: string
  tags: string[]
}

export interface TagPage {
  id: string
  title: string
  sections: TagSection[]
}

export interface TagCategory {
  id: string
  label: string
  nsfw?: boolean
  // 'negative' → tapping a tag here edits the Negatif Prompt box instead of
  // the Prompt box.
  target?: 'negative'
  pages: TagPage[]
}

export const DANBOORU_TAG_CATEGORIES: TagCategory[] = [`,
]
for (const c of cats) {
  L.push(`  {\n    id: ${q(c.id)},\n    label: ${q(c.label)},` + (c.nsfw ? '\n    nsfw: true,' : '') + (c.target ? `\n    target: '${c.target}',` : '') + '\n    pages: [')
  for (const p of c.pages) {
    L.push(`      {\n        id: ${q(p.id)},\n        title: ${q(p.title)},\n        sections: [`)
    for (const s of p.sections) L.push(`          { title: ${q(s.title)}, tags: [${s.tags.map(q).join(', ')}] },`)
    L.push('        ],\n      },')
  }
  L.push('    ],\n  },')
}
L.push(']\n')
L.push("// Danbooru post count per tag (spaces, not underscores) — a rough sense of\n// how well a model knows it.\nexport const DANBOORU_TAG_POST_COUNTS: Record<string, number> = {")
for (const t of Object.keys(counts).filter((t) => used.has(t)).sort()) L.push(`  ${q(t)}: ${counts[t]},`)
L.push('}\n')
fs.writeFileSync(OUT, L.join('\n'))

console.log(`wrote ${path.relative(process.cwd(), OUT)}`)
console.log(`placed ${before} → ${after} after de-duplication (${best.size} unique); small sections merged into Diğer: ${merged}`)
for (const c of cats) console.log(' ', c.label.padEnd(12), c.pages.map((p) => `${p.title}(${p.sections.reduce((n, s) => n + s.tags.length, 0)})`).join(', '))
