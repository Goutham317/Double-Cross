
import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import './App.css';

const SERVER_URL = 'http://localhost:3001';
const SESSION_KEY = 'double-cross-session';

type Player = {
  id: string;
  name: string;
  ready: boolean;
  connected: boolean;
  isHost: boolean;
};

type Room = {
  code: string;
  hostId: string;
  status: 'lobby' | 'playing' | 'finished';
  capacity: number;
  players: Player[];
};

type Response<T = unknown> = {
  ok: boolean;
  data?: T;
  error?: string;
};

type SessionData = {
  room: Room;
  playerId: string;
  reconnectToken: string;
};

type SavedSession = {
  playerId: string;
  reconnectToken: string;
};

type MatchRole = 'CREW' | 'SABOTEUR';

type MatchState = {
  matchId: string;
  status: 'ACTIVE' | 'FINISHED';
  phase: 'PREPARING' | 'JOB_SELECTION' | 'DISCUSSION' | 'ACTIONS' | 'RESOLUTION' | 'INVESTIGATION' | 'VOTING' | 'FINISHED';
  currentJob: number;
  playerCount: number;
  activePlayerIds: string[];
  departedPlayerIds: string[];
  ejectedPlayerIds: string[];
  players?: { id: string; name: string; connected: boolean; role?: MatchRole; active: boolean; removalReason?: 'DISCONNECTED' | 'EJECTED' }[];
  completedJobs: { jobNumber: number; success: boolean; workPoints: number; difficulty: number; sabotageAttempts?: number; guarded?: boolean; message?: string }[];
  crewWins: number;
  saboteurWins: number;
  actionCount: number;
  investigationCount: number;
  voteCount: number;
  voteResult: { votes: number; validVotes: number; targetId: string | null; targetName: string | null; ejected: boolean; message: string } | null;
  winner: MatchRole | null;
};

type ChatMessage = { id: string; playerId: string; name: string; text: string; sentAt: number };

type PrivateRoleMessage = {
  matchId: string;
  role: MatchRole;
};

function saveSession(session: SavedSession): void {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // The current session can still work without browser storage.
  }
}

function loadSession(): SavedSession | null {
  try {
    const saved = sessionStorage.getItem(SESSION_KEY);
    if (!saved) return null;

    const parsed: unknown = JSON.parse(saved);

    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'playerId' in parsed &&
      'reconnectToken' in parsed &&
      typeof parsed.playerId === 'string' &&
      typeof parsed.reconnectToken === 'string'
    ) {
      return {
        playerId: parsed.playerId,
        reconnectToken: parsed.reconnectToken,
      };
    }
  } catch {
    clearSession();
  }

  return null;
}

function clearSession(): void {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Ignore unavailable browser storage.
  }
}

function App() {
  const socketRef = useRef<Socket | null>(null);
  const attemptRef = useRef(0);
  const mountedRef = useRef(false);
  const startingRef = useRef(false);

  const [name, setName] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [room, setRoom] = useState<Room | null>(null);
  const [playerId, setPlayerId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [connected, setConnected] = useState(false);
  const [notice, setNotice] = useState('');

  const [matchState, setMatchState] = useState<MatchState | null>(null);
  const [privateRole, setPrivateRole] = useState<MatchRole | null>(null);
  const [startingGame, setStartingGame] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatText, setChatText] = useState('');
  const [selectedTarget, setSelectedTarget] = useState('');
  const [actionSubmittedFor, setActionSubmittedFor] = useState('');
  const [voteSubmittedFor, setVoteSubmittedFor] = useState('');
  const [investigationResult, setInvestigationResult] = useState<{ targetId: string; role: MatchRole } | null>(null);
  const [investigationSubmittedFor, setInvestigationSubmittedFor] = useState('');
  const [jobResultNotice, setJobResultNotice] = useState('');

  const emitRequest = useCallback(
    <T,>(
      event: string,
      payload: Record<string, unknown>,
    ): Promise<Response<T>> => {
      const socket = socketRef.current;

      if (!socket?.connected) {
        return Promise.reject(
          new Error('Not connected to the game server.'),
        );
      }

      return new Promise((resolve, reject) => {
        socket.timeout(5000).emit(
          event,
          payload,
          (timeoutError: Error | null, result: Response<T>) => {
            if (timeoutError) {
              reject(new Error('Server did not respond. Please try again.'));
              return;
            }

            resolve(result);
          },
        );
      });
    },
    [],
  );

  useEffect(() => {
    mountedRef.current = true;

    const socket = io(SERVER_URL, {
      autoConnect: false,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    socketRef.current = socket;

    const handleConnect = async () => {
      if (!mountedRef.current) return;

      setConnected(true);

      const saved = loadSession();
      if (!saved) return;

      const attempt = ++attemptRef.current;
      setNotice('Restoring your previous session...');

      try {
        const result = await new Promise<Response<SessionData>>(
          (resolve, reject) => {
            socket.timeout(5000).emit(
              'session:resume',
              {
                playerId: saved.playerId,
                reconnectToken: saved.reconnectToken,
              },
              (
                timeoutError: Error | null,
                response: Response<SessionData>,
              ) => {
                if (timeoutError) {
                  reject(timeoutError);
                } else {
                  resolve(response);
                }
              },
            );
          },
        );

        if (
          !mountedRef.current ||
          attempt !== attemptRef.current
        ) {
          return;
        }

        if (!result.ok || !result.data) {
          clearSession();
          setRoom(null);
          setPlayerId('');
          setRoomCode('');
          setMatchState(null);
          setPrivateRole(null);
          setNotice('');
          setError(
            result.error ?? 'Your previous session could not be restored.',
          );
          return;
        }

        saveSession({
          playerId: result.data.playerId,
          reconnectToken: result.data.reconnectToken,
        });

        setPlayerId(result.data.playerId);
        setRoom(result.data.room);
        setRoomCode(result.data.room.code);
        setError('');
        setNotice('Successfully reconnected to your crew.');
      } catch {
        if (
          mountedRef.current &&
          attempt === attemptRef.current
        ) {
          setNotice(
            'Unable to restore your session. Waiting for a stable connection...',
          );
        }
      }
    };

    const handleDisconnect = () => {
      attemptRef.current += 1;
      setConnected(false);

      if (loadSession()) {
        setNotice('Connection lost. Waiting to reconnect...');
      }
    };

    const handleRoomState = (updatedRoom: Room) => {
      if (!mountedRef.current) return;

      setRoom(currentRoom => {
        if (
          currentRoom &&
          currentRoom.code !== updatedRoom.code
        ) {
          return currentRoom;
        }

        return updatedRoom;
      });

      // If the server says the room is playing, the lobby must not
      // remain visible while waiting for the match state event.
      if (updatedRoom.status === 'playing') {
        setNotice('');
        setError('');
      }
    };

    const handleMatchState = (state: MatchState) => {
      if (!mountedRef.current) return;

      setMatchState(state);
      setError('');
      setNotice('');
    };

    const handleChatMessage = (message: ChatMessage) => {
      if (!mountedRef.current) return;
      setChatMessages(current => [...current.slice(-79), message]);
    };

    const handleInvestigationResult = (result: { targetId: string; role: MatchRole }) => {
      if (!mountedRef.current) return;
      setInvestigationResult(result);
    };

    const handleJobResult = (result: { jobNumber: number; success: boolean; message: string }) => {
      if (!mountedRef.current) return;
      setJobResultNotice(`JOB ${result.jobNumber}: ${result.success ? 'SUCCESS' : 'FAILED'} — ${result.message}`);
    };

    const handleMatchRole = (message: PrivateRoleMessage) => {
      if (!mountedRef.current) return;

      if (
        message.role === 'CREW' ||
        message.role === 'SABOTEUR'
      ) {
        setPrivateRole(message.role);
      }
    };

    socket.on('connect', handleConnect);
    socket.on('disconnect', handleDisconnect);
    socket.on('room:state', handleRoomState);
    socket.on('match:state', handleMatchState);
    socket.on('match:role', handleMatchRole);
    socket.on('chat:message', handleChatMessage);
    socket.on('investigation:result', handleInvestigationResult);
    socket.on('job:result', handleJobResult);

    socket.connect();

    return () => {
      mountedRef.current = false;
      attemptRef.current += 1;

      socket.off('connect', handleConnect);
      socket.off('disconnect', handleDisconnect);
      socket.off('room:state', handleRoomState);
      socket.off('match:state', handleMatchState);
      socket.off('match:role', handleMatchRole);
      socket.off('chat:message', handleChatMessage);
      socket.off('investigation:result', handleInvestigationResult);
      socket.off('job:result', handleJobResult);

      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  async function createRoom() {
    if (!name.trim()) {
      setError('Enter your player name first.');
      return;
    }

    setBusy(true);
    setError('');
    setNotice('');
    setMatchState(null);
    setPrivateRole(null);

    try {
      const result = await emitRequest<SessionData>('room:create', {
        name,
      });

      if (!result.ok || !result.data) {
        setError(result.error ?? 'Could not create the room.');
        return;
      }

      saveSession({
        playerId: result.data.playerId,
        reconnectToken: result.data.reconnectToken,
      });

      setPlayerId(result.data.playerId);
      setRoom(result.data.room);
      setRoomCode(result.data.room.code);
      setNotice('Room created. Share the code with your friends.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  async function joinRoom() {
    if (!name.trim()) {
      setError('Enter your player name first.');
      return;
    }

    if (!roomCode.trim()) {
      setError('Enter a room code.');
      return;
    }

    setBusy(true);
    setError('');
    setNotice('');

    try {
      const result = await emitRequest<SessionData>('room:join', {
        name,
        code: roomCode.trim().toUpperCase(),
      });

      if (!result.ok || !result.data) {
        setError(result.error ?? 'Could not join the room.');
        return;
      }

      saveSession({
        playerId: result.data.playerId,
        reconnectToken: result.data.reconnectToken,
      });

      setPlayerId(result.data.playerId);
      setRoom(result.data.room);
      setRoomCode(result.data.room.code);
      setMatchState(null);
      setPrivateRole(null);
      setNotice('You joined the room.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  async function toggleReady() {
    if (!room || !playerId) return;

    const me = room.players.find(player => player.id === playerId);

    if (!me) {
      setError('Your player session is not in this room.');
      return;
    }

    setError('');

    try {
      const result = await emitRequest('room:ready', {
        ready: !me.ready,
      });

      if (!result.ok) {
        setError(result.error ?? 'Could not update ready status.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    }
  }

  async function startGame() {
    if (
      startingRef.current ||
      !room ||
      room.status !== 'lobby'
    ) {
      return;
    }

    startingRef.current = true;
    setStartingGame(true);
    setError('');
    setNotice('');

    try {
      const result = await emitRequest<MatchState>('game:start', {});

      if (!result.ok || !result.data) {
        setError(result.error ?? 'The game could not start.');
        return;
      }

      // The server acknowledgement contains the authoritative public state.
      setMatchState(result.data);
      setError('');
      setNotice('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The game could not start.');
    } finally {
      startingRef.current = false;
      setStartingGame(false);
    }
  }

  async function leaveRoom() {
    setError('');
    setNotice('');

    try {
      const result = await emitRequest<{ left: boolean }>(
        'room:leave',
        {},
      );

      if (!result.ok) {
        setError(result.error ?? 'Could not leave the room.');
        return;
      }

      clearSession();
      setRoom(null);
      setPlayerId('');
      setRoomCode('');
      setMatchState(null);
      setPrivateRole(null);
      setNotice('You have left the room.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not leave the room.');
    }
  }



  const me = room?.players.find(player => player.id === playerId);
  const isHost = Boolean(me?.isHost);
  const eligibleTargets = room?.players.filter(player => player.id !== playerId && (matchState?.activePlayerIds.includes(player.id) ?? true)) ?? [];
  const isActiveMatchPlayer = matchState ? matchState.activePlayerIds.includes(playerId) : true;
  const phaseKey = `${matchState?.currentJob ?? 1}-${matchState?.phase ?? 'PREPARING'}`;
  const actionSubmitted = actionSubmittedFor === phaseKey;
  const voteSubmitted = voteSubmittedFor === phaseKey;
  const investigationSubmitted = investigationSubmittedFor === phaseKey;

  async function performMatchRequest(event: string, payload: Record<string, unknown> = {}) {
    setError('');
    try {
      const result = await emitRequest(event, payload);
      if (!result.ok) setError(result.error ?? 'That action could not be completed.');
      return result.ok;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That action could not be completed.');
      return false;
    }
  }

  async function submitAction(action: 'WORK' | 'GUARD' | 'SABOTAGE') {
    const targetRequired = action === 'GUARD';
    if (targetRequired && !selectedTarget) { setError('Choose a player for this action.'); return; }
    const ok = await performMatchRequest('action:submit', { action, ...(targetRequired ? { targetId: selectedTarget } : {}) });
    if (ok) { setActionSubmittedFor(phaseKey); setInvestigationResult(null); }
  }

  async function sendChat(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = chatText.trim();
    if (!text) return;
    const ok = await performMatchRequest('chat:send', { text });
    if (ok) setChatText('');
  }

  async function investigate() {
    if (!selectedTarget) { setError('Choose a player to investigate.'); return; }
    const ok = await performMatchRequest('investigation:submit', { targetId: selectedTarget });
    if (ok) setInvestigationSubmittedFor(phaseKey);
  }

  async function castVote(targetId: string | null = selectedTarget) {
    if (targetId !== null && !targetId) { setError('Choose a player to vote for or abstain.'); return; }
    const ok = await performMatchRequest('vote:submit', { targetId });
    if (ok) setVoteSubmittedFor(phaseKey);
  }


  const allReady = Boolean(
    room &&
      room.players.length >= 4 &&
      room.players.every(
        player => player.connected && player.ready,
      ),
  );

  // A playing room or a match event moves the UI out of the lobby.
  const matchStarted =
    Boolean(matchState) || room?.status === 'playing';

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Double Cross home">
          <span className="brand-mark">DC</span>
          <span>DOUBLE CROSS</span>
        </a>

        <div className={`connection ${connected ? 'online' : 'offline'}`}>
          <span className="connection-dot" />
          {connected ? 'SERVER CONNECTED' : 'CONNECTING TO SERVER'}
        </div>
      </header>

      {!room ? (
        <section className="landing">
          <div className="eyebrow">
            <span className="eyebrow-line" />
            TRUST NO ONE
            <span className="eyebrow-line" />
          </div>

          <h1>
            Every crew
            <br />
            has a <span>traitor.</span>
          </h1>

          <p className="intro">
            Work together. Complete the jobs. Find out who is playing
            both sides before it is too late.
          </p>

          <div className="panel entry-panel">
            <label htmlFor="player-name">YOUR CODENAME</label>
            <input
              id="player-name"
              value={name}
              onChange={event => setName(event.target.value)}
              onKeyDown={event => {
                if (event.key === 'Enter') void createRoom();
              }}
              maxLength={18}
              placeholder="Enter your name"
              autoComplete="nickname"
            />

            <button
              className="primary-button"
              disabled={busy || !connected}
              onClick={() => void createRoom()}
            >
              {busy ? 'PLEASE WAIT...' : 'CREATE A ROOM'}
              <span>↗</span>
            </button>

            <div className="separator">
              <span />
              OR JOIN AN EXISTING CREW
              <span />
            </div>

            <div className="join-row">
              <input
                aria-label="Room code"
                value={roomCode}
                onChange={event =>
                  setRoomCode(event.target.value.toUpperCase().slice(0, 6))
                }
                maxLength={6}
                placeholder="ROOM CODE"
                autoComplete="off"
              />

              <button
                className="secondary-button"
                disabled={busy || !connected}
                onClick={() => void joinRoom()}
              >
                JOIN
              </button>
            </div>
          </div>

          <div className="game-facts">
            <div>
              <strong>04–08</strong>
              <span>PLAYERS</span>
            </div>
            <div>
              <strong>01</strong>
              <span>TRAITOR</span>
            </div>
            <div>
              <strong>04</strong>
              <span>JOBS</span>
            </div>
          </div>

          {notice && <p className="notice">{notice}</p>}
          {error && <p className="error-message">{error}</p>}
        </section>
      ) : matchStarted ? (
        <section className="lobby game-screen">
          <div className="lobby-heading">
            <div>
              <div className="eyebrow left-eyebrow">LIVE OPERATION · JOB {matchState?.currentJob ?? 1} OF 4</div>
              <h1>{matchState?.phase === 'FINISHED' ? 'Operation ' : 'Trust is a '}<span>{matchState?.phase === 'FINISHED' ? 'complete.' : 'liability.'}</span></h1>
              <p>{matchState?.phase === 'FINISHED' ? 'The final outcome has been confirmed.' : 'Work together. Watch the evidence. Choose who to trust.'}</p>
            </div>
            <div className="room-code-card"><span>ROOM CODE</span><strong>{room.code}</strong><span>{matchState?.phase?.replaceAll('_', ' ') ?? 'CONNECTING'}</span></div>
          </div>

          {matchState?.phase === 'FINISHED' ? (
            <div className="panel endgame-panel">
              <span className="section-label">FINAL DEBRIEF</span>
              <h2>{matchState.winner === 'CREW' ? 'CREW VICTORY' : 'SABOTEUR VICTORY'}</h2>
              <p>{matchState.winner === 'CREW' ? 'The operation survived. The crew completed enough jobs or identified the saboteur.' : 'The operation was compromised. The saboteur achieved their objective.'}</p>{matchState.voteResult && <p className="investigation-result">Final vote: {matchState.voteResult.message}</p>}
              <div className="score-row"><div><span>CREW WINS</span><strong>{matchState.crewWins}</strong></div><div><span>SABOTEUR WINS</span><strong>{matchState.saboteurWins}</strong></div></div>
              <h3>JOB HISTORY</h3>
              {matchState.completedJobs.map(job => <div className="mission-stat" key={job.jobNumber}><span>JOB {job.jobNumber} · {job.workPoints}/{job.difficulty} WORK</span><strong>{job.success ? 'SUCCESS' : 'FAILED'}</strong></div>)}
              <p className="role-reveal">The saboteur was: <strong>{matchState.players?.find(player => player.role === 'SABOTEUR')?.name ?? 'Unknown'}</strong></p><div className="player-list">{(matchState.players ?? []).map(player => <div className="player-row" key={player.id}><div className="player-avatar">{player.name.slice(0,2).toUpperCase()}</div><div className="player-details"><strong>{player.name}{player.id === playerId ? <span className="you-tag">YOU</span> : null}</strong><span>{player.role ?? 'UNKNOWN'}{!player.active ? ` · ${player.removalReason === 'EJECTED' ? 'EJECTED' : 'LEFT MATCH'}` : ''}</span></div><span className={`ready-status ${player.role === 'SABOTEUR' || !player.active ? 'status-disconnected' : 'status-ready'}`}>{!player.active ? (player.removalReason === 'EJECTED' ? 'EJECTED' : 'LEFT') : (player.role ?? 'UNKNOWN')}</span></div>)}</div>
              <button className="secondary-button start-button" onClick={() => void leaveRoom()}>LEAVE MATCH</button>
            </div>
          ) : (
            <div className="game-layout">
              {!isActiveMatchPlayer ? <div className="panel game-phase-panel"><span className="section-label">SPECTATOR STATUS</span><h2>You are out of this operation.</h2><p>You have been removed from active play. You can still follow the match and use team chat while the remaining players finish.</p><div className="mission-stat"><span>YOUR STATUS</span><strong>{matchState?.ejectedPlayerIds.includes(playerId) ? 'EJECTED' : 'LEFT MATCH'}</strong></div></div> : <div className="game-main-column">
                <div className="panel game-phase-panel">
                  <div className="panel-heading"><div><span className="section-label">YOUR CLASSIFICATION</span><h2>{privateRole === 'SABOTEUR' ? 'Saboteur' : privateRole === 'CREW' ? 'Crew Member' : 'Role pending'}</h2></div><span className="player-count">{matchState?.crewWins ?? 0}–{matchState?.saboteurWins ?? 0}</span></div>
                  <p>{privateRole === 'SABOTEUR' ? 'Blend in. Sabotage jobs without exposing yourself.' : 'Help the crew finish jobs and identify suspicious players.'}</p>
                  <div className="score-row"><div><span>CREW JOBS</span><strong>{matchState?.crewWins ?? 0}/3</strong></div><div><span>SABOTEUR JOBS</span><strong>{matchState?.saboteurWins ?? 0}/3</strong></div></div>
                  <div className="phase-progress">{['JOB_SELECTION','ACTIONS','INVESTIGATION','VOTING'].map((phase, index) => <div className={`phase-step ${matchState?.phase === phase ? 'active' : ''} ${matchState && ['FINISHED'].includes(matchState.phase) ? 'complete' : ''}`} key={phase}><span>{String(index + 1).padStart(2,'0')}</span><small>{phase.replaceAll('_',' ')}</small></div>)}</div>
                  {jobResultNotice && <p className="notice">{jobResultNotice}</p>}
                  {matchState?.phase === 'JOB_SELECTION' && <div className="phase-action-area">{matchState.voteResult && <p className="investigation-result">Previous vote: {matchState.voteResult.message}</p>}<h3>Prepare for the next job</h3><p>Discuss what happened last round. The host starts the action phase when everyone is ready.</p>{isHost ? <button className="primary-button" onClick={() => void performMatchRequest('job:begin')}>BEGIN JOB ACTIONS <span>↗</span></button> : <p className="lobby-hint">Waiting for the host to begin the job.</p>}</div>}
                  {matchState?.phase === 'ACTIONS' && <div className="phase-action-area"><h3>Choose your action</h3><p>Your choice is private. Submit once per job. Every active player must submit before the host can resolve it.</p>{!actionSubmitted ? <><div className="target-row"><label htmlFor="action-target">TARGET (GUARD ONLY)</label><select id="action-target" value={selectedTarget} onChange={event => setSelectedTarget(event.target.value)} disabled={privateRole !== 'CREW'}><option value="">Choose a player</option>{eligibleTargets.map(player => <option key={player.id} value={player.id}>{player.name}</option>)}</select></div><div className="action-grid"><button className="action-card" onClick={() => void submitAction('WORK')}><strong>WORK</strong><span>Contribute to completing the job.</span></button>{privateRole === 'SABOTEUR' ? <button className="action-card danger-action" onClick={() => void submitAction('SABOTAGE')}><strong>SABOTAGE</strong><span>Try to compromise this job.</span></button> : <button className="action-card" onClick={() => void submitAction('GUARD')}><strong>GUARD</strong><span>Protect one active player and cancel one sabotage attempt.</span></button>}</div></> : <p className="notice">Action submitted. Waiting for the rest of the players ({matchState.actionCount}/{matchState.playerCount}).</p>}{isHost && <button className="secondary-button start-button" disabled={matchState.actionCount < matchState.playerCount} onClick={() => void performMatchRequest('job:resolve')}>RESOLVE JOB</button>}</div>}
                  {matchState?.phase === 'INVESTIGATION' && <div className="phase-action-area"><h3>Investigate the crew</h3><p>Crew members can inspect one player privately. Discuss your suspicions before voting.</p>{privateRole === 'CREW' && !investigationSubmitted ? <><div className="target-row"><label htmlFor="investigate-target">INVESTIGATE PLAYER</label><select id="investigate-target" value={selectedTarget} onChange={event => setSelectedTarget(event.target.value)}><option value="">Choose a player</option>{eligibleTargets.map(player => <option key={player.id} value={player.id}>{player.name}</option>)}</select></div><button className="primary-button" onClick={() => void investigate()}>INVESTIGATE <span>↗</span></button></> : privateRole === 'SABOTEUR' ? <p>You cannot investigate. Use the discussion to misdirect suspicion.</p> : <p>Investigation submitted.</p>}{investigationResult && <p className="investigation-result">Result: <strong>{room.players.find(player => player.id === investigationResult.targetId)?.name ?? 'Player'}</strong> is {investigationResult.role === 'SABOTEUR' ? 'the SABOTEUR' : 'CREW'}.</p>}{isHost && <button className="secondary-button start-button" onClick={() => void performMatchRequest('investigation:finish')}>CLOSE INVESTIGATION & VOTE</button>}</div>}
                  {matchState?.phase === 'VOTING' && <div className="phase-action-area"><h3>Vote out a suspected saboteur</h3><p>Choose one other active player or abstain. Votes stay private until the host resolves the ballot. An ejection requires a strict majority of valid votes.</p>{!voteSubmitted ? <><div className="target-row"><label htmlFor="vote-target">YOUR VOTE</label><select id="vote-target" value={selectedTarget} onChange={event => setSelectedTarget(event.target.value)}><option value="">Choose a player</option>{eligibleTargets.map(player => <option key={player.id} value={player.id}>{player.name}</option>)}</select></div><button className="primary-button" onClick={() => void castVote()}>SUBMIT VOTE <span>↗</span></button><button className="secondary-button start-button" onClick={() => void castVote(null)}>ABSTAIN</button></> : <p className="notice">Vote submitted ({matchState.voteCount}/{matchState.playerCount}).</p>}{isHost && <button className="secondary-button start-button" disabled={matchState.voteCount < matchState.playerCount} onClick={() => void performMatchRequest('vote:resolve')}>REVEAL VOTE RESULT</button>}{matchState.voteResult && <p className="investigation-result">{matchState.voteResult.message}</p>}</div>}
                </div>
                <div className="panel roster-panel"><div className="panel-heading"><div><span className="section-label">THE CREW</span><h2>Players</h2></div><span className="player-count">{matchState?.playerCount ?? room.players.length}</span></div><div className="player-list">{room.players.map((player, index) => <div className="player-row" key={player.id}><div className="player-avatar">{String(index + 1).padStart(2,'0')}</div><div className="player-details"><strong>{player.name}{player.id === playerId && <span className="you-tag">YOU</span>}</strong><span>{matchState && !matchState.activePlayerIds.includes(player.id) ? (matchState.ejectedPlayerIds.includes(player.id) ? 'EJECTED' : 'LEFT MATCH') : player.connected ? 'CONNECTED' : 'DISCONNECTED'}</span></div><span className={`ready-status ${matchState && !matchState.activePlayerIds.includes(player.id) ? 'status-disconnected' : player.connected ? 'status-ready' : 'status-disconnected'}`}>{matchState && !matchState.activePlayerIds.includes(player.id) ? (matchState.ejectedPlayerIds.includes(player.id) ? 'EJECTED' : 'LEFT') : player.connected ? 'ONLINE' : 'OFFLINE'}</span></div>)}</div></div>
              </div>}
              <aside className="panel chat-panel"><div className="panel-heading"><div><span className="section-label">OPEN CHANNEL</span><h2>Team chat</h2></div><span className="player-count">LIVE</span></div><div className="chat-messages" aria-live="polite">{chatMessages.length === 0 ? <p className="chat-empty">No messages yet. Discuss your suspicions with the crew.</p> : chatMessages.map(message => <div className="chat-message" key={message.id}><div><strong>{message.name}</strong><time>{new Date(message.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div><p>{message.text}</p></div>)}</div><form className="chat-form" onSubmit={event => void sendChat(event)}><input value={chatText} onChange={event => setChatText(event.target.value.slice(0,240))} maxLength={240} placeholder="Send a message…" aria-label="Chat message"/><button className="primary-button" type="submit" disabled={!chatText.trim()}>SEND</button></form><div className="mission-stat"><span>JOB HISTORY</span><strong>{matchState?.completedJobs.length ?? 0}/4</strong></div>{matchState?.completedJobs.map(job => <div className="mission-stat" key={job.jobNumber}><span>JOB {job.jobNumber}</span><strong>{job.success ? 'SUCCESS' : 'FAILED'}</strong></div>)}<button className="secondary-button start-button" disabled={!connected} onClick={() => void leaveRoom()}>LEAVE MATCH</button></aside>
            </div>
          )}
          {notice && <p className="notice">{notice}</p>}{error && <p className="error-message">{error}</p>}
        </section>
      ) : (
        <section className="lobby">
          <div className="lobby-heading">
            <div>
              <div className="eyebrow left-eyebrow">PRE-GAME LOBBY</div>
              <h1>
                Assemble your <span>crew.</span>
              </h1>
              <p>Wait for your crew to connect before starting.</p>
            </div>

            <div className="room-code-card">
              <span>ROOM CODE</span>
              <strong>{room.code}</strong>
              <button
                className="copy-button"
                onClick={() => {
                  void navigator.clipboard.writeText(room.code);
                  setNotice('Room code copied.');
                }}
              >
                COPY CODE
              </button>
            </div>
          </div>

          <div className="lobby-layout">
            <div className="panel roster-panel">
              <div className="panel-heading">
                <div>
                  <span className="section-label">THE CREW</span>
                  <h2>Players</h2>
                </div>
                <span className="player-count">
                  {room.players.length}/{room.capacity}
                </span>
              </div>

              <div className="player-list">
                {room.players.map((player, index) => (
                  <div className="player-row" key={player.id}>
                    <div className="player-avatar">
                      {String(index + 1).padStart(2, '0')}
                    </div>

                    <div className="player-details">
                      <strong>
                        {player.name}
                        {player.id === playerId && (
                          <span className="you-tag">YOU</span>
                        )}
                      </strong>
                      <span>
                        {player.isHost ? 'ROOM HOST' : 'CREW MEMBER'}
                        {!player.connected ? ' · DISCONNECTED' : ''}
                      </span>
                    </div>

                    <span
                      className={`ready-status ${
                        !player.connected
                          ? 'status-disconnected'
                          : player.ready
                            ? 'status-ready'
                            : 'status-waiting'
                      }`}
                    >
                      {!player.connected
                        ? 'OFFLINE'
                        : player.ready
                          ? 'READY'
                          : 'WAITING'}
                    </span>
                  </div>
                ))}

                {Array.from({
                  length: Math.max(0, room.capacity - room.players.length),
                }).map((_, index) => (
                  <div className="player-row empty-slot" key={`empty-${index}`}>
                    <div className="player-avatar">--</div>
                    <div className="player-details">
                      <strong>Open slot</strong>
                      <span>AWAITING PLAYER</span>
                    </div>
                    <span className="ready-status status-waiting">EMPTY</span>
                  </div>
                ))}
              </div>

              <div className="roster-footer">
                <span className="connection-dot" />
                PLAYER LIST UPDATES LIVE
              </div>
            </div>

            <aside className="panel mission-panel">
              <span className="section-label">MISSION BRIEFING</span>
              <h2>Trust is a liability.</h2>
              <p>
                Complete three of four jobs to secure the crew's victory.
                Someone in this room wants the operation to fail.
              </p>

              <div className="mission-stat">
                <span>CREW SIZE</span>
                <strong>{room.players.length} / 8</strong>
              </div>

              <div className="mission-stat">
                <span>MINIMUM CREW</span>
                <strong>4 PLAYERS</strong>
              </div>

              <div className="lobby-actions">
                <button
                  className={`primary-button ${me?.ready ? 'is-ready' : ''}`}
                  disabled={!connected || !me}
                  onClick={() => void toggleReady()}
                >
                  {me?.ready ? 'MARK AS NOT READY' : "I'M READY"}
                  <span>{me?.ready ? '✓' : '↗'}</span>
                </button>

                {me?.isHost && (
                  <button
                    className="secondary-button start-button"
                    disabled={
                      !allReady ||
                      startingGame ||
                      room.status !== 'lobby'
                    }
                    onClick={() => void startGame()}
                  >
                    {startingGame ? 'STARTING...' : 'START GAME'}
                  </button>
                )}

                <button
                  className="secondary-button start-button"
                  disabled={!connected}
                  onClick={() => void leaveRoom()}
                >
                  LEAVE ROOM
                </button>

                <p className="lobby-hint">
                  {room.players.length < 4
                    ? `Waiting for ${4 - room.players.length} more player(s).`
                    : !allReady
                      ? 'Every player must be connected and ready.'
                      : 'Crew ready. Host can start the game.'}
                </p>
              </div>
            </aside>
          </div>

          {notice && <p className="notice">{notice}</p>}
          {error && <p className="error-message">{error}</p>}
        </section>
      )}

      <footer className="footer">
        <span>DOUBLE CROSS</span>
        <span>CHOOSE YOUR ALLIES CAREFULLY.</span>
      </footer>
    </main>
  );
}

export default App;
