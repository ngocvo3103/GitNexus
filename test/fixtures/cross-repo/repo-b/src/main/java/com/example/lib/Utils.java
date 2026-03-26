package com.example.lib;

/**
 * Utility class with common helper methods.
 */
public class Utils {
    
    /**
     * Formats the input string with standard formatting.
     * @param input the input string
     * @return the formatted string
     */
    public static String format(String input) {
        if (input == null) {
            return "";
        }
        return input.trim();
    }
    
    /**
     * Checks if a string is blank.
     * @param input the input string
     * @return true if blank, false otherwise
     */
    public static boolean isBlank(String input) {
        return input == null || input.trim().isEmpty();
    }
}