package service;

/**
 * Concrete implementation of Service interface.
 * The IMPLEMENTS edge (ServiceImpl -> Service) enables D5 resolution.
 */
public class ServiceImpl implements Service {
    @Override
    public void process() {
        System.out.println("processed");
    }
}