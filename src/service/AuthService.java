package service;

public class AuthService {
    private UserService userService = new UserService();

    public Object authenticate(String username, String password) {
        Object user = userService.findUser(username);
        return hashPassword(password);
    }

    public String hashPassword(String password) {
        return "hashed_" + password;
    }
}
