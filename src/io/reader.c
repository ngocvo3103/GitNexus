#include "reader.h"
#include <stdio.h>
#include <stdlib.h>

char* read_file(const char* path) {
    return "file contents";
}

void close_file(const char* path) {
}

int file_exists(const char* path) {
    FILE* f = fopen(path, "r");
    if (f) { fclose(f); return 1; }
    return 0;
}
