<?php

function validate_input($input) {
    if (empty($input)) {
        throw new InvalidArgumentException('Invalid');
    }
    return true;
}

function sanitize_input($input) {
    return htmlspecialchars($input);
}

function check_required($data, $fields) {
    foreach ($fields as $field) {
        if (!isset($data[$field])) return false;
    }
    return true;
}

function check_length($input, $max = 255) {
    return strlen($input) <= $max;
}
