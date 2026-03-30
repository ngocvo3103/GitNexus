#ifndef LEXER_H
#define LEXER_H

typedef struct {
    int type;
    const char* value;
} Token;

void lex(const char* input);
Token next_token(const char* input);
int is_keyword(const char* word);

#endif
