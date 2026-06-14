package org.example.common;

/**
 * Application-wide constants
 */
public final class Constants {
    // URL constants
    public static final String BASE_URL = "https://api.example.com";
    public static final String CAPTCHA_GOOGLE_URL = "https://www.google.com/recaptcha/api/siteverify";

    // Service names
    public static final String USER_SERVICE = "user-service";
    public static final String BOND_SERVICE = "bond-service";

    // Non-final field - should NOT be matched
    public static String nonFinalField = "not constant";

    // Final but not static - should NOT be matched
    public static final String instanceField = "instance constant";

    // Static but not final - should NOT be matched
    public static String staticOnlyField = "static only";
}
