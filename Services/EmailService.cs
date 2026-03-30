using System;

namespace Services
{
    public class EmailService
    {
        public void SendMail(string to, string body)
        {
        }

        public void SendBulk(string to, string body)
        {
        }

        public string FormatBody(string body)
        {
            return body;
        }

        public bool ValidateAddress(string addr)
        {
            return true;
        }
    }
}
