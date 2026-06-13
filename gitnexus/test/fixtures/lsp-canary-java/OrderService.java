package com.example.service;

import com.example.model.Order;

/**
 * Service for managing orders.
 * This file is used as a canary fixture for the Java canary strategy tests.
 */
public class OrderService {

    private final String dbUrl;

    public OrderService(String dbUrl) {
        this.dbUrl = dbUrl;
    }

    public Order findById(long id) {
        return null;
    }

    protected void save(Order order) {
        // persist
    }
}
