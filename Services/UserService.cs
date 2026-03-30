using System;

namespace Services
{
    public class UserService
    {
        public object FindUser(string id)
        {
            return id;
        }

        public object CreateUser(string name)
        {
            return name;
        }

        public object UpdateUser(string id, string name)
        {
            return name;
        }

        public bool RemoveUser(string id)
        {
            return true;
        }
    }

    public class UserValidator
    {
        public bool ValidateUser(string input)
        {
            return true;
        }

        public string SanitizeUser(string input)
        {
            return input;
        }

        public bool CheckUserLength(string input)
        {
            return true;
        }
    }
}
