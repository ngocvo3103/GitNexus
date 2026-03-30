#include "ast.h"
#include "lexer.h"
#include <stdlib.h>

ASTNode* create_node(int type) {
    ASTNode* node = (ASTNode*)malloc(sizeof(ASTNode));
    node->type = type;
    node->left = NULL;
    node->right = NULL;
    tokenize("ast");
    return node;
}

void free_node(ASTNode* node) {
    if (node) {
        free_node(node->left);
        free_node(node->right);
        free(node);
    }
}
