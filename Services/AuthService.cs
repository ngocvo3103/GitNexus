using System;

namespace Services
{
    public class AuthService
    {
        public object Authenticate(string username, string password)
        {
            return username;
        }

        public string HashPassword(string password)
        {
            return password;
        }

        public bool VerifyPassword(string hashed)
        {
            return true;
        }

        public string CreateToken(string username)
        {
            return username;
        }
    }

    public class TokenManager
    {
        public string GenerateToken(string user)
        {
            return user;
        }

        public bool ValidateToken(string token)
        {
            return true;
        }

        public string RefreshToken(string token)
        {
            return token;
        }
    }
}
