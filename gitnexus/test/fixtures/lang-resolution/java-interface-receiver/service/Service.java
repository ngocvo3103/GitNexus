package service;

/**
 * Service interface with a common method name.
 * This tests D5 resolution: when receiver type is an interface,
 * find implementations via IMPLEMENTS edges.
 */
public interface Service {
    void process();
}