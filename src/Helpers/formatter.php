<?php

function format_response($data) {
    return ['status' => 200, 'body' => $data, 'formatted' => true];
}

function format_error($err) {
    return ['status' => 500, 'error' => $err];
}

function format_date($timestamp) {
    return date('Y-m-d', $timestamp);
}

function format_json($data) {
    return json_encode($data);
}
