
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Server, Socket } from 'socket.io';
import {
  createMatch,
  getPrivateRole,
  getPublicMatchState,
  beginActions, submitPlayerAction, allActionsSubmitted, fillMissingActions, resolveJob,
  recordInvestigation, getInvestigationResult, finishInvestigation,
  submitVote, allVotesSubmitted, fillMissingVotes, resolveVote, removeMatchPlayer,
  type MatchState, type PlayerAction,
} from './game.js';

type Player = {
  id: string;
  name: string;
  ready: boolean;
  connected: boolean;
  isHost: boolean;
  tokenHash: string;
  disconnectDeadline: number | null;
};

type Room = {
  code: string;
  hostId: string;
  status: 'lobby' | 'playing' | 'finished';
  capacity: 8;
  players: Map<string, Player>;
};

type RoomPlayerSnapshot = {
  id: string;
  name: string;
  ready: boolean;
  connected: boolean;
  isHost: boolean;
};

type RoomSnapshot = {
  code: string;
  hostId: string;
  status: 'lobby' | 'playing' | 'finished';
  capacity: number;
  players: RoomPlayerSnapshot[];
};

type Ack = (result: {
  ok: boolean;
  data?: unknown;
  error?: string;
}) => void;

type Request = {
  name?: unknown;
  code?: unknown;
  ready?: unknown;
  playerId?: unknown;
  reconnectToken?: unknown;
  action?: unknown;
  targetId?: unknown;
  text?: unknown;
};

const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const DEFAULT_RECONNECT_WINDOW_MS = 2 * 60 * 1000;
const RECONNECT_TOKEN_LENGTH = 64;
const MIN_PLAYERS = 4;
const MAX_PLAYERS = 8;

function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const name = value.trim().replace(/\s+/g, ' ');

  return name.length >= 1 && name.length <= 18 ? name : null;
}

function validCode(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-HJ-NP-Z2-9]{6}$/.test(value)
  );
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly socketPlayers = new Map<string, string>();
  private readonly matches = new Map<string, MatchState>();

  private readonly actionTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private readonly expiryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  constructor(
    private readonly io: Server,
    private readonly reconnectWindowMs = DEFAULT_RECONNECT_WINDOW_MS,
  ) {}

  register(socket: Socket): void {
    socket.on('room:create', (raw: Request, ack?: Ack) => {
      const name = cleanName(raw?.name);

      if (!name) {
        this.reply(ack, {
          ok: false,
          error: 'Name must be between 1 and 18 characters.',
        });
        return;
      }

      const code = this.generateCode();
      const playerId = randomUUID();
      const reconnectToken = randomBytes(32).toString('hex');

      const player: Player = {
        id: playerId,
        name,
        ready: false,
        connected: true,
        isHost: true,
        tokenHash: hashToken(reconnectToken),
        disconnectDeadline: null,
      };

      const room: Room = {
        code,
        hostId: playerId,
        status: 'lobby',
        capacity: MAX_PLAYERS,
        players: new Map([[playerId, player]]),
      };

      this.rooms.set(code, room);
      this.socketPlayers.set(socket.id, playerId);

      void socket.join(code);
      this.publish(room);

      this.reply(ack, {
        ok: true,
        data: {
          room: this.snapshot(room),
          playerId,
          reconnectToken,
        },
      });
    });

    socket.on('room:join', (raw: Request, ack?: Ack) => {
      const name = cleanName(raw?.name);
      const code = raw?.code;

      if (!name) {
        this.reply(ack, {
          ok: false,
          error: 'Name must be between 1 and 18 characters.',
        });
        return;
      }

      if (!validCode(code)) {
        this.reply(ack, {
          ok: false,
          error: 'Invalid room code.',
        });
        return;
      }

      const room = this.rooms.get(code);

      if (!room) {
        this.reply(ack, {
          ok: false,
          error: 'Room not found.',
        });
        return;
      }

      if (room.status !== 'lobby') {
        this.reply(ack, {
          ok: false,
          error: 'This room is not accepting players.',
        });
        return;
      }

      if (room.players.size >= room.capacity) {
        this.reply(ack, {
          ok: false,
          error: 'Room is full.',
        });
        return;
      }

      const playerId = randomUUID();
      const reconnectToken = randomBytes(32).toString('hex');

      const player: Player = {
        id: playerId,
        name,
        ready: false,
        connected: true,
        isHost: false,
        tokenHash: hashToken(reconnectToken),
        disconnectDeadline: null,
      };

      room.players.set(playerId, player);
      this.socketPlayers.set(socket.id, playerId);

      void socket.join(code);
      this.publish(room);

      this.reply(ack, {
        ok: true,
        data: {
          room: this.snapshot(room),
          playerId,
          reconnectToken,
        },
      });
    });

    socket.on('session:resume', (raw: Request, ack?: Ack) => {
      const playerId = raw?.playerId;
      const reconnectToken = raw?.reconnectToken;

      if (
        typeof playerId !== 'string' ||
        typeof reconnectToken !== 'string' ||
        reconnectToken.length !== RECONNECT_TOKEN_LENGTH
      ) {
        this.reply(ack, {
          ok: false,
          error: 'Invalid reconnect credentials.',
        });
        return;
      }

      const room = this.findRoom(playerId);
      const player = room?.players.get(playerId);

      if (!room || !player) {
        this.reply(ack, {
          ok: false,
          error: 'Reconnect session not found or expired.',
        });
        return;
      }

      if (player.tokenHash !== hashToken(reconnectToken)) {
        this.reply(ack, {
          ok: false,
          error: 'Invalid reconnect credentials.',
        });
        return;
      }

      if (
        player.connected &&
        this.socketPlayers.get(socket.id) !== playerId
      ) {
        this.reply(ack, {
          ok: false,
          error: 'This player is already connected.',
        });
        return;
      }

      if (
        !player.connected &&
        player.disconnectDeadline !== null &&
        Date.now() >= player.disconnectDeadline
      ) {
        this.removePlayer(room, playerId);

        this.reply(ack, {
          ok: false,
          error: 'Reconnect session not found or expired.',
        });
        return;
      }

      const timer = this.expiryTimers.get(playerId);

      if (timer) {
        clearTimeout(timer);
        this.expiryTimers.delete(playerId);
      }

      // Remove stale socket mappings before binding this session.
      for (const [socketId, mappedPlayerId] of this.socketPlayers) {
        if (mappedPlayerId === playerId && socketId !== socket.id) {
          this.socketPlayers.delete(socketId);
        }
      }

      player.connected = true;
      player.disconnectDeadline = null;

      // Rotate the reconnect token after every successful resume.
      const newReconnectToken = randomBytes(32).toString('hex');
      player.tokenHash = hashToken(newReconnectToken);

      this.socketPlayers.set(socket.id, playerId);

      void socket.join(room.code);

      // Restore private role and public match state after reconnecting.
      const activeMatch = this.matches.get(room.code);

      if (activeMatch) {
        socket.emit('match:role', {
          matchId: activeMatch.matchId,
          role: getPrivateRole(activeMatch, playerId),
        });

        socket.emit(
          'match:state',
          this.publicMatchState(room, activeMatch),
        );
      }

      this.publish(room);

      this.reply(ack, {
        ok: true,
        data: {
          room: this.snapshot(room),
          playerId,
          reconnectToken: newReconnectToken,
        },
      });
    });

    socket.on('room:ready', (raw: Request, ack?: Ack) => {
      const playerId = this.socketPlayers.get(socket.id);
      const room = playerId ? this.findRoom(playerId) : undefined;
      const player = room?.players.get(playerId!);

      if (!room || !player) {
        this.reply(ack, {
          ok: false,
          error: 'You are not in a room.',
        });
        return;
      }

      if (room.status !== 'lobby') {
        this.reply(ack, {
          ok: false,
          error: 'Ready status cannot change after the match starts.',
        });
        return;
      }

      if (typeof raw?.ready !== 'boolean') {
        this.reply(ack, {
          ok: false,
          error: 'Ready status must be true or false.',
        });
        return;
      }

      player.ready = raw.ready;
      this.publish(room);

      this.reply(ack, {
        ok: true,
        data: { ready: player.ready },
      });
    });

    socket.on('game:start', (_raw: Request, ack?: Ack) => {
      const playerId = this.socketPlayers.get(socket.id);
      const room = playerId ? this.findRoom(playerId) : undefined;
      const player = room?.players.get(playerId!);

      if (!room || !player) {
        this.reply(ack, {
          ok: false,
          error: 'You are not in a room.',
        });
        return;
      }

      if (room.hostId !== playerId) {
        this.reply(ack, {
          ok: false,
          error: 'Only the host can start the game.',
        });
        return;
      }

      if (room.status !== 'lobby' || this.matches.has(room.code)) {
        this.reply(ack, {
          ok: false,
          error: 'The match has already started.',
        });
        return;
      }

      if (room.players.size < MIN_PLAYERS) {
  this.reply(ack, {
    ok: false,
    error: 'At least four players are required.',
  });
  return;
}

if (room.players.size > MAX_PLAYERS) {
  this.reply(ack, {
    ok: false,
    error: 'A match cannot have more than eight players.',
  });
  return;
}
      const allReady = [...room.players.values()].every(
        currentPlayer =>
          currentPlayer.connected && currentPlayer.ready,
      );

      if (!allReady) {
        this.reply(ack, {
          ok: false,
          error: 'All players must be connected and ready.',
        });
        return;
      }

      const playerIds = [...room.players.keys()];
      const playerNames = Object.fromEntries([...room.players.values()].map(currentPlayer => [currentPlayer.id, currentPlayer.name]));
      const match = createMatch(playerIds, playerNames);

      this.matches.set(room.code, match);
      room.status = 'playing';

      // Deliver each role only to the socket belonging to that player.
      for (const [socketId, mappedPlayerId] of this.socketPlayers) {
        if (!playerIds.includes(mappedPlayerId)) continue;

        this.io.to(socketId).emit('match:role', {
          matchId: match.matchId,
          role: getPrivateRole(match, mappedPlayerId),
        });
      }

      // The public snapshot deliberately excludes roles and player IDs.
      const publicState = this.publicMatchState(room, match);

      this.io.to(room.code).emit('match:state', publicState);
      this.publish(room);

      this.reply(ack, {
        ok: true,
        data: publicState,
      });
    });

    socket.on('job:begin', (_raw: Request, ack?: Ack) => {
      const playerId = this.socketPlayers.get(socket.id);
      const room = playerId ? this.findRoom(playerId) : undefined;
      const match = room ? this.matches.get(room.code) : undefined;
      if (!room || !playerId || !match) return this.reply(ack, { ok: false, error: 'No active match found.' });
      if (room.hostId !== playerId) return this.reply(ack, { ok: false, error: 'Only the host can begin the job.' });
      try {
        beginActions(match);
        const existingTimer = this.actionTimers.get(room.code);
        if (existingTimer) clearTimeout(existingTimer);
        const timer = setTimeout(() => {
          const active = this.matches.get(room.code);
          const activeRoom = this.rooms.get(room.code);
          if (!active || !activeRoom || active.phase !== 'ACTIONS' || active.status !== 'ACTIVE') return;
          try {
            fillMissingActions(active);
            const result = resolveJob(active);
            this.io.to(room.code).emit('job:result', { ...result, timedOut: true });
            this.io.to(room.code).emit('match:state', this.publicMatchState(activeRoom, active));
          } catch { /* A later valid state transition may have superseded this timer. */ }
          this.actionTimers.delete(room.code);
        }, 45_000);
        timer.unref();
        this.actionTimers.set(room.code, timer);
        this.io.to(room.code).emit('match:state', this.publicMatchState(room, match));
        this.reply(ack, { ok: true, data: this.publicMatchState(room, match) });
      } catch (error) { this.reply(ack, { ok: false, error: this.errorMessage(error) }); }
    });

    socket.on('action:submit', (raw: Request, ack?: Ack) => {
      const playerId = this.socketPlayers.get(socket.id);
      const room = playerId ? this.findRoom(playerId) : undefined;
      const match = room ? this.matches.get(room.code) : undefined;
      if (!room || !playerId || !match) return this.reply(ack, { ok: false, error: 'No active match found.' });
      if (typeof raw?.action !== 'string' || !['WORK', 'GUARD', 'SABOTAGE'].includes(raw.action)) return this.reply(ack, { ok: false, error: 'Choose a valid action.' });
      try {
        submitPlayerAction(match, playerId, raw.action as PlayerAction, typeof raw.targetId === 'string' ? raw.targetId : undefined);
        this.io.to(room.code).emit('match:state', this.publicMatchState(room, match));
        this.reply(ack, { ok: true, data: { submitted: true, allSubmitted: allActionsSubmitted(match) } });
      } catch (error) { this.reply(ack, { ok: false, error: this.errorMessage(error) }); }
    });

    socket.on('job:resolve', (_raw: Request, ack?: Ack) => {
      const playerId = this.socketPlayers.get(socket.id);
      const room = playerId ? this.findRoom(playerId) : undefined;
      const match = room ? this.matches.get(room.code) : undefined;
      if (!room || !playerId || !match) return this.reply(ack, { ok: false, error: 'No active match found.' });
      if (room.hostId !== playerId) return this.reply(ack, { ok: false, error: 'Only the host can resolve the job.' });
      try {
        const actionTimer = this.actionTimers.get(room.code);
        if (actionTimer) clearTimeout(actionTimer);
        this.actionTimers.delete(room.code);
        const result = resolveJob(match);
        this.io.to(room.code).emit('job:result', result);
        this.io.to(room.code).emit('match:state', this.publicMatchState(room, match));
        this.reply(ack, { ok: true, data: { result, state: this.publicMatchState(room, match) } });
      } catch (error) { this.reply(ack, { ok: false, error: this.errorMessage(error) }); }
    });

    socket.on('investigation:submit', (raw: Request, ack?: Ack) => {
      const playerId = this.socketPlayers.get(socket.id);
      const room = playerId ? this.findRoom(playerId) : undefined;
      const match = room ? this.matches.get(room.code) : undefined;
      if (!room || !playerId || !match) return this.reply(ack, { ok: false, error: 'No active match found.' });
      if (typeof raw?.targetId !== 'string') return this.reply(ack, { ok: false, error: 'Choose a player to investigate.' });
      try {
        const role = recordInvestigation(match, playerId, raw.targetId);
        socket.emit('investigation:result', { targetId: raw.targetId, role });
        this.io.to(room.code).emit('match:state', this.publicMatchState(room, match));
        this.reply(ack, { ok: true, data: { submitted: true } });
      } catch (error) { this.reply(ack, { ok: false, error: this.errorMessage(error) }); }
    });

    socket.on('investigation:finish', (_raw: Request, ack?: Ack) => {
      const playerId = this.socketPlayers.get(socket.id);
      const room = playerId ? this.findRoom(playerId) : undefined;
      const match = room ? this.matches.get(room.code) : undefined;
      if (!room || !playerId || !match) return this.reply(ack, { ok: false, error: 'No active match found.' });
      if (room.hostId !== playerId) return this.reply(ack, { ok: false, error: 'Only the host can close the investigation.' });
      try {
        finishInvestigation(match);
        const existingTimer = this.actionTimers.get(room.code);
        if (existingTimer) clearTimeout(existingTimer);
        const timer = setTimeout(() => {
          const active = this.matches.get(room.code);
          const activeRoom = this.rooms.get(room.code);
          if (!active || !activeRoom || active.phase !== 'VOTING' || active.status !== 'ACTIVE') return;
          try {
            fillMissingVotes(active);
            const names = Object.fromEntries([...activeRoom.players.values()].map(currentPlayer => [currentPlayer.id, currentPlayer.name]));
            const result = resolveVote(active, names);
            this.io.to(room.code).emit('vote:result', { ...result, timedOut: true });
            this.io.to(room.code).emit('match:state', this.publicMatchState(activeRoom, active));
          } catch { /* A later valid state transition may have superseded this timer. */ }
          this.actionTimers.delete(room.code);
        }, 45_000);
        timer.unref();
        this.actionTimers.set(room.code, timer);
        this.io.to(room.code).emit('match:state', this.publicMatchState(room, match));
        this.reply(ack, { ok: true, data: this.publicMatchState(room, match) });
      } catch (error) { this.reply(ack, { ok: false, error: this.errorMessage(error) }); }
    });

    socket.on('vote:submit', (raw: Request, ack?: Ack) => {
      const playerId = this.socketPlayers.get(socket.id);
      const room = playerId ? this.findRoom(playerId) : undefined;
      const match = room ? this.matches.get(room.code) : undefined;
      if (!room || !playerId || !match) return this.reply(ack, { ok: false, error: 'No active match found.' });
      if (raw?.targetId !== null && typeof raw?.targetId !== 'string') return this.reply(ack, { ok: false, error: 'Choose a player or explicitly abstain.' });
      try {
        submitVote(match, playerId, raw.targetId as string | null);
        this.io.to(room.code).emit('match:state', this.publicMatchState(room, match));
        this.reply(ack, { ok: true, data: { submitted: true, allSubmitted: allVotesSubmitted(match) } });
      } catch (error) { this.reply(ack, { ok: false, error: this.errorMessage(error) }); }
    });

    socket.on('vote:resolve', (_raw: Request, ack?: Ack) => {
      const playerId = this.socketPlayers.get(socket.id);
      const room = playerId ? this.findRoom(playerId) : undefined;
      const match = room ? this.matches.get(room.code) : undefined;
      if (!room || !playerId || !match) return this.reply(ack, { ok: false, error: 'No active match found.' });
      if (room.hostId !== playerId) return this.reply(ack, { ok: false, error: 'Only the host can resolve the vote.' });
      try {
        const voteTimer = this.actionTimers.get(room.code);
        if (voteTimer) clearTimeout(voteTimer);
        this.actionTimers.delete(room.code);
        const names = Object.fromEntries([...room.players.values()].map(player => [player.id, player.name]));
        const result = resolveVote(match, names);
        if (match.status === 'ACTIVE' && !match.players.some(activePlayer => activePlayer.id === room.hostId)) {
          const nextHost = [...room.players.values()].find(candidate =>
            candidate.connected && match.players.some(activePlayer => activePlayer.id === candidate.id),
          ) ?? [...room.players.values()].find(candidate =>
            match.players.some(activePlayer => activePlayer.id === candidate.id),
          );
          if (nextHost) {
            room.hostId = nextHost.id;
            for (const candidate of room.players.values()) candidate.isHost = candidate.id === room.hostId;
            this.publish(room);
          }
        }
        this.io.to(room.code).emit('vote:result', result);
        this.io.to(room.code).emit('match:state', this.publicMatchState(room, match));
        this.reply(ack, { ok: true, data: { result, state: this.publicMatchState(room, match) } });
      } catch (error) { this.reply(ack, { ok: false, error: this.errorMessage(error) }); }
    });

    socket.on('chat:send', (raw: Request, ack?: Ack) => {
      const playerId = this.socketPlayers.get(socket.id);
      const room = playerId ? this.findRoom(playerId) : undefined;
      const player = room?.players.get(playerId!);
      if (!room || !player) return this.reply(ack, { ok: false, error: 'Join a room before chatting.' });
      if (typeof raw?.text !== 'string') return this.reply(ack, { ok: false, error: 'Enter a message.' });
      const text = raw.text.trim().replace(/\s+/g, ' ').slice(0, 240);
      if (!text) return this.reply(ack, { ok: false, error: 'Enter a message.' });
      this.io.to(room.code).emit('chat:message', { id: randomUUID(), playerId, name: player.name, text, sentAt: Date.now() });
      this.reply(ack, { ok: true, data: { sent: true } });
    });

    socket.on('room:leave', async (_raw: Request, ack?: Ack) => {
      const playerId = this.socketPlayers.get(socket.id);

      if (!playerId) {
        this.reply(ack, {
          ok: false,
          error: 'You are not in a room.',
        });
        return;
      }

      const room = this.findRoom(playerId);

      if (!room) {
        this.socketPlayers.delete(socket.id);

        this.reply(ack, {
          ok: false,
          error: 'Room not found.',
        });
        return;
      }

      // Remove the active mapping before modifying room membership.
      this.socketPlayers.delete(socket.id);

      // Leave the Socket.IO broadcast group before publishing the roster.
      await socket.leave(room.code);

      // This clears reconnect timers and transfers host ownership if needed.
      this.removePlayer(room, playerId);

      this.reply(ack, {
        ok: true,
        data: { left: true },
      });
    });

    socket.on('disconnect', () => {
      const playerId = this.socketPlayers.get(socket.id);

      if (!playerId) return;

      this.socketPlayers.delete(socket.id);

      const room = this.findRoom(playerId);
      const player = room?.players.get(playerId);

      if (!room || !player) return;

      player.connected = false;
      player.ready = false;
      player.disconnectDeadline = Date.now() + this.reconnectWindowMs;

      const existingTimer = this.expiryTimers.get(playerId);

      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      const timer = setTimeout(() => {
        const currentRoom = this.findRoom(playerId);
        const currentPlayer = currentRoom?.players.get(playerId);

        if (
          currentRoom &&
          currentPlayer &&
          !currentPlayer.connected &&
          currentPlayer.disconnectDeadline !== null &&
          currentPlayer.disconnectDeadline <= Date.now()
        ) {
          this.removePlayer(currentRoom, playerId);
        }

        if (this.expiryTimers.get(playerId) === timer) {
          this.expiryTimers.delete(playerId);
        }
      }, this.reconnectWindowMs);

      timer.unref();
      this.expiryTimers.set(playerId, timer);

      this.publish(room);
    });
  }

  private publicMatchState(room: Room, match: MatchState) {
    const names = Object.fromEntries([...room.players.values()].map(player => [player.id, { name: player.name, connected: player.connected }]));
    return getPublicMatchState(match, names);
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'The action could not be completed.';
  }

  private removePlayer(room: Room, playerId: string): void {
    const timer = this.expiryTimers.get(playerId);

    if (timer) {
      clearTimeout(timer);
      this.expiryTimers.delete(playerId);
    }

    for (const [socketId, mappedPlayerId] of this.socketPlayers) {
      if (mappedPlayerId === playerId) {
        this.socketPlayers.delete(socketId);
      }
    }

    const departingPlayer = room.players.get(playerId);
    const activeMatch = this.matches.get(room.code);
    if (activeMatch && departingPlayer) {
      removeMatchPlayer(activeMatch, playerId, departingPlayer.name);
    }

    room.players.delete(playerId);

    if (room.players.size === 0) {
      const actionTimer = this.actionTimers.get(room.code);
      if (actionTimer) clearTimeout(actionTimer);
      this.actionTimers.delete(room.code);
      this.rooms.delete(room.code);
      this.matches.delete(room.code);
      return;
    }

    if (room.hostId === playerId) {
      const matchForHostTransfer = this.matches.get(room.code);
      const activePlayers = matchForHostTransfer?.status === 'ACTIVE'
        ? new Set(matchForHostTransfer.players.map(activePlayer => activePlayer.id))
        : null;
      const remainingPlayers = [...room.players.values()];
      const nextHost = (activePlayers
        ? remainingPlayers.find(candidate => candidate.connected && activePlayers.has(candidate.id))
          ?? remainingPlayers.find(candidate => activePlayers.has(candidate.id))
        : undefined)
        ?? remainingPlayers[0];

      if (nextHost) room.hostId = nextHost.id;
    }

    for (const currentPlayer of room.players.values()) {
      currentPlayer.isHost = currentPlayer.id === room.hostId;
    }

    this.publish(room);

    const currentMatch = this.matches.get(room.code);
    if (currentMatch) {
      if (currentMatch.status === 'FINISHED') {
        const actionTimer = this.actionTimers.get(room.code);
        if (actionTimer) clearTimeout(actionTimer);
        this.actionTimers.delete(room.code);
      }
      this.io.to(room.code).emit('match:state', this.publicMatchState(room, currentMatch));
    }
  }

  private findRoom(playerId: string): Room | undefined {
    for (const room of this.rooms.values()) {
      if (room.players.has(playerId)) {
        return room;
      }
    }

    return undefined;
  }

  private generateCode(): string {
    for (let attempt = 0; attempt < 100; attempt++) {
      let code = '';

      for (let i = 0; i < 6; i++) {
        code += ROOM_CODE_CHARS[
          Math.floor(Math.random() * ROOM_CODE_CHARS.length)
        ];
      }

      if (!this.rooms.has(code)) {
        return code;
      }
    }

    throw new Error('Unable to generate a unique room code.');
  }

  private snapshot(room: Room): RoomSnapshot {
    return {
      code: room.code,
      hostId: room.hostId,
      status: room.status,
      capacity: room.capacity,
      players: [...room.players.values()].map(player => ({
        id: player.id,
        name: player.name,
        ready: player.ready,
        connected: player.connected,
        isHost: player.isHost,
      })),
    };
  }

  private publish(room: Room): void {
    this.io.to(room.code).emit('room:state', this.snapshot(room));
  }

  private reply(
    ack: Ack | undefined,
    result: {
      ok: boolean;
      data?: unknown;
      error?: string;
    },
  ): void {
    if (typeof ack === 'function') {
      ack(result);
    }
  }
}
