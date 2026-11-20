'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { AppShell } from '@/components/layout/AppShell';
import { useGameStore } from '@/lib/store';
import { api } from '@/lib/api';
import { WORD_CATEGORIES, GAME_MODE_LABELS, getModeConfig } from '@drawbattle/shared';
import type { GameMode } from '@drawbattle/shared';

type Difficulty = 'EASY' | 'MEDIUM' | 'HARD' | 'MIXED';

const GAME_MODES: GameMode[] = ['CLASSIC', 'SPEED', 'DUEL', 'TEAM'];

interface RoomSettingsForm {
  mode: GameMode;
  maxPlayers: number;
  rounds: number;
  turnDuration: number;
  difficulty: Difficulty;
  category: string;
  enableHints: boolean;
  password: string;
}

const DEFAULT_SETTINGS: RoomSettingsForm = {
  mode: 'CLASSIC',
  maxPlayers: 8,
  rounds: 2,
  turnDuration: 60,
  difficulty: 'MIXED',
  category: '',
  enableHints: true,
  password: '',
};

const AVATARS = ['🐱', '🐶', '🐻', '🦊', '🐼', '🐨', '🦁', '🐸', '🐙', '🦄', '🐲', '🎃'];

export default function HomePage() {
  const router = useRouter();
  const [nickname, setNickname] = useState('');
  const [avatar, setAvatar] = useState('🐱');
  const [roomCode, setRoomCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<RoomSettingsForm>(DEFAULT_SETTINGS);
  const setPlayer = useGameStore(s => s.setPlayer);
  const storedPlayer = useGameStore(s => s.player);
  const authToken = useGameStore(s => s.token);
  const user = useGameStore(s => s.user);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (storedPlayer) setNickname(storedPlayer.nickname);
    fetch('/api/analytics/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'landing_view', sessionId: storedPlayer?.playerId }),
    }).catch(() => {});
  }, [storedPlayer]);

  async function ensureSession(name: string) {
    // A logged-in user must create rooms with their verified JWT, otherwise
    // the REST room host and the socket identity diverge.
    if (authToken) {
      return {
        token: authToken,
        playerId: user?.id ?? '',
        nickname: user?.nickname ?? name,
      };
    }
    if (storedPlayer && storedPlayer.nickname === name && storedPlayer.token) return storedPlayer;
    const session = await api.createGuest(name);
    const p = { token: session.token, playerId: session.playerId, nickname: name, avatar };
    setPlayer(p);
    return p;
  }

  async function handleCreateRoom() {
    if (!nickname.trim()) return;
    setErrorMsg(null);
    setLoading(true);
    try {
      const p = await ensureSession(nickname);
      const settingsPayload: Record<string, unknown> = {
        mode: settings.mode,
        maxPlayers: settings.maxPlayers,
        rounds: settings.rounds,
        turnDuration: settings.turnDuration,
        difficulty: settings.difficulty,
        enableHints: settings.enableHints,
      };
      if (settings.category) settingsPayload.category = settings.category;
      if (settings.password) settingsPayload.password = settings.password;
      const room = await api.createRoom(p.token, settingsPayload);
      fetch('/api/analytics/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'room_created', sessionId: p.playerId, data: { roomCode: room.roomCode } }),
      }).catch(() => {});
      router.push(`/room/${room.roomCode}`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Không thể tạo phòng. Vui lòng thử lại.');
      setLoading(false);
    }
  }

  function handleModeChange(mode: GameMode) {
    const cfg = getModeConfig(mode);
    setSettings(s => ({
      ...s,
      mode,
      maxPlayers:
        mode === 'DUEL'
          ? 2
          : Math.min(Math.max(s.maxPlayers, cfg.minPlayers), cfg.maxPlayers),
      rounds: mode === 'DUEL' ? cfg.rounds : s.rounds,
      turnDuration:
        mode === 'SPEED' || mode === 'DUEL' ? cfg.turnDuration : s.turnDuration,
    }));
  }

  async function handleJoinRoom() {
    if (!nickname.trim() || !roomCode.trim()) return;
    setLoading(true);
    try {
      await ensureSession(nickname);
      router.push(`/room/${roomCode.toUpperCase()}`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Không thể vào phòng. Vui lòng thử lại.');
      setLoading(false);
    }
  }

  async function handleChallenge() {
    setErrorMsg(null);
    if (!nickname.trim()) return;
    setLoading(true);
    try {
      await ensureSession(nickname);
      router.push('/challenge/create');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Không thể tạo thách thức. Vui lòng thử lại.');
      setLoading(false);
    }
  }

  async function handleDaily() {
    setErrorMsg(null);
    if (!nickname.trim()) return;
    setLoading(true);
    try {
      await ensureSession(nickname);
      router.push('/daily');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Không thể tải thách thức hàng ngày. Vui lòng thử lại.');
      setLoading(false);
    }
  }

  return (
    <AppShell variant="arena">
      <main
        className="min-h-[100dvh] flex items-center justify-center p-4 safe-top safe-bottom"
        data-ready={hydrated ? 'true' : undefined}
      >
        <div className="w-full max-w-md space-y-5">
          <div className="text-center space-y-2">
            <h1 className="text-4xl font-bold text-on-arena">DrawBattle</h1>
            <p className="text-muted-on-arena">Vẽ nhanh, đoán nhanh, cười cùng bạn bè</p>
          </div>

          <div className="panel-arena rounded-xl p-5 space-y-4">
            <div className="space-y-3">
              <label className="text-sm font-medium text-on-arena">Nickname & Avatar</label>
              <Input
                placeholder="Nhập tên của bạn..."
                value={nickname}
                onChange={e => setNickname(e.target.value)}
                maxLength={20}
                disabled={loading}
              />
              <div className="flex flex-wrap gap-1.5">
                {AVATARS.map(a => (
                  <button
                    key={a}
                    onClick={() => setAvatar(a)}
                    className={`w-11 h-11 rounded-lg text-xl flex items-center justify-center transition-all ${
                      avatar === a
                        ? 'bg-primary/30 ring-2 ring-primary scale-110'
                        : 'bg-arena-800/50 hover:bg-arena-800/70 text-on-arena'
                    }`}
                    aria-label={`Chọn avatar ${a}`}
                  >
                    {a}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-3">
              <div className="grid grid-cols-4 gap-1.5">
                {GAME_MODES.map(mode => (
                  <button
                    key={mode}
                    onClick={() => handleModeChange(mode)}
                    disabled={loading}
                    className={`h-11 rounded-lg px-1 text-xs font-medium transition-colors ${
                      settings.mode === mode
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-arena-800/50 text-on-arena hover:bg-arena-800/70'
                    }`}
                  >
                    {GAME_MODE_LABELS[mode]}
                  </button>
                ))}
              </div>

              {errorMsg && (
                <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-danger-on-arena">
                  {errorMsg}
                </p>
              )}

              <div className="space-y-2">
                <Button
                  size="lg"
                  className="w-full h-14 text-base font-semibold"
                  onClick={handleCreateRoom}
                  disabled={!nickname.trim() || loading}
                >
                  Tạo phòng {GAME_MODE_LABELS[settings.mode]}
                </Button>
                <button
                  onClick={() => setShowSettings(!showSettings)}
                  className="w-full min-h-11 text-xs text-muted-on-arena hover:text-on-arena transition-colors"
                  aria-expanded={showSettings}
                >
                  {showSettings ? 'Ẩn cài đặt phòng' : 'Tùy chỉnh cài đặt phòng'}
                </button>
              </div>

              {showSettings && (
                <div className="space-y-3 pt-2 border-t border-panel-border/20">
                  {settings.mode !== 'DUEL' && (
                    <div>
                      <label className="text-xs font-medium text-muted-on-arena">Số người chơi: {settings.maxPlayers}</label>
                      <input
                        type="range"
                        min={getModeConfig(settings.mode).minPlayers}
                        max={getModeConfig(settings.mode).maxPlayers}
                        value={settings.maxPlayers}
                        onChange={e => setSettings(s => ({ ...s, maxPlayers: parseInt(e.target.value) }))}
                        className="w-full mt-1"
                      />
                    </div>
                  )}
                  {settings.mode === 'DUEL' && (
                    <p className="text-xs text-muted-on-arena">1v1 Duel: 2 người chơi, 3 lượt</p>
                  )}
                  {settings.mode !== 'DUEL' && (
                    <div>
                      <label className="text-xs font-medium text-muted-on-arena">Số vòng: {settings.rounds}</label>
                      <input
                        type="range"
                        min={1}
                        max={3}
                        value={settings.rounds}
                        onChange={e => setSettings(s => ({ ...s, rounds: parseInt(e.target.value) }))}
                        className="w-full mt-1"
                      />
                    </div>
                  )}
                  <div>
                    <label className="text-xs font-medium text-muted-on-arena">Thời gian vẽ</label>
                    {settings.mode === 'SPEED' || settings.mode === 'DUEL' ? (
                      <p className="text-xs text-muted-on-arena mt-1">{settings.turnDuration}s (cố định cho chế độ này)</p>
                    ) : (
                      <div className="flex gap-2 mt-1">
                        {[45, 60, 90].map(t => (
                          <Button
                            key={t}
                            variant={settings.turnDuration === t ? 'default' : 'outline'}
                            size="sm"
                            onClick={() => setSettings(s => ({ ...s, turnDuration: t }))}
                            className="flex-1"
                          >
                            {t}s
                          </Button>
                        ))}
                      </div>
                    )}
                  </div>
                  {settings.mode === 'TEAM' && (
                    <p className="text-xs text-muted-on-arena">Đội chiến: cần tối thiểu 4 người, chia 2 đội tự động</p>
                  )}
                  <div>
                    <label className="text-xs font-medium text-muted-on-arena">Độ khó</label>
                    <div className="flex gap-1.5 mt-1 flex-wrap">
                      {(['EASY', 'MEDIUM', 'HARD', 'MIXED'] as Difficulty[]).map(d => (
                        <Button
                          key={d}
                          variant={settings.difficulty === d ? 'default' : 'outline'}
                          size="sm"
                          onClick={() => setSettings(s => ({ ...s, difficulty: d }))}
                        >
                          {d === 'EASY' ? 'Dễ' : d === 'MEDIUM' ? 'Trung bình' : d === 'HARD' ? 'Khó' : 'Hỗn hợp'}
                        </Button>
                      ))}
                    </div>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-on-arena">Chủ đề</label>
                    <select
                      value={settings.category}
                      onChange={e => setSettings(s => ({ ...s, category: e.target.value }))}
                      className="w-full mt-1 h-11 rounded-md border border-panel-border/30 bg-arena-900/50 px-3 text-sm text-on-arena"
                    >
                      <option value="">Tất cả</option>
                      {WORD_CATEGORIES.map(c => (
                        <option key={c.slug} value={c.slug}>{c.name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-medium text-muted-on-arena">Gợi ý (hints)</label>
                    <button
                      onClick={() => setSettings(s => ({ ...s, enableHints: !s.enableHints }))}
                      className={`flex min-h-11 min-w-11 shrink-0 items-center rounded-full transition-colors ${settings.enableHints ? 'bg-primary' : 'bg-arena-800'}`}
                      aria-label="Bật tắt gợi ý"
                      aria-pressed={settings.enableHints}
                    >
                      <div className={`m-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${settings.enableHints ? 'translate-x-5' : 'translate-x-0'}`} />
                    </button>
                  </div>
                  <div>
                    <label className="text-xs font-medium text-muted-on-arena">Mật khẩu (tùy chọn)</label>
                    <Input
                      placeholder="Để trống = không mật khẩu"
                      value={settings.password}
                      onChange={e => setSettings(s => ({ ...s, password: e.target.value }))}
                      maxLength={20}
                      className="mt-1"
                    />
                  </div>
                </div>
              )}

              <div className="space-y-2 pt-2 border-t border-panel-border/20">
                <label className="text-xs font-medium text-muted-on-arena">Vào phòng có sẵn</label>
                <div className="flex gap-2">
                  <Input
                    placeholder="Mã phòng"
                    value={roomCode}
                    onChange={e => setRoomCode(e.target.value.toUpperCase())}
                    maxLength={6}
                    disabled={loading}
                    className="uppercase flex-1"
                  />
                  <Button
                    variant="secondary"
                    onClick={handleJoinRoom}
                    disabled={!nickname.trim() || !roomCode.trim() || loading}
                  >
                    Vào
                  </Button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 pt-2 border-t border-panel-border/20">
                <Button
                  variant="secondary"
                  onClick={handleChallenge}
                  disabled={!nickname.trim() || loading}
                >
                  Thách bạn bè
                </Button>
                <Button
                  variant="secondary"
                  onClick={handleDaily}
                  disabled={!nickname.trim() || loading}
                >
                  Thử thách hàng ngày
                </Button>
              </div>

              <div className="flex gap-4 justify-center pt-2">
                <Link href="/history" className="text-sm text-muted-on-arena hover:text-on-arena transition-colors">
                  Lịch sử
                </Link>
                <Link href="/leaderboard" className="text-sm text-muted-on-arena hover:text-on-arena transition-colors">
                  Bảng xếp hạng
                </Link>
              </div>
            </div>
          </div>
        </div>
      </main>
    </AppShell>
  );
}
