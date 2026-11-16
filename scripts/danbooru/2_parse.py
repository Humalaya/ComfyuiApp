# Step 2 — split each wiki page into its headings (h1–h6) and the tags linked
# under them ([[tag]] in list items / table cells). Writes cache/parsed.json
# ({page: [{title, tags}]}) and cache/alltags.json (every tag, for step 3).
import json, re
from common import CACHE, save
from importlib import import_module

PAGES = import_module('1_fetch_pages').PAGES

SKIP_SECTION = re.compile(r'^(related|see also|about|table of contents|notes?|external links|related tag groups|tag groups|see)\b', re.I)
LINK = re.compile(r'\[\[([^\]|]+)(?:\|[^\]]*)?\]\]')


def norm(t):
    return t.strip().lower().replace(' ', '_')


def parse(body):
    body = re.sub(r'\[expand=Table of Contents\].*?\[/expand\]', '', body, flags=re.S | re.I)
    sections, cur = [], None
    for line in body.splitlines():
        m = re.match(r'^h([1-6])(?:#[\w-]+)?\.\s*(.+?)\s*$', line.strip())
        if m:
            title = re.sub(r'\[\[(?:[^\]|]+\|)?([^\]]+)\]\]', r'\1', m.group(2)).strip().rstrip(':')
            cur = None if SKIP_SECTION.match(title) else {'title': title, 'tags': []}
            if cur:
                sections.append(cur)
            continue
        if cur is None:
            continue
        s = line.strip()
        if not (s.startswith('*') or '[td]' in s.lower()):
            continue
        for target in LINK.findall(s):
            t = norm(target)
            if t.startswith(('tag_group', 'list_of', 'tag_groups', 'help:', 'howto:', 'about:')) or '#' in t:
                continue
            if t not in cur['tags']:
                cur['tags'].append(t)
    return [s for s in sections if s['tags']]


if __name__ == '__main__':
    pages = {}
    for name in PAGES:
        f = CACHE / 'pages' / f'{name}.json'
        if not f.exists():
            raise SystemExit(f'missing {f} — run 1_fetch_pages.py first')
        pages[name] = parse(json.loads(f.read_text())['body'])
    alltags = sorted({t for secs in pages.values() for s in secs for t in s['tags']})
    save('parsed.json', pages)
    save('alltags.json', alltags)
    print('pages', len(pages), '| unique tags', len(alltags))
