#ifndef LOGGER_H
#define LOGGER_H

#include <string>

class Logger {
public:
    void log(const std::string& msg);
    void error(const std::string& msg);
    void flush();
};

#endif
