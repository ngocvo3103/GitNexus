#ifndef CONFIG_H
#define CONFIG_H

#include <string>

class Config {
public:
    std::string get(const std::string& key);
    void set(const std::string& key, const std::string& value);
    void load(const std::string& path);
};

#endif
