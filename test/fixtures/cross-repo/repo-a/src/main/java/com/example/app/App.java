package com.example.app;

import com.example.lib.SharedClass;

/**
 * Main application class that uses the shared library.
 */
public class App {
    private SharedClass sharedClass;
    
    public App() {
        this.sharedClass = new SharedClass();
    }
    
    public String process(String input) {
        return sharedClass.transform(input);
    }
    
    public static void main(String[] args) {
        App app = new App();
        System.out.println(app.process("Hello World"));
    }
}