<?php

function controller_index() {
    validate_input('list');
    $users = service_find_all();
    return format_response($users);
}

function controller_store($data) {
    validate_input($data);
    sanitize_input($data);
    $user = service_find_by_id($data);
    return format_response($user);
}

function controller_update($id, $data) {
    validate_input($id);
    validate_input($data);
    $result = service_update($id, $data);
    return format_response($result);
}

function controller_delete($id) {
    validate_input($id);
    return service_delete($id);
}
