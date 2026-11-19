'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useGameStore } from '@/lib/store';

interface Report {
  id: string;
  reporterId: string | null;
  targetType: string;
  targetId: string;
  reason: string;
  status: string;
  createdAt: string;
}

interface ModerationStats {
  totalReports: number;
  pending: number;
  resolved: number;
  totalActions: number;
}

interface FeatureFlag {
  id: string;
  name: string;
  enabled: boolean;
  variant: string | null;
}

export default function AdminPage() {
  const router = useRouter();
  const token = useGameStore(s => s.token);
  const user = useGameStore(s => s.user);
  const [reports, setReports] = useState<Report[]>([]);
  const [stats, setStats] = useState<ModerationStats | null>(null);
  const [flags, setFlags] = useState<FeatureFlag[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'reports' | 'flags'>('reports');

  useEffect(() => {
    if (!token || !user) {
      setError('Please log in with an admin account to access this page.');
      setLoading(false);
      return;
    }
    const headers: HeadersInit = {
      Authorization: `Bearer ${token}`,
    };
    Promise.all([
      fetch('/api/moderation/reports', { headers }).then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }),
      fetch('/api/moderation/stats', { headers }).then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }),
      fetch('/api/flags', { headers }).then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      }),
    ])
      .then(([r, s, f]) => {
        setReports(r);
        setStats(s);
        setFlags(f);
        setLoading(false);
      })
      .catch(err => {
        setError(`Access denied: ${err.message}. Admin privileges required.`);
        setLoading(false);
      });
  }, [token, user]);

  async function updateReport(id: string, status: string, action?: string) {
    if (!token) return;
    try {
      const res = await fetch(`/api/moderation/reports/${id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ status, action }),
      });
      if (!res.ok) {
        setError(`Failed to update report: HTTP ${res.status}`);
        return;
      }
      setReports(prev => prev.map(r => (r.id === id ? { ...r, status } : r)));
      setStats(prev =>
        prev
          ? {
              ...prev,
              pending: prev.pending + (status === 'RESOLVED' ? -1 : 0),
              resolved: prev.resolved + (status === 'RESOLVED' ? 1 : 0),
            }
          : prev,
      );
    } catch {
      setError('Network error updating report');
    }
  }

  async function toggleFlag(name: string, enabled: boolean) {
    if (!token) return;
    try {
      const res = await fetch('/api/flags', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ name, enabled: !enabled }),
      });
      if (res.ok) {
        setFlags(prev => prev.map(f => (f.name === name ? { ...f, enabled: !enabled } : f)));
      } else {
        setError(`Failed to toggle flag: HTTP ${res.status}`);
      }
    } catch {
      setError('Network error toggling flag');
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-muted-foreground">Loading admin panel...</p>
      </div>
    );
  }

  if (error && reports.length === 0 && flags.length === 0) {
    return (
      <main className="min-h-screen bg-gradient-to-br from-slate-50 to-gray-100 p-4 md:p-8 flex items-center justify-center">
        <Card className="max-w-md">
          <CardContent className="pt-6 text-center space-y-4">
            <p className="text-destructive font-medium">{error}</p>
            <Link href="/">
              <Button variant="outline">← Home</Button>
            </Link>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-50 to-gray-100 p-4 md:p-8">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-3xl font-bold">Admin Panel</h1>
          <Link href="/">
            <Button variant="outline">← Home</Button>
          </Link>
        </div>

        {error && (
          <div className="p-3 rounded-lg bg-destructive/10 text-destructive text-sm">{error}</div>
        )}

        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card>
              <CardContent className="pt-6 text-center">
                <p className="text-3xl font-bold text-primary">{stats.totalReports}</p>
                <p className="text-sm text-muted-foreground">Total Reports</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6 text-center">
                <p className="text-3xl font-bold text-orange-500">{stats.pending}</p>
                <p className="text-sm text-muted-foreground">Pending</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6 text-center">
                <p className="text-3xl font-bold text-green-600">{stats.resolved}</p>
                <p className="text-sm text-muted-foreground">Resolved</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="pt-6 text-center">
                <p className="text-3xl font-bold">{stats.totalActions}</p>
                <p className="text-sm text-muted-foreground">Actions Taken</p>
              </CardContent>
            </Card>
          </div>
        )}

        <div className="flex gap-2">
          <Button variant={tab === 'reports' ? 'default' : 'outline'} onClick={() => setTab('reports')}>
            Reports ({reports.length})
          </Button>
          <Button variant={tab === 'flags' ? 'default' : 'outline'} onClick={() => setTab('flags')}>
            Feature Flags ({flags.length})
          </Button>
        </div>

        {tab === 'reports' && (
          <Card>
            <CardHeader>
              <CardTitle>Content Reports</CardTitle>
            </CardHeader>
            <CardContent>
              {reports.length === 0 ? (
                <p className="text-center text-muted-foreground py-8">No reports yet</p>
              ) : (
                <div className="space-y-3">
                  {reports.map(r => (
                    <div key={r.id} className="flex items-start justify-between p-3 rounded-lg bg-secondary/30 gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <Badge variant={r.status === 'PENDING' ? 'destructive' : 'secondary'}>
                            {r.status}
                          </Badge>
                          <Badge variant="outline">{r.targetType}</Badge>
                          <span className="text-xs text-muted-foreground">
                            {new Date(r.createdAt).toLocaleString()}
                          </span>
                        </div>
                        <p className="text-sm truncate">{r.reason}</p>
                        <p className="text-xs text-muted-foreground">Target: {r.targetId}</p>
                      </div>
                      <div className="flex gap-1 shrink-0">
                        {r.status === 'PENDING' && (
                          <>
                            <Button size="sm" variant="outline" onClick={() => updateReport(r.id, 'RESOLVED', 'dismiss')}>
                              Dismiss
                            </Button>
                            <Button size="sm" variant="destructive" onClick={() => updateReport(r.id, 'RESOLVED', 'remove')}>
                              Remove
                            </Button>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {tab === 'flags' && (
          <Card>
            <CardHeader>
              <CardTitle>Feature Flags (A/B Testing)</CardTitle>
            </CardHeader>
            <CardContent>
              {flags.length === 0 ? (
                <p className="text-center text-muted-foreground py-8">No feature flags configured</p>
              ) : (
                <div className="space-y-2">
                  {flags.map(f => (
                    <div key={f.id} className="flex items-center justify-between p-3 rounded-lg bg-secondary/30">
                      <div>
                        <p className="font-medium">{f.name}</p>
                        {f.variant && <p className="text-xs text-muted-foreground">Variant: {f.variant}</p>}
                      </div>
                      <div className="flex items-center gap-3">
                        <Badge variant={f.enabled ? 'default' : 'secondary'}>
                          {f.enabled ? 'ON' : 'OFF'}
                        </Badge>
                        <Button size="sm" variant="outline" onClick={() => toggleFlag(f.name, f.enabled)}>
                          Toggle
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </main>
  );
}
