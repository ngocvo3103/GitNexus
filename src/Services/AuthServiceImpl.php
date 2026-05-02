<?php

function auth_hash_password($password) {
    validate_input($password);
    return 'hashed_' . $password;
}

function auth_create_token($username) {
    validate_input($username);
    log_request('token created for ' . $username);
    return 'token_' . $username;
}

function auth_verify_token($token) {
    validate_input($token);
    return strpos($token, 'token_') === 0;
}

function auth_refresh_token($token) {
    auth_verify_token($token);
    return auth_create_token('refreshed');
}
