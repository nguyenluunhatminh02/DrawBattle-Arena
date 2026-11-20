'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useGameStore } from '@/lib/store';
import { AppShell } from '@/components/layout/AppShell';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

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

/** Map raw HTTP/network failures to friendly Vietnamese messages. */
function describeHttpError(status: number | null): string {
  if (status === null) return 'Không thể kết nối đến máy chủ. Vui lòng kiểm tra đường truyền.';
  switch (status) {
    case 400: return 'Yêu cầu không hợp lệ. Vui lòng thử lại.';
    case 401: return 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.';
    case 403: return 'Bạn không có quyền quản trị để thực hiện thao tác này.';
    case 404: return 'Không tìm thấy dữ liệu yêu cầu.';
    case 409: return 'Dữ liệu đã thay đổi. Vui lòng tải lại trang.';
    case 429: return 'Quá nhiều yêu cầu. Vui lòng đợi một lát rồi thử lại.';
    default: return `Máy chủ gặp sự cố (mã ${status}). Vui lòng thử lại sau.`;
  }
}

const STATUS_LABELS: Record<string, string> = {
  PENDING: 'Chờ xử lý',
  RESOLVED: 'Đã xử lý',
  DISMISSED: 'Đã bỏ qua',
  REJECTED: 'Đã từ chối',
};

export default function AdminPage() {
  const token = useGameStore(s => s.token);
  const user = useGameStore(s => s.user);
  const [reports, setReports] = useState<Report[]>([]);
  const [stats, setStats] = useState<ModerationStats | null>(null);
  const [flags, setFlags] = useState<FeatureFlag[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyReportId, setBusyReportId] = useState<string | null>(null);
  const [busyFlagName, setBusyFlagName] = useState<string | null>(null);
  const [tab, setTab] = useState<'reports' | 'flags'>('reports');

  useEffect(() => {
    if (!token || !user) {
      setError('Vui lòng đăng nhập bằng tài khoản quản trị để truy cập trang này.');
      setLoading(false);
      return;
    }
    const headers: HeadersInit = {
      Authorization: `Bearer ${token}`,
    };
    async function loadStatus(res: Response) {
      if (!res.ok) throw new Error(describeHttpError(res.status));
      return res.json();
    }
    Promise.all([
      fetch('/api/moderation/reports', { headers }).then(loadStatus),
      fetch('/api/moderation/stats', { headers }).then(loadStatus),
      fetch('/api/flags', { headers }).then(loadStatus),
    ])
      .then(([r, s, f]) => {
        setReports(r);
        setStats(s);
        setFlags(f);
        setLoading(false);
      })
      .catch(err => {
        setError(err instanceof Error ? err.message : describeHttpError(null));
        setLoading(false);
      });
  }, [token, user]);

  async function updateReport(id: string, status: string, action?: string) {
    if (!token) return;
    setBusyReportId(id);
    setError('');
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
        setError(describeHttpError(res.status));
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
      setError(describeHttpError(null));
    } finally {
      setBusyReportId(null);
    }
  }

  async function toggleFlag(name: string, enabled: boolean) {
    if (!token) return;
    setBusyFlagName(name);
    setError('');
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
        setError(describeHttpError(res.status));
      }
    } catch {
      setError(describeHttpError(null));
    } finally {
      setBusyFlagName(null);
    }
  }

  return (
    <AppShell variant="arena">
      <PageHeader
        title="Bảng điều khiển quản trị"
        subtitle="Quản lý báo cáo và tính năng thử nghiệm"
        actions={
          <Button asChild variant="outline" size="sm">
            <Link href="/">← Về trang chủ</Link>
          </Button>
        }
      />

      <main className="mx-auto w-full max-w-4xl space-y-5 px-4 py-6 safe-bottom">
        {error && (
          <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        {loading ? (
          <div className="panel-arena rounded-2xl px-6 py-12 text-center shadow-panel">
            <p className="text-muted-on-arena">Đang tải bảng điều khiển...</p>
          </div>
        ) : (
          <>
            {stats && (
              <section className="grid grid-cols-2 gap-3 md:grid-cols-4" aria-label="Thống kê kiểm duyệt">
                {[
                  { label: 'Tổng báo cáo', value: stats.totalReports, tone: 'text-on-arena' },
                  { label: 'Chờ xử lý', value: stats.pending, tone: 'text-warning' },
                  { label: 'Đã xử lý', value: stats.resolved, tone: 'text-success' },
                  { label: 'Hành động đã thực hiện', value: stats.totalActions, tone: 'text-on-arena' },
                ].map(item => (
                  <div key={item.label} className="panel-arena rounded-2xl px-4 py-4 text-center shadow-panel">
                    <p className={`score-number text-3xl font-bold ${item.tone}`}>{item.value}</p>
                    <p className="mt-1 text-xs text-muted-on-arena">{item.label}</p>
                  </div>
                ))}
              </section>
            )}

            <div className="flex gap-2" role="tablist" aria-label="Chọn nội dung quản trị">
              <Button
                type="button"
                role="tab"
                aria-selected={tab === 'reports'}
                variant={tab === 'reports' ? 'default' : 'outline'}
                onClick={() => setTab('reports')}
                className="h-11 flex-1"
              >
                Báo cáo ({reports.length})
              </Button>
              <Button
                type="button"
                role="tab"
                aria-selected={tab === 'flags'}
                variant={tab === 'flags' ? 'default' : 'outline'}
                onClick={() => setTab('flags')}
                className="h-11 flex-1"
              >
                Tính năng thử nghiệm ({flags.length})
              </Button>
            </div>

            {tab === 'reports' ? (
              <section className="panel-arena rounded-2xl p-5 shadow-panel" role="tabpanel">
                <h2 className="text-lg font-bold text-on-arena">Báo cáo nội dung</h2>
                {reports.length === 0 ? (
                  <p className="py-10 text-center text-sm text-muted-on-arena">Chưa có báo cáo nào.</p>
                ) : (
                  <div className="mt-4 space-y-3">
                    {reports.map(r => (
                      <div
                        key={r.id}
                        className="rounded-xl bg-panel/60 p-3"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant={r.status === 'PENDING' ? 'destructive' : 'secondary'}>
                            {STATUS_LABELS[r.status] ?? r.status}
                          </Badge>
                          <Badge variant="outline" className="border-panel-border/50 text-on-arena">
                            {r.targetType}
                          </Badge>
                          <span className="text-xs text-muted-on-arena">
                            {new Date(r.createdAt).toLocaleString('vi-VN')}
                          </span>
                        </div>
                        <p className="mt-2 break-words text-sm text-on-arena">{r.reason}</p>
                        <p className="mt-1 text-xs text-muted-on-arena">Đối tượng: {r.targetId}</p>
                        {r.status === 'PENDING' && (
                          <div className="mt-3 flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busyReportId === r.id}
                              onClick={() => {
                                if (confirm('Bỏ qua báo cáo này?')) {
                                  void updateReport(r.id, 'RESOLVED', 'dismiss');
                                }
                              }}
                            >
                              Bỏ qua
                            </Button>
                            <Button
                              size="sm"
                              variant="destructive"
                              disabled={busyReportId === r.id}
                              onClick={() => {
                                if (confirm('Xóa nội dung bị báo cáo? Hành động này không thể hoàn tác.')) {
                                  void updateReport(r.id, 'RESOLVED', 'remove');
                                }
                              }}
                            >
                              Xóa nội dung
                            </Button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            ) : (
              <section className="panel-arena rounded-2xl p-5 shadow-panel" role="tabpanel">
                <h2 className="text-lg font-bold text-on-arena">Tính năng thử nghiệm</h2>
                {flags.length === 0 ? (
                  <p className="py-10 text-center text-sm text-muted-on-arena">
                    Chưa có tính năng thử nghiệm nào được cấu hình.
                  </p>
                ) : (
                  <div className="mt-4 space-y-3">
                    {flags.map(f => (
                      <div
                        key={f.id}
                        className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-panel/60 p-3"
                      >
                        <div className="min-w-0">
                          <p className="font-medium text-on-arena">{f.name}</p>
                          {f.variant && (
                            <p className="text-xs text-muted-on-arena">Phiên bản: {f.variant}</p>
                          )}
                        </div>
                        <div className="flex items-center gap-3">
                          <Badge variant={f.enabled ? 'default' : 'secondary'}>
                            {f.enabled ? 'BẬT' : 'TẮT'}
                          </Badge>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busyFlagName === f.name}
                            onClick={() => toggleFlag(f.name, f.enabled)}
                          >
                            Đổi trạng thái
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            )}

            <Button asChild variant="outline" className="h-12 w-full">
              <Link href="/">← Về trang chủ</Link>
            </Button>
          </>
        )}
      </main>
    </AppShell>
  );
}
