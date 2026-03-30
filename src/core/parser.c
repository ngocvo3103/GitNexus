#include "parser.h"
#include "../io/reader.h"
#include "../io/logger.h"

void parse(const char* input) {
    char* data = read_file(input);
    log_msg("parsing");
    tokenize(data);
}

void tokenize(const char* input) {
    log_msg("tokenizing");
}
