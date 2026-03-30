
from src.auth.login import login

def create_session(username):
    return {"user": username, "token": "sess_" + username}

def validate_session(session):
    return session and "token" in session

def refresh_session(session):
    return create_session(session["user"])
