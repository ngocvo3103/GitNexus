<?php

function service_find_all() {
    $result = db_query('SELECT * FROM users');
    return format_response($result);
}

function service_find_by_id($id) {
    $result = db_query('SELECT * FROM users WHERE id = ' . $id);
    return format_response($result);
}

function service_create($name, $hash) {
    db_execute('INSERT INTO users VALUES (' . $name . ')');
    log_request('user created');
    return true;
}

function service_update($id, $data) {
    db_execute('UPDATE users SET data = ' . $data);
    log_request('user updated');
    return true;
}

function service_delete($id) {
    db_execute('DELETE FROM users WHERE id = ' . $id);
    log_request('user deleted');
    return true;
}
