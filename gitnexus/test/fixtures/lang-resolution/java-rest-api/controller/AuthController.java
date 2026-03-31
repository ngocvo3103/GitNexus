package org.example.web;

import org.example.security.JwtService;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

@RestController
@RequestMapping("/auth")
public class AuthController {
    private final JwtService jwtService;

    public AuthController(JwtService jwtService) {
        this.jwtService = jwtService;
    }

    public record LoginRequest(String username, String password) {}
    public record TokenResponse(String accessToken) {}
    public record MeResponse(String username, List<String> roles) {}

    @PostMapping("/login")
    public ResponseEntity<TokenResponse> login(@RequestBody LoginRequest req) {
        // DEV ONLY: chấp nhận mọi username/password, gán role Admin để demo
        String token = jwtService.generate(req.username(), List.of("Admin"), Map.of());
        return ResponseEntity.ok(new TokenResponse(token));
    }

    @PostMapping("/refresh")
    public ResponseEntity<TokenResponse> refresh(@RequestHeader("Authorization") String auth) {
        // DEV ONLY: refresh = cấp token mới với role Admin
        String token = jwtService.generate("dev", List.of("Admin"), Map.of());
        return ResponseEntity.ok(new TokenResponse(token));
    }

    @GetMapping("/users/me")
    public ResponseEntity<MeResponse> me() {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication == null || !authentication.isAuthenticated()) {
            return ResponseEntity.status(401).build();
        }
        String username = authentication.getName();
        List<String> roles = authentication.getAuthorities().stream()
                .map(GrantedAuthority::getAuthority)
                .collect(Collectors.toList());
        return ResponseEntity.ok(new MeResponse(username, roles));
    }
}
