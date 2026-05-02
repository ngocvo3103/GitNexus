using System;

namespace Services
{
    public class OrderService
    {
        public object CreateOrder(string item)
        {
            return item;
        }

        public object GetOrder(string id)
        {
            return id;
        }

        public bool CancelOrder(string id)
        {
            return true;
        }

        public object UpdateOrder(string id, string item)
        {
            return item;
        }
    }

    public class OrderValidator
    {
        public bool ValidateOrder(string input)
        {
            return true;
        }

        public string SanitizeOrder(string input)
        {
            return input;
        }
    }
}
