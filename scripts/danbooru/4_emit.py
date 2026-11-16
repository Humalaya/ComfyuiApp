# Step 4 — filter and arrange
import re
from common import load, save
MIN_POSTS = 500

# DISABLED — set to empty so no section is ever skipped
SKIP_SECTIONS = set()

# DISABLED — regex that can never match, so no tag is ever blocked
BLOCK = re.compile(r'(?!)')  # always returns None from .search()

# (id, label, nsfw, [wiki pages from 1_fetch_pages.PAGES])
CATEGORIES = [
    ('composition', 'Kompozisyon', False, ['image composition', 'focus tags', 'character count', 'lighting', 'backgrounds', 'visual aesthetic']),
    ('hair', 'Saç', False, ['hair styles', 'hair color']),
    ('face', 'Yüz', False, ['face tags', 'eyes tags', 'ears tags', 'makeup']),
    ('body', 'Vücut', False, ['body parts', 'breasts tags', 'ass', 'skin color', 'hands', 'feet', 'shoulders', 'wings']),
    ('pose', 'Poz', False, ['posture', 'gestures', 'holding tags']),
    ('attire', 'Kıyafet', False, ['attire', 'headwear', 'handwear', 'legwear', 'sleeves', 'neck and neckwear', 'eyewear', 'accessories', 'fashion style']),
    ('location', 'Mekan', False, ['locations']),
    ('nsfw', '🔞 NSFW', True, ['nudity', 'covering', 'sexual attire', 'sex acts', 'sexual positions', 'sex objects', 'pussy']),
]
PAGE_TITLES = {'breasts tags': 'Breasts', 'eyes tags': 'Eyes', 'ears tags': 'Ears', 'face tags': 'Face', 'holding tags': 'Holding', 'focus tags': 'Focus'}

QUALITY = ['masterpiece', 'best quality', 'amazing quality', 'very aesthetic', 'newest', 'year 2024', 'year 2025',
           'general', 'sensitive', 'nsfw', 'explicit', 'highres', 'absurdres']
NEGATIVE = ['worst quality', 'low quality', 'normal quality', 'monochrome', 'greyscale', 'censored', 'artist name',
            'speech bubble', 'signature', 'english text', 'blurry', 'mosaic censoring', 'multiple views', 'watermark',
            'lowres', 'logo', 'out of frame', 'realistic', '3d', 'jpeg artifacts', 'bad anatomy', 'cropped', 'deformed',
            'fewer digits', 'bad hands', 'bad proportions', 'extra digits', 'username']

def single(cid, label, tags, target=None):
    c = {'id': cid, 'label': label, 'pages': [{'id': cid, 'title': label, 'sections': [{'title': label, 'tags': tags}]}]}
    if target:
        c['target'] = target
    return c

if __name__ == '__main__':
    parsed, info, aliases = load('parsed.json'), load('taginfo.json'), load('aliases.json', {})
    if parsed is None or info is None:
        raise SystemExit('missing cache files — run steps 1–3 first')

    def resolve(t):
        v = info.get(t)
        if (not v or v[0] == 0) and t in aliases:
            t = aliases[t]
            v = info.get(t)
        return t, v

    counts, categories, total = {}, [single('quality', 'Kalite', QUALITY)], 0
    for cid, label, nsfw, names in CATEGORIES:
        pages = []
        for name in names:
            sections = []
            for s in parsed[name]:
                if s['title'] in SKIP_SECTIONS:   # ← never true now (empty set)
                    continue
                tags = []
                for raw in s['tags']:
                    t, v = resolve(raw)
                    if not v or v[1] != 0 or v[2] or v[0] < MIN_POSTS or BLOCK.search(t):
                        continue
                    shown = t.replace('_', ' ')
                    if shown not in tags:
                        tags.append(shown)
                        counts[shown] = v[0]
                if tags:
                    sections.append({'title': s['title'], 'tags': tags})
            if sections:
                pages.append({'id': name.replace(' ', '-'), 'title': PAGE_TITLES.get(name, name[0].upper() + name[1:]), 'sections': sections})
                total += sum(len(s['tags']) for s in sections)
        cat = {'id': cid, 'label': label, 'pages': pages}
        if nsfw:
            cat['nsfw'] = True
        categories.append(cat)

    categories.append(single('negative', 'Negatif', NEGATIVE, 'negative'))
    save('emitted.json', {'categories': categories, 'counts': counts})
    print('tags placed', total, '| unique', len(counts))
