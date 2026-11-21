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

  // NEXT_PUBLIC_API_URL is inlined at build time. When unset (the default) it
  // is empty and we use same-origin: the browser connects to the current
  // origin, and Next.js rewrites proxy /game to the API via INTERNAL_API_URL.
  // No localhost fallback is embedded in the browser bundle (P1-04).
  const explicitUrl = process.env.NEXT_PUBLIC_API_URL?.trim() || '';
  const apiUrl = explicitUrl || (typeof window !== 'undefined' ? window.location.origin : '');
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
