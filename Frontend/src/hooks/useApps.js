import { useState, useCallback } from 'react';
import { getApps } from '../api/apps';

function useApps() {
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchApps = useCallback(async () => {
    try {
      const data = await getApps();
      setApps(Array.isArray(data) ? data : data.apps || []);
      setError(null);
    } catch (err) {
      setError(err?.response?.data?.error || err?.response?.data?.message || err.message || 'Failed to fetch apps');
    } finally {
      setLoading(false);
    }
  }, []);

  return { apps, setApps, loading, error, fetchApps };
}

export default useApps;
