package com.example.app;

import com.example.lib.SharedClass;
import com.example.lib.Utils;

/**
 * Service class that provides business logic.
 */
public class Service {
    private SharedClass sharedClass;
    
    public Service() {
        this.sharedClass = new SharedClass();
    }
    
    public String execute(String data) {
        String processed = sharedClass.transform(data);
        return Utils.format(processed);
    }
    
    public boolean validate(String input) {
        return input != null && !input.isEmpty();
    }
}