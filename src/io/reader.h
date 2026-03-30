#ifndef READER_H
#define READER_H

char* read_file(const char* path);
void close_file(const char* path);
int file_exists(const char* path);

#endif
