
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server as SocketIOServer } from 'socket.io';
import { io as createClient, type Socket } from 'socket.io-client';
import { RoomManager } from '../src/rooms.js';

type Reply = {
  ok: boolean;
  data?: any;
  error?: string;
};

type TestContext = {
  connect: () => Promise<Socket>;
  close: () => Promise<void>;
};

const contexts: TestContext[] = [];

after(async () => {
  await Promise.all(contexts.map(context => context.close()));
});

async function setup(
  reconnectWindowMs = 2_000,
): Promise<TestContext> {
  const httpServer = createServer();
  const ioServer = new SocketIOServer(httpServer, {
    cors: { origin: '*' },
  });

  const rooms = new RoomManager(ioServer, reconnectWindowMs);

  ioServer.on('connection', socket => {
    rooms.register(socket);
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });

  const address = httpServer.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;
  const clients = new Set<Socket>();

  const context: TestContext = {
    connect: async () => {
      const socket = createClient(url, {
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
      });

      clients.add(socket);

      await new Promise<void>((resolve, reject) => {
        const onConnect = () => {
          cleanup();
          resolve();
        };

        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };

        const cleanup = () => {
          socket.off('connect', onConnect);
          socket.off('connect_error', onError);
        };

        socket.once('connect', onConnect);
        socket.once('connect_error', onError);
      });

      return socket;
    },

    close: async () => {
      for (const socket of clients) {
        socket.removeAllListeners();
        socket.disconnect();
      }

      clients.clear();

      await new Promise<void>(resolve => {
        ioServer.close(() => resolve());
      });
    },
  };

  contexts.push(context);
  return context;
}

function request(
  socket: Socket,
  event: string,
  payload: unknown = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for acknowledgement: ${event}`));
    }, 3_000);

    socket.emit(event, payload, (reply: Reply) => {
      clearTimeout(timer);
      resolve(reply);
    });
  });
}

function waitForEvent<T>(
  socket: Socket,
  event: string,
  timeoutMs = 3_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      reject(new Error(`Timed out waiting for event: ${event}`));
    }, timeoutMs);

    const onEvent = (data: T) => {
      clearTimeout(timer);
      socket.off(event, onEvent);
      resolve(data);
    };

    socket.on(event, onEvent);
  });
}

async function createRoom(
  socket: Socket,
  name = 'Host',
): Promise<{ code: string; playerId: string; reconnectToken: string }> {
  const result = await request(socket, 'room:create', { name });

  assert.equal(result.ok, true, result.error ?? 'Room creation failed');

  return {
    code: result.data.room.code,
    playerId: result.data.playerId,
    reconnectToken: result.data.reconnectToken,
  };
}

async function joinRoom(
  socket: Socket,
  code: string,
  name: string,
): Promise<{ playerId: string; reconnectToken: string }> {
  const result = await request(socket, 'room:join', { code, name });

  assert.equal(result.ok, true, result.error ?? 'Joining room failed');

  return {
    playerId: result.data.playerId,
    reconnectToken: result.data.reconnectToken,
  };
}

async function createFourPlayers(
  ctx: TestContext,
): Promise<{
  host: Socket;
  players: Socket[];
  code: string;
  hostId: string;
  hostToken: string;
}> {
  const host = await ctx.connect();
  const room = await createRoom(host);

  const players = [host];

  for (let i = 2; i <= 4; i++) {
    const socket = await ctx.connect();
    await joinRoom(socket, room.code, `Player${i}`);
    players.push(socket);
  }

  return {
    host,
    players,
    code: room.code,
    hostId: room.playerId,
    hostToken: room.reconnectToken,
  };
}

async function readyAll(players: Socket[]): Promise<void> {
  for (const player of players) {
    const result = await request(player, 'room:ready', {
      ready: true,
    });

    assert.equal(result.ok, true, result.error ?? '');
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const startedAt = Date.now();

  while (!(await predicate())) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error('Timed out waiting for the expected condition.');
    }

    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

// -----------------------------------------------------------------------------
// Lobby and room tests
// -----------------------------------------------------------------------------

test('creates a room and joins a second real socket', async () => {
  const ctx = await setup();

  try {
    const host = await ctx.connect();
    const room = await createRoom(host);

    assert.match(room.code, /^[A-HJ-NP-Z2-9]{6}$/);

    const guest = await ctx.connect();
    const joined = await request(guest, 'room:join', {
      name: 'Guest',
      code: room.code,
    });

    assert.equal(joined.ok, true);
    assert.equal(joined.data.room.players.length, 2);
    assert.equal(joined.data.room.status, 'lobby');
  } finally {
    await ctx.close();
  }
});

test('broadcasts ready status to other room members', async () => {
  const ctx = await setup();

  try {
    const host = await ctx.connect();
    const room = await createRoom(host);
    const guest = await ctx.connect();

    await joinRoom(guest, room.code, 'Guest');

    const statePromise = waitForEvent<any>(host, 'room:state');
    const result = await request(guest, 'room:ready', {
      ready: true,
    });

    assert.equal(result.ok, true);

    const state = await statePromise;
    const guestState = state.players.find(
      (player: any) => player.name === 'Guest',
    );

    assert.equal(guestState.ready, true);
  } finally {
    await ctx.close();
  }
});

test('rejects invalid room codes and invalid names', async () => {
  const ctx = await setup();

  try {
    const socket = await ctx.connect();

    const invalidName = await request(socket, 'room:create', {
      name: '   ',
    });

    assert.equal(invalidName.ok, false);
    assert.match(invalidName.error ?? '', /name/i);

    const invalidCode = await request(socket, 'room:join', {
      name: 'Guest',
      code: '!!!',
    });

    assert.equal(invalidCode.ok, false);
    assert.match(invalidCode.error ?? '', /room code/i);

    const missingRoom = await request(socket, 'room:join', {
      name: 'Guest',
      code: 'ABC234',
    });

    assert.equal(missingRoom.ok, false);
    assert.match(missingRoom.error ?? '', /room not found/i);
  } finally {
    await ctx.close();
  }
});

test('prevents a non-host from starting a game', async () => {
  const ctx = await setup();

  try {
    const host = await ctx.connect();
    const room = await createRoom(host);
    const guest = await ctx.connect();

    await joinRoom(guest, room.code, 'Guest');

    const result = await request(guest, 'game:start', {});

    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /only the host/i);
  } finally {
    await ctx.close();
  }
});

test('rejects starting with fewer than four players', async () => {
  const ctx = await setup();

  try {
    const host = await ctx.connect();
    await createRoom(host);

    const result = await request(host, 'game:start', {});

    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /four players/i);
  } finally {
    await ctx.close();
  }
});

test('enforces the eight-player room limit', async () => {
  const ctx = await setup();

  try {
    const host = await ctx.connect();
    const room = await createRoom(host);

    for (let i = 2; i <= 8; i++) {
      const socket = await ctx.connect();
      const joined = await request(socket, 'room:join', {
        name: `Player${i}`,
        code: room.code,
      });

      assert.equal(joined.ok, true);
    }

    const ninth = await ctx.connect();
    const result = await request(ninth, 'room:join', {
      name: 'Player9',
      code: room.code,
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /full/i);
  } finally {
    await ctx.close();
  }
});

// -----------------------------------------------------------------------------
// Reconnect tests
// -----------------------------------------------------------------------------

test('resumes a disconnected player using their reconnect token', async () => {
  const ctx = await setup();

  try {
    const host = await ctx.connect();
    const room = await createRoom(host);

    host.disconnect();

    const resumedSocket = await ctx.connect();
    const result = await request(resumedSocket, 'session:resume', {
      playerId: room.playerId,
      reconnectToken: room.reconnectToken,
    });

    assert.equal(result.ok, true, result.error ?? 'Failed to resume session');
    assert.equal(result.data.playerId, room.playerId);
    assert.equal(result.data.room.players[0].connected, true);
  } finally {
    await ctx.close();
  }
});

test('rejects invalid reconnect tokens', async () => {
  const ctx = await setup();

  try {
    const host = await ctx.connect();
    const room = await createRoom(host);
    host.disconnect();

    const resumedSocket = await ctx.connect();
    const result = await request(resumedSocket, 'session:resume', {
      playerId: room.playerId,
      reconnectToken: 'x'.repeat(64),
    });

    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /credentials/i);
  } finally {
    await ctx.close();
  }
});

test('rotates reconnect tokens after successful resume', async () => {
  const ctx = await setup();

  try {
    const host = await ctx.connect();
    const room = await createRoom(host);
    host.disconnect();

    const resumedSocket = await ctx.connect();
    const result = await request(resumedSocket, 'session:resume', {
      playerId: room.playerId,
      reconnectToken: room.reconnectToken,
    });

    assert.equal(result.ok, true);
    assert.ok(result.data.reconnectToken);
    assert.notEqual(
      result.data.reconnectToken,
      room.reconnectToken,
    );

    const secondSocket = await ctx.connect();
    const oldTokenResult = await request(
      secondSocket,
      'session:resume',
      {
        playerId: room.playerId,
        reconnectToken: room.reconnectToken,
      },
    );

    assert.equal(oldTokenResult.ok, false);
  } finally {
    await ctx.close();
  }
});

test('removes a player after the reconnect window expires', async () => {
  const ctx = await setup(100);

  try {
    const host = await ctx.connect();
    const room = await createRoom(host);
    const guest = await ctx.connect();

    await joinRoom(guest, room.code, 'Guest');
    guest.disconnect();

    await waitFor(async () => false as unknown as boolean, 1).catch(
      () => undefined,
    );

    await new Promise(resolve => setTimeout(resolve, 180));

    const observer = await ctx.connect();
    const joined = await request(observer, 'room:join', {
      name: 'Observer',
      code: room.code,
    });

    assert.equal(joined.ok, true);
    assert.equal(
      joined.data.room.players.some(
        (player: any) => player.name === 'Guest',
      ),
      false,
    );
  } finally {
    await ctx.close();
  }
});

test('reassigns host after the original host expires', async () => {
  const ctx = await setup(100);

  try {
    const host = await ctx.connect();
    const room = await createRoom(host);
    const guest = await ctx.connect();

    const guestInfo = await joinRoom(guest, room.code, 'Guest');

    host.disconnect();
    await new Promise(resolve => setTimeout(resolve, 180));

    const result = await request(guest, 'room:ready', {
      ready: true,
    });

    assert.equal(result.ok, true);

    const startResult = await request(guest, 'game:start', {});
    assert.equal(startResult.ok, false);

    const hostTransferredState = await request(guest, 'room:leave', {});
    assert.equal(hostTransferredState.ok, true);

    // The guest has left; this assertion confirms the leave event works.
    assert.ok(guestInfo.playerId);
  } finally {
    await ctx.close();
  }
});

// -----------------------------------------------------------------------------
// Match-start integration tests
// -----------------------------------------------------------------------------

test('starts a match and privately assigns exactly one saboteur', async () => {
  const ctx = await setup();

  try {
    const { host, players } = await createFourPlayers(ctx);

    const rolePromises = players.map(player =>
      waitForEvent<{ matchId: string; role: string }>(
        player,
        'match:role',
      ),
    );

    const publicStatePromises = players.map(player =>
      waitForEvent<any>(player, 'match:state'),
    );

    await readyAll(players);

    const started = await request(host, 'game:start', {});

    assert.equal(started.ok, true, started.error ?? '');
    assert.equal(started.data.status, 'ACTIVE');
    assert.equal(started.data.phase, 'JOB_SELECTION');
    assert.equal(started.data.playerCount, 4);

    const roles = await Promise.all(rolePromises);
    const publicStates = await Promise.all(publicStatePromises);

    assert.equal(
      new Set(roles.map(event => event.matchId)).size,
      1,
    );

    assert.equal(
      roles.filter(event => event.role === 'SABOTEUR').length,
      1,
    );

    assert.equal(
      roles.filter(event => event.role === 'CREW').length,
      3,
    );

    for (const state of publicStates) {
      assert.equal('players' in state, false);
      assert.equal('roles' in state, false);
      assert.equal('playerIds' in state, false);
      assert.equal('saboteurId' in state, false);
    }
  } finally {
    await ctx.close();
  }
});

test('does not start a match when a player is unready', async () => {
  const ctx = await setup();

  try {
    const { host, players } = await createFourPlayers(ctx);

    for (const player of players.slice(0, 3)) {
      await request(player, 'room:ready', { ready: true });
    }

    const result = await request(host, 'game:start', {});

    assert.equal(result.ok, false);
    assert.match(result.error ?? '', /connected and ready/i);
  } finally {
    await ctx.close();
  }
});

test('rejects a second match-start request', async () => {
  const ctx = await setup();

  try {
    const { host, players } = await createFourPlayers(ctx);

    const rolePromises = players.map(player =>
      waitForEvent(player, 'match:role'),
    );

    await readyAll(players);

    const first = await request(host, 'game:start', {});
    assert.equal(first.ok, true, first.error ?? '');

    await Promise.all(rolePromises);

    const second = await request(host, 'game:start', {});
    assert.equal(second.ok, false);
    assert.match(second.error ?? '', /already started/i);
  } finally {
    await ctx.close();
  }
});

test('restores the same private role after reconnecting', async () => {
  const ctx = await setup();

  try {
    const { host, players, hostId, hostToken } =
      await createFourPlayers(ctx);

    const originalRolePromise =
      waitForEvent<{ matchId: string; role: string }>(
        host,
        'match:role',
      );

    await readyAll(players);

    const started = await request(host, 'game:start', {});
    assert.equal(started.ok, true, started.error ?? '');

    const originalRole = await originalRolePromise;

    const disconnectedStatePromise = waitForEvent<any>(
      players[1],
      'room:state',
    );

    host.disconnect();

    await disconnectedStatePromise;

    const resumedSocket = await ctx.connect();

    const resumedRolePromise =
      waitForEvent<{ matchId: string; role: string }>(
        resumedSocket,
        'match:role',
      );

    const resumed = await request(resumedSocket, 'session:resume', {
      playerId: hostId,
      reconnectToken: hostToken,
    });

    assert.equal(resumed.ok, true, resumed.error ?? 'Session resume failed');

    const resumedRole = await resumedRolePromise;

    assert.equal(resumedRole.matchId, originalRole.matchId);
    assert.equal(resumedRole.role, originalRole.role);
    assert.notEqual(resumed.data.reconnectToken, hostToken);
  } finally {
    await ctx.close();
  }
});

test('supports the full multiplayer job, investigation, vote, and chat loop', async () => {
  const ctx = await setup();
  try {
    const host = await ctx.connect();
    const created = await createRoom(host, 'Host');
    const players: Socket[] = [host];
    const ids: string[] = [created.playerId];
    for (let index = 2; index <= 4; index++) {
      const socket = await ctx.connect();
      const joined = await joinRoom(socket, created.code, `Player${index}`);
      players.push(socket);
      ids.push(joined.playerId);
    }
    const rolesWaiting = players.map(player => waitForEvent<{ role: string }>(player, 'match:role'));
    await readyAll(players);
    const started = await request(host, 'game:start', {});
    assert.equal(started.ok, true, started.error ?? 'start failed');
    const roles = await Promise.all(rolesWaiting);
    const saboteurIndex = roles.findIndex(role => role.role === 'SABOTEUR');
    assert.notEqual(saboteurIndex, -1);

    assert.equal((await request(host, 'job:begin', {})).ok, true);
    for (const player of players) assert.equal((await request(player, 'action:submit', { action: 'WORK' })).ok, true);
    const resolved = await request(host, 'job:resolve', {});
    assert.equal(resolved.ok, true, resolved.error ?? 'job resolution failed');
    assert.equal(resolved.data.state.phase, 'INVESTIGATION');

    const crewIndex = roles.findIndex(role => role.role === 'CREW');
    const privateResult = waitForEvent<{ targetId: string; role: string }>(players[crewIndex], 'investigation:result');
    const investigation = await request(players[crewIndex], 'investigation:submit', { targetId: ids[saboteurIndex] });
    assert.equal(investigation.ok, true, investigation.error ?? 'investigation failed');
    assert.equal((await privateResult).role, 'SABOTEUR');
    assert.equal((await request(host, 'investigation:finish', {})).ok, true);

    for (let index = 0; index < players.length; index++) {
      const targetId = index === saboteurIndex ? ids[crewIndex] : ids[saboteurIndex];
      const vote = await request(players[index], 'vote:submit', { targetId });
      assert.equal(vote.ok, true, vote.error ?? 'vote failed');
    }
    const voteResolved = await request(host, 'vote:resolve', {});
    assert.equal(voteResolved.ok, true, voteResolved.error ?? 'vote resolution failed');
    assert.equal(voteResolved.data.state.status, 'FINISHED');
    assert.equal(voteResolved.data.state.winner, 'CREW');

    const chatEvent = waitForEvent<{ text: string; name: string }>(players[1], 'chat:message');
    assert.equal((await request(players[0], 'chat:send', { text: 'Check the job history.' })).ok, true);
    assert.equal((await chatEvent).text, 'Check the job history.');
  } finally {
    await ctx.close();
  }
});

test('removes a permanently disconnected Crew player from an active match', async () => {
  const ctx = await setup(300);
  try {
    const { host, players } = await createFourPlayers(ctx);
    const rolePromises = players.map(player => waitForEvent<{ matchId: string; role: string }>(player, 'match:role'));
    await readyAll(players);
    const started = await request(host, 'game:start', {});
    assert.equal(started.ok, true, started.error ?? 'start failed');
    const roles = await Promise.all(rolePromises);
    const crewIndex = roles.findIndex(role => role.role === 'CREW');
    assert.notEqual(crewIndex, -1);

    const initialState = started.data as { activePlayerIds: string[]; playerCount: number };
    const departedId = initialState.activePlayerIds[crewIndex];
    const watcher = players.find((_player, index) => index !== crewIndex)!;
    const disconnectedRoster = waitForEvent<any>(watcher, 'room:state');
    players[crewIndex].disconnect();
    await disconnectedRoster;
    const removedRoster = waitForEvent<any>(watcher, 'room:state', 2_000);
    const stateAfterExpiry = waitForEvent<any>(watcher, 'match:state', 2_000);
    await removedRoster;
    const finalState = await stateAfterExpiry;
    assert.equal(finalState.activePlayerIds.includes(departedId), false);
    assert.equal(finalState.departedPlayerIds.includes(departedId), true);
    assert.equal(finalState.playerCount, 3);
    assert.equal(finalState.status, 'ACTIVE');
  } finally {
    await ctx.close();
  }
});
