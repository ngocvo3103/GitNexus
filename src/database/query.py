
from src.database.format import format_result
from src.database.cache import get_cached

def run_query(sql):
    cached = get_cached(sql)
    if cached:
        return cached
    return format_result({"sql": sql, "rows": []})

def build_query(table, conditions):
    return f"SELECT * FROM {table}"
