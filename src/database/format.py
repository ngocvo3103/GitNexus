
def format_result(data):
    return {**data, "formatted": True}

def serialize_result(data):
    import json
    return json.dumps(data)

def format_error(err):
    return {"error": str(err)}
