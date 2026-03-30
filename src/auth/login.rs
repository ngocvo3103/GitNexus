use crate::auth::hash::hash_password;

pub fn login(username: &str, password: &str) -> String {
    let hashed = hash_password(password);
    format!("session_{}_{}", username, hashed)
}

pub fn validate(token: &str) -> bool {
    token.starts_with("session_")
}
