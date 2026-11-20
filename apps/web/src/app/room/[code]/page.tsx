'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { useGameStore } from '@/lib/store';
import { connectSocket, disconnectSocket, getSocket } from '@/lib/socket';
import { api } from '@/lib/api';
import { DrawingCanvas } from '@/components/canvas/DrawingCanvas';
import { QRCodeDisplay } from '@/components/ui/qr-code';
import { getModeConfig } from '@drawbattle/shared';
import type { RoomSnapshot, PlayerInfo, StrokeChunk, ChatMessage, ScoreUpdate, MatchResult, TurnSnapshot, PhaseData, GamePhase, WordOption, TeamsPayload } from '@drawbattle/shared';
import { AppShell } from '@/components/layout';

export default function RoomPage() {
  const params = useParams();
  const router = useRouter();
  const code = (params.code as string).toUpperCase();
  const player = useGameStore(s => s.player);
  const authToken = useGameStore(s => s.token);
  const user = useGameStore(s => s.user);
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
  const [joinNickname, setJoinNickname] = useState('');
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [autoJoining, setAutoJoining] = useState(false);
  const [roomUnavailable, setRoomUnavailable] = useState<string | null>(null);
  const [joinVersion, setJoinVersion] = useState(0);
  const autoJoinRef = useRef(false);

  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);

  // Reset QR-join state when navigating to a different room code.
  useEffect(() => {
    autoJoinRef.current = false;
    setRoomUnavailable(null);
    setNeedPassword(false);
    setJoinError(null);
  }, [code]);

  // QR links land on /room/CODE with no persisted identity. Bootstrap one
  // guest session automatically for open rooms; password rooms still require
  // manual input. The ref is reset in cleanup so React StrictMode's second
  // mount can retry; the cancelled flag prevents duplicate sessions.
  useEffect(() => {
    if (!hydrated || player || autoJoinRef.current || roomUnavailable) return;
    autoJoinRef.current = true;

    let cancelled = false;
    (async () => {
      try {
        const info = await api.getRoomInfo(code);
        if (cancelled) return;
        if (info.status !== 'WAITING') {
          setRoomUnavailable('Phòng đã bắt đầu hoặc không còn sẵn sàng.');
          return;
        }
        if (info.playerCount >= info.maxPlayers) {
          setRoomUnavailable('Phòng đã đầy.');
          return;
        }
        if (info.hasPassword) {
          setNeedPassword(true);
          return;
        }

        // Authenticated users already carry a verified JWT and a persisted
        // player identity; do not create an orphaned guest session.
        if (authToken || user) return;

        setAutoJoining(true);
        const nickname = `Player_${Math.floor(1000 + Math.random() * 9000)}`;
        const session = await api.createGuest(nickname);
        if (cancelled) return;
        useGameStore.getState().setPlayer({
          token: session.token,
          playerId: session.playerId,
          nickname,
        });
      } catch (err) {
        if (!cancelled) {
          setRoomUnavailable(err instanceof Error ? err.message : 'Không thể vào phòng');
        }
      } finally {
        if (!cancelled) setAutoJoining(false);
      }
    })();

    return () => {
      cancelled = true;
      // StrictMode remounts this effect; allow the second run to retry.
      // The first async call above is cancelled before it can create a guest.
      autoJoinRef.current = false;
    };
  }, [hydrated, player, authToken, user, code, roomUnavailable]);

  useEffect(() => {
    if (!hydrated) return;
    if (!player || !player.nickname || !player.token) return;

    // A registered account should join with its verified user JWT. Guest
    // sessions remain the fallback for anonymous players. Never create a
    // guest identity for an authenticated user — the gateway derives the
    // authoritative nickname from the verified JWT.
    const socketToken = authToken || player.token;
    const socket = connectSocket(socketToken);
    const store = useGameStore.getState;

    let joined = false;
    const join = () => {
      if (joined) return;
      joined = true;
      socket.emit('room:join', { roomCode: code, token: socketToken, password: passwordRef.current || undefined });
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

    socket.on('room:left', () => {
      router.push('/');
    });

    socket.on('room:kicked', () => {
      alert('Bạn đã bị host kick khỏi phòng');
      useGameStore.getState().setRoom(null);
      useGameStore.getState().setMyPlayerId(null);
      router.push('/');
    });

    socket.on('error', (errCode: string, message: string) => {
      if (errCode === 'INVALID_PASSWORD') {
        joined = false;
        setJoining(false);
        setNeedPassword(true);
        setJoinError('Mật khẩu không đúng. Vui lòng thử lại.');
        return;
      }
      if (errCode === 'KICKED') {
        useGameStore.getState().setRoom(null);
        useGameStore.getState().setMyPlayerId(null);
        router.push('/');
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
  }, [hydrated, player, authToken, code, joinVersion, router]);

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

  if (!hydrated) return null;

  if (roomUnavailable) {
    return (
      <div className="h-[100dvh] flex items-center justify-center p-4 bg-gradient-to-br from-purple-50 to-blue-50">
        <Card className="w-full max-w-sm">
          <CardContent className="pt-6 space-y-3 text-center">
            <h2 className="text-lg font-semibold">Không vào được phòng</h2>
            <p className="text-sm text-muted-foreground">{roomUnavailable}</p>
            <Button className="w-full h-11" onClick={() => router.push('/')}>Về trang chủ</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (needPassword) {
    return (
      <div className="h-[100dvh] flex items-center justify-center p-4 bg-background">
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
            <Button className="w-full h-11" onClick={submitPassword} disabled={!passwordInput.trim() || joining}>
              {joining ? 'Đang vào...' : 'Vào phòng'}
            </Button>
            {joinError && <p className="text-sm text-destructive text-center">{joinError}</p>}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!player || !player.nickname || !player.token) {
    return (
      <div className="h-[100dvh] flex items-center justify-center p-4 bg-gradient-to-br from-purple-50 to-blue-50">
        <Card className="w-full max-w-sm">
          <CardContent className="pt-6 space-y-3">
            <h2 className="text-lg font-semibold text-center">Vào phòng <span className="font-mono text-primary">{code}</span></h2>
            <p className="text-sm text-muted-foreground text-center">Nhập tên để tham gia cùng bạn bè</p>
            <Input
              value={joinNickname}
              onChange={e => setJoinNickname(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && joinWithNickname()}
              placeholder="Nhập tên của bạn..."
              maxLength={20}
              autoFocus
              className="h-11 text-base"
            />
            {joinError && <p className="text-sm text-destructive">{joinError}</p>}
            <Button className="w-full h-11" onClick={joinWithNickname} disabled={!joinNickname.trim() || joining}>
              {joining ? 'Đang vào...' : 'Vào phòng'}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const amIHost = !!myPlayerId && room?.hostId === myPlayerId;
  const others = room?.players.filter(p => p.id !== myPlayerId) ?? [];
  const notReady = others.filter(p => !p.isReady);
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

  async function joinWithNickname() {
    const name = joinNickname.trim();
    if (!name || joining) return;
    setJoining(true);
    setJoinError(null);
    try {
      const session = await api.createGuest(name);
      useGameStore.getState().setPlayer({ token: session.token, playerId: session.playerId, nickname: name });
    } catch (err) {
      setJoinError(err instanceof Error ? err.message : 'Không tạo được phiên, thử lại');
      setJoining(false);
    }
  }

  async function submitPassword() {
    const pwd = passwordInput.trim();
    if (!pwd || joining) return;
    setJoining(true);
    setJoinError(null);
    passwordRef.current = pwd;
    try {
      // A QR scan on a password room has no player yet. Bootstrap a guest
      // identity; the socket effect will join with passwordRef.current.
      // Never create a guest for an authenticated user — they keep their JWT.
      if (!player && !authToken) {
        const nickname = `Player_${Math.floor(1000 + Math.random() * 9000)}`;
        const session = await api.createGuest(nickname);
        useGameStore.getState().setPlayer({
          token: session.token,
          playerId: session.playerId,
          nickname,
        });
      }
      setNeedPassword(false);
      // If player already exists (registered user or previous guest), trigger
      // socket rejoin by bumping joinVersion so the effect re-runs.
      if (player || authToken) {
        setJoinVersion(v => v + 1);
      }
    } catch (err) {
      setJoinError(err instanceof Error ? err.message : 'Không thể vào phòng');
      setJoining(false);
    }
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
    <AppShell>
    <div className="h-[100dvh] flex flex-col text-on-arena">
      <header className="flex items-center justify-between gap-1.5 px-3 md:px-4 py-2 safe-top arena-bg border-b border-panel-border/30">
        <div className="flex items-center gap-1.5 md:gap-3 min-w-0">
          <h1 className="font-black text-primary text-sm md:text-base shrink-0 tracking-tight">DrawBattle</h1>
          <Badge variant="outline" className="shrink-0 font-mono border-panel-border/40 text-on-arena">{code}</Badge>
          {room?.settings.mode && room.settings.mode !== 'CLASSIC' && (
            <Badge variant="secondary" className="shrink-0 hidden xs:inline-flex sm:inline-flex">
              {room.settings.mode === 'DUEL' ? '1v1' : room.settings.mode === 'SPEED' ? 'Speed' : 'Đội'}
            </Badge>
          )}
          <span className={`hidden sm:inline text-xs shrink-0 ${connected ? 'text-success' : 'text-destructive'}`}>
            {connected ? '● trực tuyến' : '○ mất kết nối'}
          </span>
        </div>
        <div className="flex items-center gap-1 md:gap-2 shrink-0">
          {currentPhase && currentPhase !== 'WAITING' && currentPhase !== 'MATCH_RESULT' && (
            <Badge className="shrink-0 score-number text-base px-3">{timeLeft}s</Badge>
          )}
          {drawerOrder && currentPhase && currentPhase !== 'WAITING' && (
            <div className="hidden md:block text-xs text-muted-on-arena">
              Thứ tự: {drawerOrder.map((d, i) => <span key={d.id} className={d.id === drawerId ? 'font-bold text-primary' : ''}>{i > 0 && ' → '}{d.nickname}</span>)}
            </div>
          )}
          <Button size="sm" variant="outline" onClick={copyLink} className="shrink-0 h-11 px-3 border-panel-border/40 bg-transparent text-on-arena hover:bg-panel">
            <span className="hidden md:inline">Copy Link</span><span className="md:hidden">Link</span>
          </Button>
          <Button size="sm" variant="ghost" className="text-destructive shrink-0 h-11 px-3" onClick={() => {
            if (confirm('Bạn có chắc muốn rời phòng?')) {
              getSocket()?.emit('room:leave');
            }
          }}>
            <span className="hidden md:inline">Rời phòng</span><span className="md:hidden">Thoát</span>
          </Button>
        </div>
      </header>

      {errorMsg && (
        <div className="px-4 py-2 bg-destructive/10 text-destructive text-sm">{errorMsg}</div>
      )}

      {teams && currentPhase && currentPhase !== 'WAITING' && currentPhase !== 'MATCH_RESULT' && (
        <div className="flex items-center justify-center gap-3 md:gap-6 px-2 md:px-4 py-1.5 border-b border-panel-border/30 bg-panel/50 text-xs overflow-x-auto no-scrollbar">
          <div className="flex items-center gap-1.5">
            <Badge className={`${myTeam === 'A' ? 'bg-team-a text-white' : 'bg-panel text-on-arena'} shrink-0`}>● Đội A</Badge>
            <span className="text-muted-on-arena whitespace-nowrap">
              {teams.teamA.map(m => m.nickname + (m.id === myPlayerId ? ' (bạn)' : '')).join(', ')}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Badge className={`${myTeam === 'B' ? 'bg-team-b text-white' : 'bg-panel text-on-arena'} shrink-0`}>▲ Đội B</Badge>
            <span className="text-muted-on-arena whitespace-nowrap">
              {teams.teamB.map(m => m.nickname + (m.id === myPlayerId ? ' (bạn)' : '')).join(', ')}
            </span>
          </div>
        </div>
      )}

      <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
        <div className="flex-1 flex flex-col min-h-0 md:min-h-full overflow-hidden">
          {room?.status === 'WAITING' && !currentPhase && (
            <div className="flex-1 flex items-center justify-center p-3 md:p-8 overflow-y-auto">
              <Card className="w-full max-w-md panel-arena border-0 shadow-panel text-on-arena">
                <CardContent className="pt-4 md:pt-6 space-y-3 md:space-y-4">
                  <div className="text-center space-y-1">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-on-arena">Sân chơi</p>
                    <h2 className="text-xl md:text-2xl font-black tracking-tight">Phòng chờ</h2>
                  </div>

                  <div className="flex flex-col items-center gap-2 p-3 rounded-xl bg-panel/70 border border-panel-border/30">
                    <p className="text-sm text-muted-on-arena">Quét mã để mời bạn bè</p>
                    <div className="p-2 bg-paper rounded-lg shadow-paper">
                      <QRCodeDisplay value={`${typeof window !== 'undefined' ? window.location.origin : ''}/room/${code}`} size={140} />
                    </div>
                    <p className="text-xs font-mono text-muted-on-arena">Mã phòng: <span className="font-bold text-on-arena">{code}</span></p>
                  </div>

                  <div className="space-y-2">
                    {room.players.map(p => (
                      <div key={p.id} className="flex items-center justify-between gap-2 p-2 rounded-xl bg-panel/50 border border-panel-border/20">
                        <span className="truncate min-w-0 text-sm">{p.nickname}{p.id === myPlayerId ? ' (bạn)' : ''}</span>
                        <div className="flex gap-1 items-center flex-wrap justify-end shrink-0">
                          {!p.isOnline && <Badge variant="outline" className="border-destructive/50 text-destructive">Ngoại tuyến</Badge>}
                          {p.isReady && <Badge className="bg-success text-white">Sẵn sàng</Badge>}
                          {p.isOnline && !p.isReady && !p.isHost && <Badge variant="outline" className="text-muted-on-arena font-normal border-panel-border/30">Chưa sẵn sàng</Badge>}
                          {p.isMuted && <Badge variant="secondary">Đã tắt tiếng</Badge>}
                          {p.isHost && <Badge>Chủ phòng</Badge>}
                          {amIHost && p.id !== myPlayerId && (
                            <div className="flex gap-1">
                              <button
                                onClick={() => getSocket()?.emit('room:hostAction', { action: 'mute', targetId: p.id })}
                                className="w-11 h-11 flex items-center justify-center text-base bg-panel rounded hover:bg-panel/70 text-on-arena"
                                aria-label={p.isMuted ? 'Bật tiếng' : 'Tắt tiếng'}
                                title={p.isMuted ? 'Bật tiếng' : 'Tắt tiếng'}
                              >{p.isMuted ? '🔈' : '🔇'}</button>
                              <button
                                onClick={() => {
                                  if (confirm(`Kick ${p.nickname}?`)) {
                                    getSocket()?.emit('room:hostAction', { action: 'kick', targetId: p.id });
                                  }
                                }}
                                className="w-11 h-11 flex items-center justify-center text-base bg-destructive/10 rounded hover:bg-destructive/20"
                                aria-label="Kick"
                                title="Kick"
                              >❌</button>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                  {amIHost && (
                    <div className="space-y-3 p-3 rounded-xl bg-panel/50 border border-panel-border/20 text-sm">
                      <div className="flex items-center justify-between gap-3">
                        <label htmlFor="room-rounds" className="text-muted-on-arena">Số vòng</label>
                        <select
                          id="room-rounds"
                          value={room.settings.rounds}
                          onChange={e => getSocket()?.emit('room:updateSettings', { rounds: parseInt(e.target.value) })}
                          className="h-11 rounded-md border border-panel-border/30 bg-panel px-3 text-base text-on-arena"
                        >
                          {[1, 2, 3].map(n => <option key={n} value={n}>{n}</option>)}
                        </select>
                      </div>
                      {room.settings.mode === 'CLASSIC' && (
                        <div className="flex items-center justify-between gap-3">
                          <label htmlFor="room-duration" className="text-muted-on-arena">Thời gian vẽ</label>
                          <select
                            id="room-duration"
                            value={room.settings.turnDuration}
                            onChange={e => getSocket()?.emit('room:updateSettings', { turnDuration: parseInt(e.target.value) })}
                            className="h-11 rounded-md border border-panel-border/30 bg-panel px-3 text-base text-on-arena"
                          >
                            {[45, 60, 90].map(n => <option key={n} value={n}>{n}s</option>)}
                          </select>
                        </div>
                      )}
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-muted-on-arena">Gợi ý (hints)</span>
                        <button
                          onClick={() => getSocket()?.emit('room:updateSettings', { enableHints: !room.settings.enableHints })}
                          className={`w-12 h-11 rounded-full transition-colors relative ${room.settings.enableHints ? 'bg-primary' : 'bg-panel'}`}
                          aria-label="Bật/tắt gợi ý"
                          aria-pressed={room.settings.enableHints}
                        >
                          <div className={`w-6 h-6 rounded-full bg-white shadow transition-transform absolute top-2.5 ${room.settings.enableHints ? 'translate-x-5' : 'translate-x-0.5'}`} />
                        </button>
                      </div>
                    </div>
                  )}
                  {amIHost && (
                    <>
                      <Button
                        className="w-full h-12"
                        size="lg"
                        onClick={handleStart}
                        disabled={room.players.length < getModeConfig(room.settings.mode ?? 'CLASSIC').minPlayers || notReady.length > 0}
                      >
                        Bắt đầu ({room.players.length}/{room.settings.maxPlayers})
                      </Button>
                      {notReady.length > 0 && room.players.length >= getModeConfig(room.settings.mode ?? 'CLASSIC').minPlayers && (
                        <p className="text-center text-xs text-muted-foreground">
                          Chờ sẵn sàng: {notReady.map(p => p.nickname).join(', ')}
                        </p>
                      )}
                    </>
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
            <div className="flex-1 flex items-center justify-center p-3 md:p-8 overflow-y-auto">
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
            <div className="flex flex-col p-2 flex-1 min-h-0">
              <div className="flex items-center justify-between mb-2 px-2 gap-2">
                <div className="flex items-center gap-2 flex-wrap min-w-0">
                  <Badge variant="outline" className="shrink-0">{amIDrawer ? 'Bạn đang vẽ' : `${drawerName} đang vẽ`}</Badge>
                  {amIDrawer && currentWord && <Badge className="shrink-0">{currentWord}</Badge>}
                  {hint && !amIDrawer && <Badge variant="secondary" className="tracking-widest shrink-0">{hint}</Badge>}
                </div>
                <Badge variant="secondary" className="shrink-0">{timeLeft}s</Badge>
              </div>
              <div className="flex-1 min-h-0">
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
            <div className="flex-1 flex items-center justify-center p-3 md:p-8 overflow-y-auto">
              <Card className="w-full max-w-md panel-arena border-0 shadow-panel text-on-arena">
                <CardContent className="pt-6 space-y-4 text-center">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-on-arena">Đáp án</p>
                  <h2 className="text-3xl md:text-4xl font-black tracking-tight text-primary">{revealWord}</h2>
                  <p className="text-sm text-muted-on-arena">Người đoán đúng:</p>
                  <div className="flex flex-wrap gap-2 justify-center">
                    {revealGuessers.map(id => {
                      const p = room?.players.find(x => x.id === id);
                      return <Badge key={id}>{p?.nickname || '?'}</Badge>;
                    })}
                    {revealGuessers.length === 0 && (
                      <p className="text-sm text-muted-on-arena">Không ai đoán đúng</p>
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
            <div className="flex-1 flex items-center justify-center p-3 md:p-8 overflow-y-auto">
              <Card className="w-full max-w-md panel-arena border-0 shadow-panel text-on-arena">
                <CardContent className="pt-6 space-y-4">
                  <div className="text-center space-y-1">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-on-arena">Tổng kết</p>
                    <h2 className="text-2xl md:text-3xl font-black tracking-tight">Kết quả</h2>
                  </div>
                  {matchResults.teams && (
                    <div className="p-4 rounded-xl bg-panel/60 border border-panel-border/30 text-center space-y-2">
                      <p className="font-bold text-lg">
                        {matchResults.teams.winner === 'DRAW'
                          ? 'Hòa!'
                          : `Đội ${matchResults.teams.winner} thắng!`}
                      </p>
                      <div className="flex items-center justify-center gap-6 text-sm">
                        <span className="text-team-a">
                          ● Đội A: <strong className="score-number">{matchResults.teams.teamA.points} điểm</strong>
                        </span>
                        <span className="text-team-b">
                          ▲ Đội B: <strong className="score-number">{matchResults.teams.teamB.points} điểm</strong>
                        </span>
                      </div>
                    </div>
                  )}
                  {matchResults.rankings.length > 0 && (
                    <div className="text-center p-4 bg-warning/10 rounded-xl border-2 border-warning/60">
                      <p className="text-4xl" aria-hidden>🏆</p>
                      <p className="text-lg font-bold">{matchResults.rankings[0].nickname}</p>
                      <p className="text-3xl font-black text-primary score-number">{matchResults.rankings[0].points} điểm</p>
                    </div>
                  )}
                  <div className="space-y-2">
                    {matchResults.rankings.slice(1).map(r => (
                      <div key={r.playerId} className="flex items-center justify-between p-3 rounded-xl bg-panel/50 border border-panel-border/20">
                        <div className="flex items-center gap-3">
                          <span className="text-lg font-bold text-muted-on-arena score-number">#{r.rank}</span>
                          <span className="font-medium">{r.nickname}</span>
                        </div>
                        <span className="font-bold text-primary score-number">{r.points} điểm</span>
                      </div>
                    ))}
                  </div>
                  <div className="flex flex-col sm:flex-row gap-2">
                    {amIHost && (
                      <Button className="flex-1" size="lg" onClick={handleRematch}>Chơi lại</Button>
                    )}
                    <Button variant="outline" className="flex-1 border-panel-border/40 bg-transparent text-on-arena hover:bg-panel" size="lg" onClick={() => {
                      if (navigator.share) {
                        navigator.share({ title: 'DrawBattle', text: `Kết quả: ${matchResults.rankings[0]?.nickname} thắng!`, url: window.location.href });
                      } else {
                        navigator.clipboard.writeText(window.location.href);
                      }
                    }}>Chia sẻ</Button>
                    <Button variant="outline" className="border-panel-border/40 bg-transparent text-on-arena hover:bg-panel" size="lg" onClick={() => router.push('/')}>Về trang chủ</Button>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
        </div>

        <div className={`${room?.status === 'WAITING' && !currentPhase ? 'hidden md:flex' : 'flex'} w-full md:w-80 h-[30dvh] md:h-[50dvh] md:h-auto md:flex-initial border-t md:border-t-0 md:border-l border-panel-border/30 flex-col panel-arena flex-shrink-0 min-h-0 safe-bottom no-scrollbar`}>
          <div className="p-3 border-b border-panel-border/30 hidden md:block">
            <h3 className="font-semibold text-sm text-on-arena">Bảng điểm</h3>
          </div>
          <div className="md:flex-1 overflow-x-auto md:overflow-y-auto p-2 md:p-3 flex md:block gap-1.5 md:space-y-1 border-b md:border-b-0 border-panel-border/30 shrink-0">
            {sortedScores.map((s, i) => {
              const p = room?.players.find(x => x.id === s.playerId);
              return (
                <div key={s.playerId} className="flex items-center justify-between text-sm p-1 shrink-0 rounded bg-panel/40 md:bg-transparent px-2 md:px-1 gap-1.5 text-on-arena">
                  <span className="truncate max-w-[7rem] md:max-w-none">
                    <span className="text-muted-on-arena mr-1 score-number">{i + 1}.</span>
                    {p?.nickname || '?'}
                  </span>
                  <span className="font-medium score-number">{s.points}</span>
                </div>
              );
            })}
          </div>
          <div className="border-t border-panel-border/30 flex flex-col flex-1 min-h-0 md:flex-initial md:h-64">
            <div className="flex-1 overflow-y-auto p-3 space-y-1 text-sm text-on-arena">
              {chat.map(msg => (
                <div key={msg.id}>
                  <span className="font-medium text-xs text-muted-on-arena">{msg.nickname}: </span>
                  {msg.isCorrect ? (
                    <span className="text-success font-medium">đã đoán đúng!</span>
                  ) : (
                    <span>{msg.message}</span>
                  )}
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>
            <div className="p-2 border-t border-panel-border/30 flex gap-1">
              <Input
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSendChat()}
                placeholder={chatPlaceholder}
                disabled={chatDisabled}
                className="text-base md:text-sm h-11"
              />
              <Button size="sm" onClick={handleSendChat} disabled={!chatInput.trim() || chatDisabled} className="h-11 px-4 shrink-0">
                Gửi
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
    </AppShell>
  );
}
