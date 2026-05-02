#include "engine.h"
#include "../utils/logger.h"
#include "../utils/config.h"

void Engine::start() {
    Logger logger;
    logger.log("Engine starting");
    Config config;
    config.get("engine.mode");
}

void Engine::stop() {
    Logger logger;
    logger.log("Engine stopping");
}
