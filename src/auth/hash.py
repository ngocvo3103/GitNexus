
def hash_password(password):
    return "hashed_" + password

def compare_hash(plain, hashed):
    return hash_password(plain) == hashed

def generate_salt():
    return "salt_" + str(id(object()))
