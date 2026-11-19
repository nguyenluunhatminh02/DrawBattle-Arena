'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { useGameStore } from '@/lib/store';
import { connectSocket, disconnectSocket, getSocket } from '@/lib/socket';
import { DrawingCanvas } from '@/components/canvas/DrawingCanvas';
import { QRCodeDisplay } from '@/components/ui/qr-code';
import { getModeConfig } from '@drawbattle/shared';
import type { RoomSnapshot, PlayerInfo, StrokeChunk, ChatMessage, ScoreUpdate, MatchResult, TurnSnapshot, PhaseData, GamePhase, WordOption, TeamsPayload } from '@drawbattle/shared';

export default function RoomPage() {
  const params = useParams();
  const router = useRouter();
  const code = (params.code as string).toUpperCase();
  const player = useGameStore(s => s.player);
  const room = useGameStore(s => s.room);
  const myPlayerId = useGameStore(s => s.myPlayerId);
  const currentPhase = useGameStore(s => s.currentPhase);
  const drawerId = useGameStore(s => s.drawerId);
  const wordOptions = useGameStore(s => s.wordOptions);
  const currentWord = useGameStore(s => s.currentWord);
  const currentTurnId = useGameStore(s => s.currentTurnId);
  const turnEndsAt = useGameStore(s => s.turnEndsAt);
  const strokes = useGameStore(s => s.strokes);
  const scores = useGameStore(s => s.scores);
  const chat = useGameStore(s => s.chat);
  const hint = useGameStore(s => s.hint);

  const [chatInput, setChatInput] = useState('');
  const [connected, setConnected] = useState(false);
  const [showWordPicker, setShowWordPicker] = useState(false);
  const [revealWord, setRevealWord] = useState<string | null>(null);
  const [revealGuessers, setRevealGuessers] = useState<string[]>([]);
  const [matchResults, setMatchResults] = useState<MatchResult | null>(null);
  const [timeLeft, setTimeLeft] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [drawerOrder, setDrawerOrder] = useState<Array<{ id: string; nickname: string }> | null>(null);
  const [teams, setTeams] = useState<TeamsPayload | null>(null);
  const [needPassword, setNeedPassword] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');
  const passwordRef = useRef('');
  const chatEndRef = useRef<HTMLDivElement>(null);

  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  useEffect(() => {
    if (!hydrated) return;
    if (!player || !player.nickname || !player.token) {
      router.push('/');
      return;
    }

    const socket = connectSocket(player.token);
    const store = useGameStore.getState;

    let joined = false;
    const join = () => {
      if (joined) return;
      joined = true;
      socket.emit('room:join', { roomCode: code, token: player.token, nickname: player.nickname, password: passwordRef.current || undefined });
      setTimeout(() => {
        if (!useGameStore.getState().room) socket.emit('state:resync');
      }, 1500);
    };
    socket.on('disconnect', () => {
      setConnected(false);
      joined = false;
    });
    socket.on('connect', () => {
      setConnected(true);
      join();
    });
    if (socket.connected) {
      setConnected(true);
      setTimeout(join, 0);
    }

    socket.on('room:snapshot', (snapshot: RoomSnapshot) => {
      const s = store();
      s.setRoom({
        code: snapshot.code || code,
        hostId: snapshot.hostId,
        players: snapshot.players,
        settings: snapshot.settings,
        status: snapshot.status,
      });
      if (snapshot.yourPlayerId) s.setMyPlayerId(snapshot.yourPlayerId);
      s.setScores(snapshot.players.map(p => ({ playerId: p.id, points: p.score, delta: 0 })));
    });

    socket.on('room:playerJoined', (p: PlayerInfo) => {
      store().setRoom(r => {
        if (!r) return r;
        if (r.players.some(x => x.id === p.id)) return r;
        return { ...r, players: [...r.players, p] };
      });
    });

    socket.on('room:playerLeft', (playerId: string) => {
      const s = store();
      s.setRoom(r => {
        if (!r) return r;
        return { ...r, players: r.players.filter(p => p.id !== playerId) };
      });
      s.setScores(s.scores.filter(x => x.playerId !== playerId));
    });

    socket.on('room:hostChanged', (newHostId: string) => {
      store().setRoom(r => (r ? { ...r, hostId: newHostId } : r));
    });

    socket.on('match:started', (data) => {
      const s = store();
      s.setPhase('WORD_PICK');
      s.clearStrokes();
      s.clearChat();
      s.setHint(null);
      s.setCurrentWord(null);
      setMatchResults(null);
      setRevealWord(null);
      setRevealGuessers([]);
      if (data.drawerOrder) setDrawerOrder(data.drawerOrder);
      if (s.room?.settings.mode !== 'TEAM') setTeams(null);
      s.setScores((s.room?.players ?? []).map(p => ({ playerId: p.id, points: 0, delta: 0 })));
    });

    socket.on('match:teams', (data: TeamsPayload) => {
      setTeams(data);
    });

    socket.on('turn:youAreDrawer', (data: { turnId: string; words: WordOption[]; timeLimit: number }) => {
      const s = store();
      s.setDrawerId(s.myPlayerId);
      s.setCurrentTurnId(data.turnId);
      s.setWordOptions(data.words);
      s.setPhase('WORD_PICK');
      s.setTurnEndsAt(Date.now() + data.timeLimit * 1000);
      s.clearStrokes();
      s.setCurrentWord(null);
      s.setHint(null);
      setShowWordPicker(true);
    });

    socket.on('turn:publicState', (data: { turnId: string; drawerId: string; timeLimit: number }) => {
      const s = store();
      s.setDrawerId(data.drawerId);
      s.setCurrentTurnId(data.turnId);
      s.setPhase('WORD_PICK');
      s.setTurnEndsAt(Date.now() + data.timeLimit * 1000);
      if (data.drawerId !== s.myPlayerId) setShowWordPicker(false);
    });

    socket.on('turn:yourWord', (data: { word: string }) => {
      store().setCurrentWord(data.word);
    });

    socket.on('match:phaseChanged', (data: PhaseData & { phase: GamePhase }) => {
      const s = store();
      s.setPhase(data.phase);
      if (data.endsAt) s.setTurnEndsAt(data.endsAt);
      if (data.turnId) s.setCurrentTurnId(data.turnId);
      if (data.drawerId) s.setDrawerId(data.drawerId);
      if (data.phase === 'DRAWING') {
        setShowWordPicker(false);
        s.clearStrokes();
        setRevealWord(null);
        s.setHint(data.hint ?? null);
      }
    });

    socket.on('turn:hint', (data: { hint: string }) => {
      store().setHint(data.hint);
    });

    socket.on('draw:chunk', (chunk: StrokeChunk) => {
      store().addStroke(chunk);
    });

    socket.on('draw:reset', () => {
      store().clearStrokes();
    });

    socket.on('draw:undo', (strokeId: string) => {
      const s = store();
      s.setStrokes(s.strokes.filter(x => x.strokeId !== strokeId));
    });

    socket.on('room:playerKicked', (data: { playerId: string }) => {
      if (data.playerId === useGameStore.getState().myPlayerId) {
        alert('Bạn đã bị host kick khỏi phòng');
        router.push('/');
      }
    });

    socket.on('room:playerMuted', (data: { playerId: string; muted: boolean }) => {
      if (data.playerId === useGameStore.getState().myPlayerId && data.muted) {
        alert('Bạn đã bị mute bởi host');
      }
    });

    socket.on('guess:correct', (data: { playerId: string; score: number }) => {
      const s = store();
      const p = s.room?.players.find(x => x.id === data.playerId);
      s.addChat({
        id: crypto.randomUUID(),
        playerId: data.playerId,
        nickname: p?.nickname ?? '?',
        message: '',
        isGuess: true,
        isCorrect: true,
        timestamp: Date.now(),
      });
    });

    socket.on('score:updated', (s: ScoreUpdate[]) => {
      store().setScores(s);
    });

    socket.on('turn:revealed', (data: { word: string; correctGuessers: string[]; drawerScore: number }) => {
      store().setPhase('REVEAL');
      setRevealWord(data.word);
      setRevealGuessers(data.correctGuessers);
      setShowWordPicker(false);
    });

    socket.on('match:finished', (results: MatchResult) => {
      store().setPhase('MATCH_RESULT');
      setMatchResults(results);
    });

    socket.on('guess:accepted', (data: { playerId: string }) => {
    });

    socket.on('turn:restore', (t: TurnSnapshot) => {
      const s = store();
      s.setCurrentTurnId(t.id);
      s.setDrawerId(t.drawerId);
      s.setPhase(t.phase);
      s.setTurnEndsAt(t.endsAt);
      s.clearStrokes();
      for (const c of t.strokes) s.addStroke(c);
    });

    socket.on('chat:message', (msg: ChatMessage) => {
      store().addChat(msg);
    });

    socket.on('error', (errCode: string, message: string) => {
      if (errCode === 'INVALID_PASSWORD') {
        joined = false;
        setNeedPassword(true);
        return;
      }
      setErrorMsg(`${errCode}: ${message}`);
      setTimeout(() => setErrorMsg(null), 5000);
    });

    socket.on('match:cancelled', () => {
      const s = store();
      s.setPhase(null);
      s.clearStrokes();
      s.setHint(null);
      s.setCurrentWord(null);
      setMatchResults(null);
      setRevealWord(null);
      setRevealGuessers([]);
      setTeams(null);
      setErrorMsg('Trận trước đã bị hủy do server khởi động lại. Phòng đã sẵn sàng.');
      setTimeout(() => setErrorMsg(null), 6000);
    });

    return () => {
      socket.removeAllListeners();
      disconnectSocket();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, player, code, router]);

  useEffect(() => {
    if (!turnEndsAt) return;
    const interval = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((turnEndsAt - Date.now()) / 1000));
      setTimeLeft(remaining);
      if (remaining === 0) clearInterval(interval);
    }, 100);
    return () => clearInterval(interval);
  }, [turnEndsAt]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chat]);

  if (!hydrated || !player) return null;

  if (needPassword) {
    return (
      <div className="h-screen flex items-center justify-center p-4 bg-background">
        <Card className="w-full max-w-sm">
          <CardContent className="pt-6 space-y-3">
            <h2 className="text-lg font-semibold text-center">Phòng có mật khẩu</h2>
            <Input
              type="password"
              value={passwordInput}
              onChange={e => setPasswordInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && submitPassword()}
              placeholder="Nhập mật khẩu..."
              autoFocus
            />
            <Button className="w-full" onClick={submitPassword} disabled={!passwordInput.trim()}>
              Vào phòng
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const amIHost = !!myPlayerId && room?.hostId === myPlayerId;
  const amIDrawer = !!myPlayerId && !!drawerId && myPlayerId === drawerId;
  const drawerName = room?.players.find(p => p.id === drawerId)?.nickname ?? '?';
  const isInDrawingPhase = currentPhase === 'DRAWING';
  const isTeamMode = room?.settings.mode === 'TEAM' && !!teams;
  const myTeam: 'A' | 'B' | null = !teams || !myPlayerId
    ? null
    : teams.teamA.some(m => m.id === myPlayerId)
      ? 'A'
      : teams.teamB.some(m => m.id === myPlayerId)
        ? 'B'
        : null;
  const drawerTeam: 'A' | 'B' | null = !teams || !drawerId
    ? null
    : teams.teamA.some(m => m.id === drawerId)
      ? 'A'
      : teams.teamB.some(m => m.id === drawerId)
        ? 'B'
        : null;
  const teammateDrawing = isTeamMode && !!myTeam && myTeam === drawerTeam && !amIDrawer;
  const chatPlaceholder = amIDrawer && isInDrawingPhase
    ? 'Bạn không thể đoán'
    : teammateDrawing && isInDrawingPhase
      ? 'Đồng đội đang vẽ...'
      : isInDrawingPhase
        ? 'Đoán từ...'
        : 'Chat...';
  const chatDisabled = (amIDrawer || teammateDrawing) && isInDrawingPhase;

  function submitPassword() {
    passwordRef.current = passwordInput.trim();
    setNeedPassword(false);
    getSocket()?.emit('room:join', {
      roomCode: code,
      token: player!.token,
      nickname: player!.nickname,
      password: passwordRef.current,
    });
  }

  function handleStart() {
    getSocket()?.emit('match:start');
  }

  function handleRematch() {
    getSocket()?.emit('match:rematch');
  }

  function handleChooseWord(wordId: string) {
    getSocket()?.emit('turn:chooseWord', wordId);
    setShowWordPicker(false);
  }

  function handleSendChat() {
    if (!chatInput.trim()) return;
    const socket = getSocket();
    if (!socket) return;
    if (currentPhase === 'DRAWING' && !amIDrawer) {
      socket.emit('guess:submit', chatInput.trim());
    } else {
      socket.emit('chat:send', chatInput.trim());
    }
    setChatInput('');
  }

  function handleStroke(chunk: StrokeChunk) {
    getSocket()?.emit('draw:strokeChunk', chunk);
    useGameStore.getState().addStroke(chunk);
  }

  function handleStrokeStart(data: { turnId: string; strokeId: string }) {
    getSocket()?.emit('draw:strokeStart', data);
  }

  function handleStrokeEnd(data: { turnId: string; strokeId: string }) {
    getSocket()?.emit('draw:strokeEnd', data);
  }

  function handleClear() {
    getSocket()?.emit('draw:clear');
    useGameStore.getState().clearStrokes();
  }

  function handleUndo() {
    getSocket()?.emit('draw:undo');
  }

  function copyLink() {
    navigator.clipboard.writeText(`${window.location.origin}/room/${code}`);
  }

  const sortedScores = [...scores].sort((a, b) => b.points - a.points);

  return (
    <div className="h-screen flex flex-col bg-background">
      <header className="flex items-center justify-between px-4 py-2 border-b bg-card">
        <div className="flex items-center gap-3">
          <h1 className="font-bold text-primary">DrawBattle</h1>
          <Badge variant="outline">{code}</Badge>
          {room?.settings.mode && room.settings.mode !== 'CLASSIC' && (
            <Badge variant="secondary">
              {room.settings.mode === 'DUEL' ? '1v1' : room.settings.mode === 'SPEED' ? 'Speed' : 'Đội'}
            </Badge>
          )}
          <span className={`text-xs ${connected ? 'text-green-500' : 'text-red-500'}`}>
            {connected ? '● online' : '○ offline'}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {currentPhase && currentPhase !== 'WAITING' && currentPhase !== 'MATCH_RESULT' && (
            <Badge variant="secondary">{timeLeft}s</Badge>
          )}
          {drawerOrder && currentPhase && currentPhase !== 'WAITING' && (
            <div className="text-xs text-muted-foreground">
              Thứ tự: {drawerOrder.map((d, i) => <span key={d.id} className={d.id === drawerId ? 'font-bold text-primary' : ''}>{i > 0 && ' → '}{d.nickname}</span>)}
            </div>
          )}
          <Button size="sm" variant="outline" onClick={copyLink}>Copy Link</Button>
        </div>
      </header>

      {errorMsg && (
        <div className="px-4 py-2 bg-destructive/10 text-destructive text-sm">{errorMsg}</div>
      )}

      {teams && currentPhase && currentPhase !== 'WAITING' && currentPhase !== 'MATCH_RESULT' && (
        <div className="flex items-center justify-center gap-6 px-4 py-1.5 border-b bg-card text-xs">
          <div className="flex items-center gap-1.5">
            <Badge variant="secondary" className={myTeam === 'A' ? 'bg-blue-600 text-white' : ''}>Đội A</Badge>
            <span className="text-muted-foreground">
              {teams.teamA.map(m => m.nickname + (m.id === myPlayerId ? ' (bạn)' : '')).join(', ')}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Badge variant="secondary" className={myTeam === 'B' ? 'bg-red-600 text-white' : ''}>Đội B</Badge>
            <span className="text-muted-foreground">
              {teams.teamB.map(m => m.nickname + (m.id === myPlayerId ? ' (bạn)' : '')).join(', ')}
            </span>
          </div>
        </div>
      )}

      <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
        <div className="flex-1 flex flex-col min-h-0 md:min-h-full overflow-hidden">
          {room?.status === 'WAITING' && !currentPhase && (
            <div className="flex-1 flex items-center justify-center p-8 overflow-y-auto">
              <Card className="w-full max-w-md">
                <CardContent className="pt-6 space-y-4">
                  <h2 className="text-xl font-semibold text-center">Phòng chờ</h2>

                  <div className="flex flex-col items-center gap-2 p-3 bg-secondary/30 rounded">
                    <p className="text-sm text-muted-foreground">Quét để mời bạn bè</p>
                    <QRCodeDisplay value={`${typeof window !== 'undefined' ? window.location.origin : ''}/room/${code}`} size={140} />
                    <p className="text-xs font-mono">Mã: <span className="font-bold">{code}</span></p>
                  </div>

                  <div className="space-y-2">
                    {room.players.map(p => (
                      <div key={p.id} className="flex items-center justify-between p-2 rounded bg-secondary/50">
                        <span>{p.nickname}{p.id === myPlayerId ? ' (bạn)' : ''}</span>
                        <div className="flex gap-1 items-center">
                          {!p.isOnline && <Badge variant="outline">offline</Badge>}
                          {p.isReady && <Badge variant="secondary">ready</Badge>}
                          {p.isMuted && <Badge variant="secondary">muted</Badge>}
                          {p.isHost && <Badge>Host</Badge>}
                          {amIHost && p.id !== myPlayerId && (
                            <div className="flex gap-1">
                              <button
                                onClick={() => getSocket()?.emit('room:hostAction', { action: 'mute', targetId: p.id })}
                                className="text-xs px-1.5 py-0.5 bg-secondary rounded hover:bg-secondary/80"
                              >🔇</button>
                              <button
                                onClick={() => {
                                  if (confirm(`Kick ${p.nickname}?`)) {
                                    getSocket()?.emit('room:hostAction', { action: 'kick', targetId: p.id });
                                  }
                                }}
                                className="text-xs px-1.5 py-0.5 bg-destructive/10 rounded hover:bg-destructive/20"
                              >❌</button>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                  {amIHost && (
                    <div className="space-y-2 p-3 bg-secondary/30 rounded text-xs">
                      <div className="flex items-center justify-between">
                        <span>Số vòng</span>
                        <select
                          value={room.settings.rounds}
                          onChange={e => getSocket()?.emit('room:updateSettings', { rounds: parseInt(e.target.value) })}
                          className="h-7 rounded border bg-background px-2"
                        >
                          {[1, 2, 3].map(n => <option key={n} value={n}>{n}</option>)}
                        </select>
                      </div>
                      {room.settings.mode === 'CLASSIC' && (
                        <div className="flex items-center justify-between">
                          <span>Thời gian vẽ</span>
                          <select
                            value={room.settings.turnDuration}
                            onChange={e => getSocket()?.emit('room:updateSettings', { turnDuration: parseInt(e.target.value) })}
                            className="h-7 rounded border bg-background px-2"
                          >
                            {[45, 60, 90].map(n => <option key={n} value={n}>{n}s</option>)}
                          </select>
                        </div>
                      )}
                      <div className="flex items-center justify-between">
                        <span>Gợi ý (hints)</span>
                        <button
                          onClick={() => getSocket()?.emit('room:updateSettings', { enableHints: !room.settings.enableHints })}
                          className={`w-9 h-5 rounded-full transition-colors ${room.settings.enableHints ? 'bg-primary' : 'bg-secondary'}`}
                        >
                          <div className={`w-4 h-4 rounded-full bg-white shadow transition-transform ${room.settings.enableHints ? 'translate-x-4' : 'translate-x-0.5'}`} />
                        </button>
                      </div>
                    </div>
                  )}
                  {amIHost && (
                    <Button
                      className="w-full"
                      size="lg"
                      onClick={handleStart}
                      disabled={room.players.length < getModeConfig(room.settings.mode ?? 'CLASSIC').minPlayers}
                    >
                      Bắt đầu ({room.players.length}/{room.settings.maxPlayers})
                    </Button>
                  )}
                  {!amIHost && (
                    <>
                      <Button
                        variant="outline"
                        className="w-full"
                        onClick={() => {
                          const me = room.players.find(p => p.id === myPlayerId);
                          getSocket()?.emit('room:ready', !me?.isReady);
                        }}
                      >
                        {room.players.find(p => p.id === myPlayerId)?.isReady ? 'Bỏ sẵn sàng' : 'Sẵn sàng'}
                      </Button>
                      <p className="text-center text-muted-foreground text-sm">Đang chờ host bắt đầu...</p>
                    </>
                  )}
                </CardContent>
              </Card>
            </div>
          )}

          {showWordPicker && amIDrawer && currentPhase === 'WORD_PICK' && (
            <div className="flex-1 flex items-center justify-center p-8">
              <Card className="w-full max-w-lg">
                <CardContent className="pt-6 space-y-4">
                  <h2 className="text-xl font-semibold text-center">Chọn từ để vẽ</h2>
                  <p className="text-center text-muted-foreground">{timeLeft}s</p>
                  <div className="grid gap-3">
                    {wordOptions.map(w => (
                      <Button key={w.id} variant="outline" size="lg" onClick={() => handleChooseWord(w.id)}>
                        <span className="font-medium">{w.canonical}</span>
                        <Badge variant="secondary" className="ml-2">{w.difficulty}</Badge>
                      </Button>
                    ))}
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {currentPhase === 'WORD_PICK' && !showWordPicker && (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-muted-foreground">{drawerName} đang chọn từ...</p>
            </div>
          )}

          {currentPhase === 'DRAWING' && (
            <div className="flex flex-col p-2 md:flex-1 md:min-h-0">
              <div className="flex items-center justify-between mb-2 px-2 gap-2">
                <div className="flex items-center gap-2 flex-wrap min-w-0">
                  <Badge variant="outline" className="shrink-0">{amIDrawer ? 'Bạn đang vẽ' : `${drawerName} đang vẽ`}</Badge>
                  {amIDrawer && currentWord && <Badge className="shrink-0">{currentWord}</Badge>}
                  {hint && !amIDrawer && <Badge variant="secondary" className="tracking-widest shrink-0">{hint}</Badge>}
                </div>
                <Badge variant="secondary" className="shrink-0">{timeLeft}s</Badge>
              </div>
              <div className="aspect-[16/10] md:flex-1 md:aspect-auto md:min-h-0">
                <DrawingCanvas
                  strokes={strokes}
                  isDrawer={amIDrawer}
                  turnId={currentTurnId ?? ''}
                  onStroke={handleStroke}
                  onStrokeStart={handleStrokeStart}
                  onStrokeEnd={handleStrokeEnd}
                  onClear={handleClear}
                  onUndo={handleUndo}
                />
              </div>
            </div>
          )}

          {currentPhase === 'REVEAL' && (
            <div className="flex-1 flex items-center justify-center p-8">
              <Card className="w-full max-w-md">
                <CardContent className="pt-6 space-y-4 text-center">
                  <h2 className="text-2xl font-bold text-primary">{revealWord}</h2>
                  <p className="text-muted-foreground">Người đoán đúng:</p>
                  <div className="flex flex-wrap gap-2 justify-center">
                    {revealGuessers.map(id => {
                      const p = room?.players.find(x => x.id === id);
                      return <Badge key={id}>{p?.nickname || '?'}</Badge>;
                    })}
                    {revealGuessers.length === 0 && (
                      <p className="text-sm text-muted-foreground">Không ai đoán đúng</p>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {currentPhase === 'NEXT_TURN' && (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <p className="text-2xl font-bold text-primary animate-pulse">Lượt tiếp theo...</p>
              </div>
            </div>
          )}

          {currentPhase === 'MATCH_RESULT' && matchResults && (
            <div className="flex-1 flex items-center justify-center p-8 overflow-y-auto">
              <Card className="w-full max-w-md">
                <CardContent className="pt-6 space-y-4">
                  <h2 className="text-2xl font-bold text-center">Kết quả</h2>
                  {matchResults.teams && (
                    <div className="p-4 rounded-lg bg-secondary/50 text-center space-y-2">
                      <p className="font-semibold">
                        {matchResults.teams.winner === 'DRAW'
                          ? 'Hòa!'
                          : `Đội ${matchResults.teams.winner} thắng!`}
                      </p>
                      <div className="flex items-center justify-center gap-6 text-sm">
                        <span>
                          Đội A: <strong>{matchResults.teams.teamA.points} pts</strong>
                        </span>
                        <span>
                          Đội B: <strong>{matchResults.teams.teamB.points} pts</strong>
                        </span>
                      </div>
                    </div>
                  )}
                  {matchResults.rankings.length > 0 && (
                    <div className="text-center p-4 bg-gradient-to-r from-yellow-100 to-yellow-50 rounded-lg border-2 border-yellow-300">
                      <p className="text-4xl">🏆</p>
                      <p className="text-lg font-bold">{matchResults.rankings[0].nickname}</p>
                      <p className="text-2xl font-bold text-primary">{matchResults.rankings[0].points} pts</p>
                    </div>
                  )}
                  <div className="space-y-2">
                    {matchResults.rankings.slice(1).map(r => (
                      <div key={r.playerId} className="flex items-center justify-between p-3 rounded bg-secondary/50">
                        <div className="flex items-center gap-3">
                          <span className="text-lg font-bold text-muted-foreground">#{r.rank}</span>
                          <span className="font-medium">{r.nickname}</span>
                        </div>
                        <span className="font-bold text-primary">{r.points} pts</span>
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    {amIHost && (
                      <Button className="flex-1" size="lg" onClick={handleRematch}>Chơi lại</Button>
                    )}
                    <Button variant="outline" className="flex-1" size="lg" onClick={() => {
                      if (navigator.share) {
                        navigator.share({ title: 'DrawBattle', text: `Kết quả: ${matchResults.rankings[0]?.nickname} thắng!`, url: window.location.href });
                      } else {
                        navigator.clipboard.writeText(window.location.href);
                      }
                    }}>Chia sẻ</Button>
                    <Button variant="outline" size="lg" onClick={() => router.push('/')}>Về trang chủ</Button>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
        </div>

        <div className="w-full md:w-80 flex-1 md:flex-initial border-t md:border-t-0 md:border-l flex flex-col bg-card flex-shrink-0 min-h-0">
          <div className="p-3 border-b">
            <h3 className="font-semibold text-sm">Bảng điểm</h3>
          </div>
          <div className="flex-1 overflow-y-auto p-3 space-y-1">
            {sortedScores.map((s, i) => {
              const p = room?.players.find(x => x.id === s.playerId);
              return (
                <div key={s.playerId} className="flex items-center justify-between text-sm p-1">
                  <span className="truncate">
                    <span className="text-muted-foreground mr-1">{i + 1}.</span>
                    {p?.nickname || '?'}
                  </span>
                  <span className="font-medium">{s.points}</span>
                </div>
              );
            })}
          </div>
          <div className="border-t flex flex-col h-40 md:h-64">
            <div className="flex-1 overflow-y-auto p-3 space-y-1 text-sm">
              {chat.map(msg => (
                <div key={msg.id}>
                  <span className="font-medium text-xs">{msg.nickname}: </span>
                  {msg.isCorrect ? (
                    <span className="text-green-600 font-medium">đã đoán đúng!</span>
                  ) : (
                    <span>{msg.message}</span>
                  )}
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>
            <div className="p-2 border-t flex gap-1">
              <Input
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSendChat()}
                placeholder={chatPlaceholder}
                disabled={chatDisabled}
                className="text-sm h-8"
              />
              <Button size="sm" onClick={handleSendChat} disabled={!chatInput.trim() || chatDisabled} className="h-8">
                Gửi
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
