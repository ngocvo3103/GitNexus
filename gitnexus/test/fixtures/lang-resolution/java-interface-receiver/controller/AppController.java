package controller;

import service.Service;

/**
 * Controller with interface-typed field.
 *
 * This tests the bug fix: CALLS relationship should be created
 * from execute() -> process() even though:
 * 1. 'service' field has interface type 'Service'
 * 2. 'process' method name is common (many implementations)
 *
 * D5 resolution finds ServiceImpl via IMPLEMENTS edge and filters
 * method candidates to those owned by implementers.
 */
public class AppController {
    private final Service service;

    public AppController(Service service) {
        this.service = service;
    }

    public void execute() {
        service.process();
    }
}