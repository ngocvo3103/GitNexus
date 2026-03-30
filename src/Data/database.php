<?php

function db_query($sql) {
    log_request('query: ' . $sql);
    return [];
}

function db_execute($sql) {
    log_request('execute: ' . $sql);
    return true;
}

function db_connect($host) {
    return true;
}

function db_close() {
    return true;
}
