import { io, Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@drawbattle/shared';

let socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;
let currentToken: string | null = null;

export function getSocket(): Socket<ServerToClientEvents, ClientToServerEvents> | null {
  return socket;
}

export function connectSocket(token: string): Socket<ServerToClientEvents, ClientToServerEvents> {
  if (socket && socket.connected && currentToken === token) return socket;

  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
    currentToken = null;
  }

  const apiUrl =
    process.env.NEXT_PUBLIC_API_URL ||
    (typeof window !== 'undefined' &&
    window.location.hostname !== 'localhost' &&
    window.location.hostname !== '127.0.0.1'
      ? window.location.origin
      : 'http://localhost:3001');
  socket = io(`${apiUrl}/game`, {
    auth: { token },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionAttempts: 10,
  });
  currentToken = token;

  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
