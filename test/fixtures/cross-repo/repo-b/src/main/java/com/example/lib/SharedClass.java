package com.example.lib;

/**
 * Shared class that provides common transformation functionality.
 */
public class SharedClass {
    
    /**
     * Transforms the input string to uppercase.
     * @param input the input string
     * @return the transformed string
     */
    public String transform(String input) {
        if (input == null) {
            return "";
        }
        return input.toUpperCase();
    }
    
    /**
     * Reverses the input string.
     * @param input the input string
     * @return the reversed string
     */
    public String reverse(String input) {
        if (input == null) {
            return "";
        }
        return new StringBuilder(input).reverse().toString();
    }
}