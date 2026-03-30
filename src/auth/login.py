
from src.auth.hash import hash_password
from src.auth.session import create_session

def login(username, password):
    hashed = hash_password(password)
    session = create_session(username)
    return session

def validate_credentials(username, password):
    if not username or not password:
        raise ValueError("Invalid credentials")
    return True
