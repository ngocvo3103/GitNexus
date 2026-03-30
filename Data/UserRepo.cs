using System;

namespace Data
{
    public class UserRepo
    {
        public object GetById(string id)
        {
            return id;
        }

        public object Save(string name)
        {
            return name;
        }

        public object Update(string id, string name)
        {
            return name;
        }

        public bool Delete(string id)
        {
            return true;
        }

        public object[] ListAll()
        {
            return new object[0];
        }
    }
}
