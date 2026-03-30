#include "physics.h"
#include "engine.h"
#include "../utils/logger.h"

void simulate() {
    Engine engine;
    engine.stop();
    Logger logger;
    logger.log("simulating");
}

void collide() {
    Logger logger;
    logger.log("collision detected");
}
