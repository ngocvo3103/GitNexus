<?php

function api_handle_request($method, $path) {
    validate_input($method);
    validate_input($path);
    log_request($method . ' ' . $path);
    return format_response(['method' => $method, 'path' => $path]);
}

function api_handle_error($error) {
    log_error($error);
    return format_error($error);
}

function api_middleware($request) {
    validate_input($request);
    log_request('middleware');
    return true;
}
