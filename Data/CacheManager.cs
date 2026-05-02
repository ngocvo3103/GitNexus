using System;

namespace Data
{
    public class CacheManager
    {
        public object GetCached(string key)
        {
            return key;
        }

        public void SetCached(string key, object val)
        {
        }

        public void Invalidate(string key)
        {
        }

        public void Clear()
        {
        }
    }

    public class CacheStats
    {
        public int GetHitCount()
        {
            return 0;
        }

        public int GetMissCount()
        {
            return 0;
        }

        public double GetHitRate()
        {
            return 0.0;
        }
    }
}
