<?php

function log_request($msg) {
    echo '[REQ] ' . $msg . "\n";
}

function log_error($msg) {
    echo '[ERR] ' . $msg . "\n";
}

function log_info($msg) {
    echo '[INFO] ' . $msg . "\n";
}

function create_log_entry($level, $msg) {
    return ['level' => $level, 'msg' => $msg, 'ts' => time()];
}
