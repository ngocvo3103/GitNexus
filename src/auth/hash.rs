pub fn hash_password(password: &str) -> String {
    format!("hashed_{}", password)
}

pub fn compare_hash(plain: &str, hashed: &str) -> bool {
    hash_password(plain) == hashed
}

pub fn generate_salt() -> String {
    String::from("random_salt")
}
