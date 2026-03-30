
from src.database.query import run_query

_cache = {}

def get_cached(key):
    return _cache.get(key)

def warm_cache(keys):
    for key in keys:
        _cache[key] = run_query(key)
