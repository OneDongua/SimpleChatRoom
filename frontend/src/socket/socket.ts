import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import type { ChatMessage } from '../../../shared/types.ts';

export type { ChatMessage };

const URL = 'http://localhost:3000';

interface ServerToClientEvents {
  message: (message: ChatMessage) => void;
}

interface ClientToServerEvents {
  message: (text: string) => void;
}

export const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io(URL, {
  autoConnect: false,
});
