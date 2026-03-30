using System;

namespace Data
{
    public class Logger
    {
        public void Info(string msg)
        {
        }

        public void Error(string msg)
        {
        }

        public void Warn(string msg)
        {
        }

        public void Debug(string msg)
        {
        }
    }

    public class LogFormatter
    {
        public string FormatEntry(string level, string msg)
        {
            return level + msg;
        }

        public string FormatTimestamp()
        {
            return "";
        }

        public string FormatStackTrace(string trace)
        {
            return trace;
        }
    }
}
