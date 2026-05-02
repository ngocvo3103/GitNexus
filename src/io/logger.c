#include "logger.h"
#include <stdio.h>

void log_msg(const char* msg) {
    printf("[LOG] %s\n", msg);
}

void log_error(const char* msg) {
    fprintf(stderr, "[ERR] %s\n", msg);
}

void log_init(void) {
    log_msg("logger initialized");
}
