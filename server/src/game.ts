import { randomInt, randomUUID } from 'node:crypto';

export type PlayerRole = 'CREW' | 'SABOTEUR';
export type MatchPhase =
  | 'PREPARING'
  | 'JOB_SELECTION'
  | 'DISCUSSION'
  | 'ACTIONS'
  | 'RESOLUTION'
  | 'INVESTIGATION'
  | 'VOTING'
  | 'FINISHED';
export type PlayerAction = 'WORK' | 'GUARD' | 'SABOTAGE';
export type RemovalReason = 'DISCONNECTED' | 'EJECTED';

export type GamePlayer = {
  id: string;
  role: PlayerRole;
  name?: string;
  removalReason?: RemovalReason;
};

export type JobResult = {
  jobNumber: number;
  success: boolean;
  workPoints: number;
  difficulty: number;
  sabotageAttempts: number;
  guarded: boolean;
  message: string;
};

export type VoteResult = {
  votes: number;
  validVotes: number;
  targetId: string | null;
  targetName: string | null;
  ejected: boolean;
  message: string;
};

export type MatchState = {
  matchId: string;
  status: 'ACTIVE' | 'FINISHED';
  phase: MatchPhase;
  currentJob: number;
  /** Players who can still participate in the match. */
  players: GamePlayer[];
  /** Preserved for the final role reveal after a player leaves or is ejected. */
  departedPlayers: GamePlayer[];
  completedJobs: JobResult[];
  crewWins: number;
  saboteurWins: number;
  actions: Record<string, { action: PlayerAction; targetId?: string }>;
  investigations: Record<string, { targetId: string; role: PlayerRole }>;
  votes: Record<string, string | null>;
  voteResult: VoteResult | null;
  winner: PlayerRole | null;
};

export type PublicMatchState = {
  matchId: string;
  status: 'ACTIVE' | 'FINISHED';
  phase: MatchPhase;
  currentJob: number;
  playerCount: number;
  /** Public IDs are already present in the room roster; these identify who can still act. */
  activePlayerIds: string[];
  departedPlayerIds: string[];
  ejectedPlayerIds: string[];
  players?: {
    id: string;
    name: string;
    connected: boolean;
    role?: PlayerRole;
    active: boolean;
    removalReason?: RemovalReason;
  }[];
  completedJobs: JobResult[];
  crewWins: number;
  saboteurWins: number;
  actionCount: number;
  investigationCount: number;
  voteCount: number;
  voteResult: VoteResult | null;
  winner: PlayerRole | null;
};

const MIN_PLAYERS = 4;
const MAX_PLAYERS = 8;

export function createMatch(
  playerIds: string[],
  playerNames: Record<string, string> = {},
): MatchState {
  if (playerIds.length < MIN_PLAYERS || playerIds.length > MAX_PLAYERS) {
    throw new Error('A match requires 4 to 8 players.');
  }
  if (new Set(playerIds).size !== playerIds.length) {
    throw new Error('Player IDs must be unique.');
  }
  if (playerIds.some(id => !id.trim())) {
    throw new Error('Player IDs cannot be empty.');
  }

  const saboteurIndex = randomInt(playerIds.length);
  return {
    matchId: randomUUID(),
    status: 'ACTIVE',
    phase: 'JOB_SELECTION',
    currentJob: 1,
    players: playerIds.map((id, index) => ({
      id,
      role: index === saboteurIndex ? 'SABOTEUR' : 'CREW',
      ...(playerNames[id] ? { name: playerNames[id] } : {}),
    })),
    departedPlayers: [],
    completedJobs: [],
    crewWins: 0,
    saboteurWins: 0,
    actions: {},
    investigations: {},
    votes: {},
    voteResult: null,
    winner: null,
  };
}

export function getPrivateRole(match: MatchState, playerId: string): PlayerRole {
  const player = match.players.find(candidate => candidate.id === playerId)
    ?? match.departedPlayers.find(candidate => candidate.id === playerId);
  if (!player) throw new Error('Player is not part of this match.');
  return player.role;
}

export function getPublicMatchState(
  match: MatchState,
  names: Record<string, { name: string; connected: boolean }> = {},
): PublicMatchState {
  const activeIds = new Set(match.players.map(player => player.id));
  const departedIds = new Set(match.departedPlayers.map(player => player.id));
  const revealAllRoles = match.status === 'FINISHED';
  const allPlayers = [...match.players, ...match.departedPlayers];

  return {
    matchId: match.matchId,
    status: match.status,
    phase: match.phase,
    currentJob: match.currentJob,
    playerCount: match.players.length,
    activePlayerIds: match.players.map(player => player.id),
    departedPlayerIds: match.departedPlayers.map(player => player.id),
    ejectedPlayerIds: match.departedPlayers.filter(player => player.removalReason === 'EJECTED').map(player => player.id),
    ...(revealAllRoles
      ? {
          players: allPlayers.map(player => ({
            id: player.id,
            name: names[player.id]?.name ?? player.name ?? 'Player',
            connected: names[player.id]?.connected ?? false,
            role: player.role,
            active: activeIds.has(player.id) && !departedIds.has(player.id),
            ...(player.removalReason ? { removalReason: player.removalReason } : {}),
          })),
        }
      : {}),
    completedJobs: match.completedJobs.map(result => ({ ...result })),
    crewWins: match.crewWins,
    saboteurWins: match.saboteurWins,
    actionCount: Object.keys(match.actions).length,
    investigationCount: Object.keys(match.investigations).length,
    voteCount: Object.keys(match.votes).length,
    voteResult: match.voteResult ? { ...match.voteResult } : null,
    winner: match.winner,
  };
}

export function beginActions(match: MatchState): void {
  assertActiveMatch(match);
  if (match.phase !== 'JOB_SELECTION' && match.phase !== 'DISCUSSION') {
    throw new Error('Actions cannot begin in this phase.');
  }
  match.phase = 'ACTIONS';
  match.actions = {};
}

export function submitPlayerAction(
  match: MatchState,
  playerId: string,
  action: PlayerAction,
  targetId?: string,
): void {
  assertActiveMatch(match);
  if (match.phase !== 'ACTIONS') throw new Error('Actions are not being accepted now.');
  const player = match.players.find(candidate => candidate.id === playerId);
  if (!player) throw new Error('Player is not part of this match or has been removed.');
  if (Object.prototype.hasOwnProperty.call(match.actions, playerId)) {
    throw new Error('You have already submitted an action.');
  }

  const allowed: PlayerAction[] = player.role === 'SABOTEUR'
    ? ['WORK', 'SABOTAGE']
    : ['WORK', 'GUARD'];
  if (!allowed.includes(action)) throw new Error('That action is not available for your role.');

  if (action === 'GUARD') {
    if (!targetId || !match.players.some(candidate => candidate.id === targetId) || targetId === playerId) {
      throw new Error('Choose another active player as your guard target.');
    }
  }

  match.actions[playerId] = { action, ...(targetId ? { targetId } : {}) };
}

export function allActionsSubmitted(match: MatchState): boolean {
  return match.players.every(player => Object.prototype.hasOwnProperty.call(match.actions, player.id));
}

export function fillMissingActions(match: MatchState): void {
  for (const player of match.players) {
    if (!Object.prototype.hasOwnProperty.call(match.actions, player.id)) {
      match.actions[player.id] = { action: player.role === 'SABOTEUR' ? 'SABOTAGE' : 'WORK' };
    }
  }
}

export function resolveJob(match: MatchState): JobResult {
  assertActiveMatch(match);
  if (match.phase !== 'ACTIONS') throw new Error('The job is not accepting actions.');
  if (!allActionsSubmitted(match)) throw new Error('Waiting for every player to submit an action.');

  const actions = Object.values(match.actions);
  const workPoints = actions.filter(item => item.action === 'WORK').length;
  const sabotageAttempts = actions.filter(item => item.action === 'SABOTAGE').length;
  const guarded = actions.some(item => item.action === 'GUARD');
  const effectiveSabotage = Math.max(0, sabotageAttempts - (guarded ? 1 : 0));
  const difficulty = Math.ceil(match.players.length * 0.6);
  const success = workPoints >= difficulty && effectiveSabotage === 0;
  const result: JobResult = {
    jobNumber: match.currentJob,
    success,
    workPoints,
    difficulty,
    sabotageAttempts,
    guarded,
    message: success
      ? 'The crew completed the job.'
      : effectiveSabotage > 0
        ? 'Sabotage compromised the job.'
        : 'The crew did not reach the work target.',
  };

  match.completedJobs.push(result);
  if (success) match.crewWins++;
  else match.saboteurWins++;

  match.phase = 'INVESTIGATION';
  match.investigations = {};
  match.votes = {};
  match.voteResult = null;

  if (match.crewWins >= 3) {
    finishMatch(match, 'CREW');
  } else if (match.saboteurWins >= 3 || match.currentJob >= 4) {
    finishMatch(match, match.crewWins > match.saboteurWins ? 'CREW' : 'SABOTEUR');
  }
  return result;
}

export function recordInvestigation(
  match: MatchState,
  investigatorId: string,
  targetId: string,
): PlayerRole {
  assertActiveMatch(match);
  if (match.phase !== 'INVESTIGATION') throw new Error('Investigations are not open.');
  const investigator = match.players.find(player => player.id === investigatorId);
  if (!investigator || investigator.role !== 'CREW') throw new Error('Only crew members can investigate.');
  if (investigatorId === targetId || !match.players.some(player => player.id === targetId)) {
    throw new Error('Choose another active player to investigate.');
  }
  if (Object.prototype.hasOwnProperty.call(match.investigations, investigatorId)) {
    throw new Error('You have already investigated this job.');
  }
  const role = getPrivateRole(match, targetId);
  match.investigations[investigatorId] = { targetId, role };
  return role;
}

export function finishInvestigation(match: MatchState): void {
  assertActiveMatch(match);
  if (match.phase !== 'INVESTIGATION') throw new Error('Investigation is not active.');
  match.phase = 'VOTING';
  match.votes = {};
}

export function submitVote(match: MatchState, voterId: string, targetId: string | null): void {
  assertActiveMatch(match);
  if (match.phase !== 'VOTING') throw new Error('Voting is not open.');
  if (!match.players.some(player => player.id === voterId)) {
    throw new Error('You are not an active player in this match.');
  }
  if (Object.prototype.hasOwnProperty.call(match.votes, voterId)) {
    throw new Error('You have already voted.');
  }
  if (targetId !== null) {
    if (!match.players.some(player => player.id === targetId)) {
      throw new Error('Choose an active player in this match.');
    }
    if (voterId === targetId) throw new Error('You cannot vote for yourself.');
  }
  // null is an explicit abstention and still counts as a submitted ballot.
  match.votes[voterId] = targetId;
}

export function allVotesSubmitted(match: MatchState): boolean {
  return match.players.every(player => Object.prototype.hasOwnProperty.call(match.votes, player.id));
}

export function fillMissingVotes(match: MatchState): void {
  for (const player of match.players) {
    if (!Object.prototype.hasOwnProperty.call(match.votes, player.id)) match.votes[player.id] = null;
  }
}

export function resolveVote(
  match: MatchState,
  names: Record<string, string> = {},
): VoteResult {
  assertActiveMatch(match);
  if (match.phase !== 'VOTING') throw new Error('Voting is not open.');
  if (!allVotesSubmitted(match)) throw new Error('Waiting for every player to vote.');

  const activeIds = new Set(match.players.map(player => player.id));
  const validTargets = Object.values(match.votes).filter(
    (target): target is string => target !== null && activeIds.has(target),
  );
  const tally = new Map<string, number>();
  for (const target of validTargets) tally.set(target, (tally.get(target) ?? 0) + 1);

  const validVotes = validTargets.length;
  const highest = tally.size ? Math.max(...tally.values()) : 0;
  const leaders = [...tally.entries()]
    .filter(([, votes]) => votes === highest)
    .map(([id]) => id);
  const uniqueLeader = leaders.length === 1 ? leaders[0] : null;
  const hasStrictMajority = uniqueLeader !== null && validVotes > 0 && highest > validVotes / 2;
  const targetId = hasStrictMajority ? uniqueLeader : null;
  const ejected = targetId !== null;
  const targetPlayer = targetId ? match.players.find(player => player.id === targetId) : undefined;
  const targetName = targetId ? names[targetId] ?? targetPlayer?.name ?? 'Player' : null;

  let message: string;
  if (targetId) {
    message = `${targetName} received a strict majority (${highest} of ${validVotes} valid votes) and was ejected.`;
  } else if (validVotes === 0) {
    message = 'No valid votes were cast. No player was ejected.';
  } else if (leaders.length > 1) {
    message = 'The vote was tied. No player was ejected.';
  } else {
    message = 'No player received a strict majority. No player was ejected.';
  }

  const result: VoteResult = {
    votes: highest,
    validVotes,
    targetId,
    targetName,
    ejected,
    message,
  };
  match.voteResult = result;

  if (targetId && targetPlayer) {
    archivePlayer(match, targetId, 'EJECTED');
    if (targetPlayer.role === 'SABOTEUR') {
      finishMatch(match, 'CREW');
      return result;
    }
  }

  // If too few participants remain for a viable round, the saboteur wins by forfeit.
  const activeSaboteur = match.players.some(player => player.role === 'SABOTEUR');
  const activeCrewCount = match.players.filter(player => player.role === 'CREW').length;
  if (!activeSaboteur) {
    finishMatch(match, 'CREW');
  } else if (match.players.length < 3 || activeCrewCount === 0) {
    finishMatch(match, 'SABOTEUR');
  } else if (match.currentJob >= 4) {
    finishMatch(match, match.crewWins > match.saboteurWins ? 'CREW' : 'SABOTEUR');
  } else {
    advanceToNextJob(match);
  }

  return result;
}

/** Remove a player whose room membership ends during a match. Role history is preserved for the final debrief. */
export function removeMatchPlayer(match: MatchState, playerId: string, name?: string): void {
  if (match.status !== 'ACTIVE') return;
  const player = match.players.find(candidate => candidate.id === playerId);
  if (!player) return;
  if (name && !player.name) player.name = name;

  const removed = archivePlayer(match, playerId, 'DISCONNECTED');
  if (!removed) return;

  const activeSaboteur = match.players.some(candidate => candidate.role === 'SABOTEUR');
  const activeCrewCount = match.players.filter(candidate => candidate.role === 'CREW').length;
  if (removed.role === 'SABOTEUR' || !activeSaboteur) {
    finishMatch(match, 'CREW');
  } else if (match.players.length < 3 || activeCrewCount === 0) {
    finishMatch(match, 'SABOTEUR');
  }
}

export function getInvestigationResult(
  match: MatchState,
  investigatorId: string,
): { targetId: string; role: PlayerRole } | null {
  const result = match.investigations[investigatorId];
  return result ? { ...result } : null;
}

export function assertActiveMatch(match: MatchState): void {
  if (match.status !== 'ACTIVE') throw new Error('This match has already finished.');
}

function archivePlayer(match: MatchState, playerId: string, reason: RemovalReason): GamePlayer | undefined {
  const playerIndex = match.players.findIndex(player => player.id === playerId);
  if (playerIndex < 0) return undefined;

  const [player] = match.players.splice(playerIndex, 1);
  const archived: GamePlayer = { ...player, removalReason: reason };
  match.departedPlayers.push(archived);

  delete match.actions[playerId];
  delete match.investigations[playerId];
  delete match.votes[playerId];

  // A ballot against someone who left can no longer eject them; treat it as an abstention.
  for (const voterId of Object.keys(match.votes)) {
    if (match.votes[voterId] === playerId) match.votes[voterId] = null;
  }
  return archived;
}

function advanceToNextJob(match: MatchState): void {
  match.currentJob++;
  match.phase = 'JOB_SELECTION';
  match.actions = {};
  match.investigations = {};
  match.votes = {};
}

function finishMatch(match: MatchState, winner: PlayerRole): void {
  match.status = 'FINISHED';
  match.phase = 'FINISHED';
  match.winner = winner;
}
