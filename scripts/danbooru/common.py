# Shared bits for the Danbooru tag-sheet generator (see README.md).
import json, time, urllib.error, urllib.parse, urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
CACHE = HERE / 'cache'  # downloaded + intermediate files (gitignored)
CACHE.mkdir(exist_ok=True)

API = 'https://danbooru.donmai.us/'
UA = {'User-Agent': 'mobile-control-cheatsheet/1.0 (personal use, occasional fetch)'}


def get(path, params=None, tries=4):
    """GET a Danbooru JSON endpoint, retrying with back-off (rate limits)."""
    url = API + path + ('?' + urllib.parse.urlencode(params) if params else '')
    err = None
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise
            err = e
        except Exception as e:
            err = e
        time.sleep(3 * (attempt + 1))
    raise err


def load(name, default=None):
    p = CACHE / name
    return json.loads(p.read_text()) if p.exists() else default


def save(name, data):
    (CACHE / name).write_text(json.dumps(data, ensure_ascii=False, indent=1))
