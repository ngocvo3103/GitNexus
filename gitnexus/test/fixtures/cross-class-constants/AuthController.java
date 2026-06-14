package org.example.web;

import org.example.common.Constants;

/**
 * Controller that references constants from another class
 */
@RestController
@RequestMapping("/auth")
public class AuthController {
    // References CAPTCHA_GOOGLE_URL from Constants class
    public String captchaVerifyUrl = Constants.CAPTCHA_GOOGLE_URL;
    public String userServiceUrl = Constants.USER_SERVICE;
}
