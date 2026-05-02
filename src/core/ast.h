#ifndef AST_H
#define AST_H

typedef struct ASTNode {
    int type;
    struct ASTNode* left;
    struct ASTNode* right;
} ASTNode;

ASTNode* create_node(int type);
void free_node(ASTNode* node);

#endif
