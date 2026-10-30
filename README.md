# DOUBLE CROSS — Final Submission

DOUBLE CROSS is a real-time multiplayer social-deduction game for 4–8 players, with one hidden Saboteur. This source package contains the React client and the Node.js/Socket.IO server.

## Features

- Room creation, six-character room codes, live roster, ready checks, host controls, and reconnect tokens.
- Private role assignment. The Saboteur's identity is hidden from public match state until the match ends.
- Four-job loop with private actions: Crew choose `WORK` or `GUARD`; the Saboteur chooses `WORK` or `SABOTAGE`.
- Job resolution based on work points, sabotage attempts, and Guard protection.
- A separate private investigation phase for Crew members.
- Discussion by room chat followed by anonymous voting.
- Explicit abstention. A player is ejected only if they receive a strict majority of valid votes cast. Ties, plurality-only results, and no-vote outcomes do not eject anyone.
- Ejected Crew members cannot take part in later jobs or votes. The Saboteur's ejection gives the Crew an immediate win.
- Action and vote phases automatically resolve after 45 seconds. Missing actions default to `WORK` for Crew and `SABOTAGE` for the Saboteur; missing votes abstain.
- A player who permanently leaves is removed from active gameplay after their reconnect window expires. If the Saboteur leaves permanently, the Crew wins by forfeit. Role history is retained for the final reveal.
- Final score, job history, winner announcement, and role reveal.
- Responsive dark interface, keyboard focus states, subtle motion, and reduced-motion support.

## Rules

- Crew wins by completing three jobs or ejecting the Saboteur through a valid majority vote.
- Saboteur wins by causing three failed jobs, by winning the score comparison after job four, or by reducing the active crew to too few players to continue.
- Each job needs `ceil(active player count × 0.6)` Work points.
- Guard cancels one sabotage attempt. If any sabotage remains effective, the job fails.
- Crew investigations happen only during the dedicated Investigation phase; they are not a job action.
- Investigation results are sent privately to the investigator. Players may choose whether to share what they learn in chat.

## Requirements

- Node.js 22 or later recommended.
- npm.

## Run on Windows

Open two PowerShell terminals from this project folder.

### Terminal 1 — Server

```powershell
cd server
npm install
npm run check
npm test
npm run dev
```

The server runs at `http://localhost:3001`. Verify it at `http://localhost:3001/health`.

### Terminal 2 — Client

```powershell
cd client
npm install
npm run build
npm run lint
npm run dev
```

Open the Vite address printed by the terminal, normally `http://localhost:5173`.

For local testing, open the game in four to eight separate browser sessions or devices that can reach the same development server. Create a room, share its code, and have all players join and mark themselves ready before the host starts.

## Tests

The server suite covers role privacy, room and reconnect behavior, job actions, investigation, majority voting, ejection, chat, and a permanently disconnected player during an active match. Run `npm test` from `server` after installing dependencies.

## Submission notes

This ZIP is a source-code package. `node_modules` and generated `dist` files are intentionally excluded; install dependencies with `npm install` in both `server` and `client` before running the project. The current server binds to `127.0.0.1`, which is suitable for a local demo but not a public deployment.
