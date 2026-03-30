#include "math.h"
#include <cmath>

int clamp(int value, int min, int max) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
}

float lerp(float a, float b, float t) {
    return a + (b - a) * t;
}

double distance(double x1, double y1, double x2, double y2) {
    return std::sqrt((x2-x1)*(x2-x1) + (y2-y1)*(y2-y1));
}
