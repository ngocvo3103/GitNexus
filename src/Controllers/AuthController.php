<?php

function auth_login($username, $password) {
    validate_input($username);
    validate_input($password);
    $hash = auth_hash_password($password);
    return auth_create_token($username);
}

function auth_logout($token) {
    validate_input($token);
    return true;
}

function auth_register($username, $password) {
    validate_input($username);
    sanitize_input($username);
    $hash = auth_hash_password($password);
    return service_create($username, $hash);
}
