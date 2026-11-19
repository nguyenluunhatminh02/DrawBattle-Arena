'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
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
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<RoomSettingsForm>(DEFAULT_SETTINGS);
  const setPlayer = useGameStore(s => s.setPlayer);
  const storedPlayer = useGameStore(s => s.player);
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
    if (storedPlayer && storedPlayer.nickname === name && storedPlayer.token) return storedPlayer;
    const session = await api.createGuest(name);
    const p = { token: session.token, playerId: session.playerId, nickname: name };
    setPlayer(p);
    return p;
  }

  async function handleCreateRoom() {
    if (!nickname.trim()) return;
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
    } catch {
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
    } catch {
      setLoading(false);
    }
  }

  async function handleChallenge() {
    if (!nickname.trim()) return;
    setLoading(true);
    try {
      await ensureSession(nickname);
      router.push('/challenge/create');
    } catch {
      setLoading(false);
    }
  }

  async function handleDaily() {
    if (!nickname.trim()) return;
    setLoading(true);
    try {
      await ensureSession(nickname);
      router.push('/daily');
    } catch {
      setLoading(false);
    }
  }

  return (
    <main
      className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-br from-purple-50 to-blue-50"
      data-ready={hydrated ? 'true' : undefined}
    >
      <div className="w-full max-w-md space-y-4">
        <div className="text-center">
          <h1 className="text-4xl font-bold text-primary">DrawBattle</h1>
          <p className="text-muted-foreground mt-2">Vẽ nhanh, đoán nhanh, cười cùng bạn bè</p>
        </div>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Nickname & Avatar</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
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
                  className={`w-9 h-9 rounded-lg text-lg flex items-center justify-center transition-all ${
                    avatar === a ? 'bg-primary/20 ring-2 ring-primary scale-110' : 'bg-secondary hover:bg-secondary/80'
                  }`}
                >
                  {a}
                </button>
              ))}
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-3">
          <div className="grid grid-cols-4 gap-1.5">
            {GAME_MODES.map(mode => (
              <button
                key={mode}
                onClick={() => handleModeChange(mode)}
                disabled={loading}
                className={`rounded-lg px-1 py-2 text-xs font-medium transition-colors ${
                  settings.mode === mode
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-secondary text-secondary-foreground hover:bg-secondary/70'
                }`}
              >
                {GAME_MODE_LABELS[mode]}
              </button>
            ))}
          </div>

          <div>
            <Button size="lg" className="w-full" onClick={handleCreateRoom} disabled={!nickname.trim() || loading}>
              Tạo phòng {GAME_MODE_LABELS[settings.mode]}
            </Button>
            <button
              onClick={() => setShowSettings(!showSettings)}
              className="w-full text-xs text-muted-foreground hover:text-primary mt-1 underline"
            >
              {showSettings ? 'Ẩn cài đặt phòng' : 'Tùy chỉnh cài đặt phòng'}
            </button>
          </div>

          {showSettings && (
            <Card>
              <CardContent className="pt-4 space-y-3">
                {settings.mode !== 'DUEL' && (
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Số người chơi: {settings.maxPlayers}</label>
                    <input
                      type="range"
                      min={getModeConfig(settings.mode).minPlayers}
                      max={getModeConfig(settings.mode).maxPlayers}
                      value={settings.maxPlayers}
                      onChange={e => setSettings(s => ({ ...s, maxPlayers: parseInt(e.target.value) }))}
                      className="w-full"
                    />
                  </div>
                )}
                {settings.mode === 'DUEL' && (
                  <p className="text-xs text-muted-foreground">1v1 Duel: 2 người chơi, 3 lượt</p>
                )}
                {settings.mode !== 'DUEL' && (
                  <div>
                    <label className="text-xs font-medium text-muted-foreground">Số vòng: {settings.rounds}</label>
                    <input
                      type="range"
                      min={1}
                      max={3}
                      value={settings.rounds}
                      onChange={e => setSettings(s => ({ ...s, rounds: parseInt(e.target.value) }))}
                      className="w-full"
                    />
                  </div>
                )}
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Thời gian vẽ</label>
                  {settings.mode === 'SPEED' || settings.mode === 'DUEL' ? (
                    <p className="text-xs text-muted-foreground mt-1">{settings.turnDuration}s (cố định cho chế độ này)</p>
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
                  <p className="text-xs text-muted-foreground">Đội chiến: cần tối thiểu 4 người, chia 2 đội tự động</p>
                )}
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Độ khó</label>
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
                  <label className="text-xs font-medium text-muted-foreground">Chủ đề</label>
                  <select
                    value={settings.category}
                    onChange={e => setSettings(s => ({ ...s, category: e.target.value }))}
                    className="w-full mt-1 h-9 rounded-md border bg-background px-3 text-sm"
                  >
                    <option value="">Tất cả</option>
                    {WORD_CATEGORIES.map(c => (
                      <option key={c.slug} value={c.slug}>{c.name}</option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center justify-between">
                  <label className="text-xs font-medium text-muted-foreground">Gợi ý (hints)</label>
                  <button
                    onClick={() => setSettings(s => ({ ...s, enableHints: !s.enableHints }))}
                    className={`w-10 h-5 rounded-full transition-colors ${settings.enableHints ? 'bg-primary' : 'bg-secondary'}`}
                  >
                    <div className={`w-4 h-4 rounded-full bg-white shadow transition-transform ${settings.enableHints ? 'translate-x-5' : 'translate-x-0.5'}`} />
                  </button>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Mật khẩu (tùy chọn)</label>
                  <Input
                    placeholder="Để trống = không mật khẩu"
                    value={settings.password}
                    onChange={e => setSettings(s => ({ ...s, password: e.target.value }))}
                    maxLength={20}
                    className="mt-1"
                  />
                </div>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardContent className="pt-6 flex gap-2">
              <Input
                placeholder="Mã phòng"
                value={roomCode}
                onChange={e => setRoomCode(e.target.value.toUpperCase())}
                maxLength={6}
                disabled={loading}
                className="uppercase"
              />
              <Button
                variant="outline"
                onClick={handleJoinRoom}
                disabled={!nickname.trim() || !roomCode.trim() || loading}
              >
                Vào
              </Button>
            </CardContent>
          </Card>

          <Button variant="secondary" size="lg" onClick={handleChallenge} disabled={!nickname.trim() || loading}>
            Thách bạn bè
          </Button>

          <Button variant="outline" size="lg" onClick={handleDaily} disabled={!nickname.trim() || loading}>
            Thử thách hàng ngày
          </Button>

          <div className="flex gap-3 justify-center">
            <Link href="/history" className="text-sm text-muted-foreground hover:text-primary underline">
              Lịch sử
            </Link>
            <Link href="/leaderboard" className="text-sm text-muted-foreground hover:text-primary underline">
              Bảng xếp hạng
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
