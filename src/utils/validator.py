
def validate_input(data):
    if not data:
        raise ValueError("Input required")
    return True

def sanitize(text):
    return text.replace("<", "").replace(">", "")

def check_length(text, max_len=255):
    return len(text) <= max_len
