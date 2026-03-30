
def log_info(msg):
    print(f"[INFO] {msg}")

def log_error(msg):
    print(f"[ERROR] {msg}")

def create_entry(level, msg):
    return {"level": level, "msg": msg}
