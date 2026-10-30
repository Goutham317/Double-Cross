
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createMatch,
  getPrivateRole,
  getPublicMatchState,
} from '../src/game.js';

test('creates a match with exactly one saboteur', () => {
  const ids = ['p1', 'p2', 'p3', 'p4'];
  const match = createMatch(ids);

  const saboteurs = match.players.filter(
    player => player.role === 'SABOTEUR',
  );

  assert.equal(saboteurs.length, 1);
  assert.equal(match.players.length, 4);
  assert.equal(match.status, 'ACTIVE');
  assert.equal(match.phase, 'JOB_SELECTION');
  assert.equal(match.currentJob, 1);
});

test('supports matches with four through eight players', () => {
  for (let count = 4; count <= 8; count++) {
    const ids = Array.from(
      { length: count },
      (_, index) => `player-${index + 1}`,
    );

    const match = createMatch(ids);

    assert.equal(match.players.length, count);
    assert.equal(
      match.players.filter(p => p.role === 'SABOTEUR').length,
      1,
    );
  }
});

test('rejects player counts outside the allowed range', () => {
  assert.throws(() => createMatch(['p1', 'p2', 'p3']));
  assert.throws(() =>
    createMatch(Array.from({ length: 9 }, (_, i) => `p${i}`)),
  );
});

test('rejects duplicate or empty player IDs', () => {
  assert.throws(() => createMatch(['p1', 'p1', 'p2', 'p3']));
  assert.throws(() => createMatch(['p1', 'p2', 'p3', ' ']));
});

test('returns each player their own role', () => {
  const match = createMatch(['p1', 'p2', 'p3', 'p4']);

  for (const player of match.players) {
    assert.equal(
      getPrivateRole(match, player.id),
      player.role,
    );
  }
});

test('rejects role lookup for a player outside the match', () => {
  const match = createMatch(['p1', 'p2', 'p3', 'p4']);

  assert.throws(
    () => getPrivateRole(match, 'unknown-player'),
    /not part of this match/,
  );
});

test('public match state hides roles during play while exposing the active roster IDs', () => {
  const match = createMatch(['p1', 'p2', 'p3', 'p4']);
  const publicState = getPublicMatchState(match);

  assert.equal('players' in publicState, false);
  assert.equal('roles' in publicState, false);
  assert.deepEqual(publicState.activePlayerIds, ['p1', 'p2', 'p3', 'p4']);
  assert.equal('playerIds' in publicState, false);
  assert.equal(publicState.playerCount, 4);
});

test('resolves a job from submitted actions and applies sabotage', async () => {
  const { beginActions, submitPlayerAction, resolveJob } = await import('../src/game.js');
  const match = createMatch(['p1', 'p2', 'p3', 'p4']);
  beginActions(match);
  for (const player of match.players) {
    submitPlayerAction(match, player.id, player.role === 'SABOTEUR' ? 'SABOTAGE' : 'WORK');
  }
  const result = resolveJob(match);
  assert.equal(result.success, false);
  assert.equal(result.sabotageAttempts, 1);
  assert.equal(match.phase, 'INVESTIGATION');
  assert.equal(match.saboteurWins, 1);
});

test('rejects invalid role actions and duplicate action submissions', async () => {
  const { beginActions, submitPlayerAction } = await import('../src/game.js');
  const match = createMatch(['p1', 'p2', 'p3', 'p4']);
  beginActions(match);
  const crew = match.players.find(player => player.role === 'CREW')!;
  assert.throws(() => submitPlayerAction(match, crew.id, 'SABOTAGE'), /not available/i);
  submitPlayerAction(match, crew.id, 'WORK');
  assert.throws(() => submitPlayerAction(match, crew.id, 'WORK'), /already submitted/i);
});

test('investigation results are recorded privately and voting can identify the saboteur', async () => {
  const { beginActions, submitPlayerAction, resolveJob, recordInvestigation, getInvestigationResult, finishInvestigation, submitVote, resolveVote } = await import('../src/game.js');
  const match = createMatch(['p1', 'p2', 'p3', 'p4']);
  beginActions(match);
  for (const player of match.players) submitPlayerAction(match, player.id, 'WORK');
  resolveJob(match);
  const saboteur = match.players.find(player => player.role === 'SABOTEUR')!;
  const investigator = match.players.find(player => player.role === 'CREW')!;
  assert.equal(recordInvestigation(match, investigator.id, saboteur.id), 'SABOTEUR');
  assert.deepEqual(getInvestigationResult(match, investigator.id), { targetId: saboteur.id, role: 'SABOTEUR' });
  finishInvestigation(match);
  for (const player of match.players) {
    submitVote(match, player.id, player.id === saboteur.id ? investigator.id : saboteur.id);
  }
  const result = resolveVote(match, Object.fromEntries(match.players.map(player => [player.id, player.id])));
  assert.equal(result.targetId, saboteur.id);
  assert.equal(match.status, 'FINISHED');
  assert.equal(match.winner, 'CREW');
});

test('rejects INVESTIGATE during job actions because investigation has its own phase', async () => {
  const { beginActions, submitPlayerAction } = await import('../src/game.js');
  const match = createMatch(['p1', 'p2', 'p3', 'p4']);
  beginActions(match);
  const crew = match.players.find(player => player.role === 'CREW')!;
  assert.throws(
    () => submitPlayerAction(match, crew.id, 'INVESTIGATE' as never, 'p2'),
    /not available/i,
  );
});

test('does not eject a player without a strict majority of valid votes', async () => {
  const { beginActions, submitPlayerAction, resolveJob, finishInvestigation, submitVote, resolveVote } = await import('../src/game.js');
  const ids = ['p1', 'p2', 'p3', 'p4', 'p5'];
  const match = createMatch(ids);
  beginActions(match);
  for (const player of match.players) submitPlayerAction(match, player.id, 'WORK');
  resolveJob(match);
  finishInvestigation(match);

  submitVote(match, 'p1', 'p3');
  submitVote(match, 'p2', 'p3');
  submitVote(match, 'p3', 'p1');
  submitVote(match, 'p4', 'p2');
  submitVote(match, 'p5', 'p4');

  const result = resolveVote(match, { p1: 'One', p2: 'Two', p3: 'Three', p4: 'Four', p5: 'Five' });
  assert.equal(result.validVotes, 5);
  assert.equal(result.votes, 2);
  assert.equal(result.targetId, null);
  assert.equal(result.ejected, false);
  assert.match(result.message, /strict majority/i);
  assert.equal(match.players.length, 5);
  assert.equal(match.phase, 'JOB_SELECTION');
  assert.equal(match.currentJob, 2);
});

test('a Crew member with a strict majority is ejected from future gameplay', async () => {
  const { beginActions, submitPlayerAction, resolveJob, finishInvestigation, submitVote, resolveVote } = await import('../src/game.js');
  const match = createMatch(['p1', 'p2', 'p3', 'p4']);
  beginActions(match);
  for (const player of match.players) submitPlayerAction(match, player.id, 'WORK');
  resolveJob(match);
  finishInvestigation(match);

  const crewTarget = match.players.find(player => player.role === 'CREW')!;
  const saboteur = match.players.find(player => player.role === 'SABOTEUR')!;
  for (const player of match.players) {
    submitVote(match, player.id, player.id === crewTarget.id ? null : crewTarget.id);
  }

  const result = resolveVote(match, Object.fromEntries(match.players.map(player => [player.id, player.name ?? player.id])));
  assert.equal(result.targetId, crewTarget.id);
  assert.equal(result.ejected, true);
  assert.equal(match.players.some(player => player.id === crewTarget.id), false);
  assert.equal(match.departedPlayers.some(player => player.id === crewTarget.id && player.removalReason === 'EJECTED'), true);
  assert.equal(match.players.some(player => player.id === saboteur.id), true);
  assert.equal(match.phase, 'JOB_SELECTION');
  assert.equal(match.players.length, 3);
});

test('a Saboteur who permanently leaves makes the Crew win by forfeit and remains in final role reveal', async () => {
  const { removeMatchPlayer } = await import('../src/game.js');
  const match = createMatch(['p1', 'p2', 'p3', 'p4'], { p1: 'Alpha', p2: 'Bravo', p3: 'Charlie', p4: 'Delta' });
  const saboteur = match.players.find(player => player.role === 'SABOTEUR')!;

  const originalSaboteurName = saboteur.name;
  removeMatchPlayer(match, saboteur.id, 'Departed player');

  assert.equal(match.status, 'FINISHED');
  assert.equal(match.phase, 'FINISHED');
  assert.equal(match.winner, 'CREW');
  assert.equal(match.players.some(player => player.id === saboteur.id), false);
  assert.equal(match.departedPlayers.some(player => player.id === saboteur.id && player.removalReason === 'DISCONNECTED'), true);
  const publicState = getPublicMatchState(match);
  assert.equal(publicState.players?.find(player => player.id === saboteur.id)?.role, 'SABOTEUR');
  assert.equal(publicState.players?.find(player => player.id === saboteur.id)?.name, originalSaboteurName);
  assert.equal(publicState.ejectedPlayerIds.includes(saboteur.id), false);
});
