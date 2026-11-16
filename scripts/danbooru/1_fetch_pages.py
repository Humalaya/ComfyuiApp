# Step 1 — download Danbooru's "tag group" wiki pages (DText source) into
# cache/pages/. Already-downloaded pages are skipped; delete cache/ (or pass
# --refresh) to fetch them again.
import json, sys, time, urllib.parse
from common import CACHE, get

# Which tag_group:* wiki pages to use. The category each one lands in is set
# in 4_emit.py (CATEGORIES). Index of all groups:
# https://danbooru.donmai.us/wiki_pages/tag_groups
PAGES = [
    'image composition', 'focus tags', 'character count', 'lighting', 'backgrounds', 'visual aesthetic',
    'hair color', 'hair styles', 'face tags', 'eyes tags', 'ears tags', 'makeup',
    'body parts', 'breasts tags', 'ass', 'skin color', 'hands', 'feet', 'shoulders', 'wings',
    'posture', 'gestures', 'holding tags',
    'attire', 'headwear', 'handwear', 'legwear', 'sleeves', 'neck and neckwear', 'eyewear', 'accessories', 'fashion style',
    'locations',
    'nudity', 'covering', 'sexual attire', 'sex acts', 'sexual positions', 'sex objects', 'pussy',
]

if __name__ == '__main__':
    refresh = '--refresh' in sys.argv
    out_dir = CACHE / 'pages'
    out_dir.mkdir(exist_ok=True)
    for name in PAGES:
        out = out_dir / f'{name}.json'
        if out.exists() and not refresh:
            continue
        title = 'tag_group:' + name.replace(' ', '_')
        try:
            data = get('wiki_pages/' + urllib.parse.quote(title) + '.json')
            out.write_text(json.dumps(data, ensure_ascii=False))
            print(f"{name:22} {len(data.get('body', '')):6} chars")
        except Exception as e:
            print(f'{name:22} FAILED {e}')
        time.sleep(1.1)
