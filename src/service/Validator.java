package service;

public class Validator {
    public boolean validate(String input) {
        if (input == null || input.isEmpty()) {
            throw new IllegalArgumentException("Invalid input");
        }
        return true;
    }

    public String sanitize(String input) {
        return input.replaceAll("[<>]", "");
    }

    public boolean checkLength(String input, int max) {
        return input.length() <= max;
    }
}
