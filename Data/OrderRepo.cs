using System;

namespace Data
{
    public class OrderRepo
    {
        public object FindOrder(string id)
        {
            return id;
        }

        public object InsertOrder(string item)
        {
            return item;
        }

        public bool RemoveOrder(string id)
        {
            return true;
        }

        public object UpdateOrder(string id, string data)
        {
            return data;
        }

        public int CountOrders()
        {
            return 0;
        }
    }
}
