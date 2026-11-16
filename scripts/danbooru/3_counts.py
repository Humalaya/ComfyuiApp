# Step 3 — look every tag up on Danbooru: post count, category (0 = general)
# and deprecated flag → cache/taginfo.json ({tag: [posts, category,
# deprecated] | null}). Tags that don't exist / have 0 posts get their alias
# resolved → cache/aliases.json, and the alias targets are looked up too.
# Cached; delete cache/taginfo.json + aliases.json to refresh the counts.
import time
from common import get, load, save


def lookup(info, names):
    todo = [t for t in names if t not in info]
    for i in range(0, len(todo), 100):
        batch = todo[i:i + 100]
        params = {'search[name_comma]': ','.join(batch), 'only': 'name,post_count,category,is_deprecated', 'limit': 1000}
        for t in get('tags.json', params):
            info[t['name']] = [t['post_count'], t['category'], t['is_deprecated']]
        for t in batch:
            info.setdefault(t, None)
        print(f'  tags {i + len(batch)}/{len(todo)}', end='\r')
        time.sleep(1.0)


if __name__ == '__main__':
    tags = load('alltags.json')
    if tags is None:
        raise SystemExit('missing cache/alltags.json — run 2_parse.py first')
    info = load('taginfo.json', {})
    lookup(info, tags)
    found = sum(1 for v in info.values() if v)
    print(f'queried {len(info)} | found {found} | missing {len(info) - found}')

    dead = [k for k, v in info.items() if not v or v[0] == 0]
    aliases = load('aliases.json', {})
    todo = [t for t in dead if t not in aliases]
    for i in range(0, len(todo), 100):
        batch = todo[i:i + 100]
        params = {'search[antecedent_name_comma]': ','.join(batch), 'search[status]': 'active', 'only': 'antecedent_name,consequent_name', 'limit': 1000}
        for a in get('tag_aliases.json', params):
            aliases[a['antecedent_name']] = a['consequent_name']
        time.sleep(1.0)
    lookup(info, sorted(set(aliases.values())))
    save('taginfo.json', info)
    save('aliases.json', aliases)
    print('aliases resolved', len(aliases), 'of', len(dead), 'dead')
