#include "logger.h"
#include <iostream>

void Logger::log(const std::string& msg) {
    std::cout << "[LOG] " << msg << std::endl;
}

void Logger::error(const std::string& msg) {
    std::cerr << "[ERR] " << msg << std::endl;
}

void Logger::flush() {
    std::cout.flush();
}
