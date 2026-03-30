#include "lexer.h"
#include "parser.h"
#include <string.h>

void lex(const char* input) {
    parse(input);
}

Token next_token(const char* input) {
    Token t;
    t.type = 0;
    t.value = input;
    return t;
}

int is_keyword(const char* word) {
    return strcmp(word, "if") == 0 || strcmp(word, "else") == 0;
}
