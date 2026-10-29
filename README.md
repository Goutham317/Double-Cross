# DOUBLE CROSS — Deployable Multiplayer Game

This repository contains the source archive and a Render Blueprint for deploying DOUBLE CROSS as a single public service.

## Deploy

1. Open https://dashboard.render.com/blueprints/new and connect this repository.
2. Review the `render.yaml` Blueprint and create the service.
3. Wait for the first deploy to finish, then open the generated `https://...` URL.
4. Verify `/health` returns JSON with `"ok": true`.
5. Open the root URL in a private window and test room creation. For multiplayer, ask another person to open the same URL on a separate device/browser and join the same room code.

## Architecture

Render extracts `double-cross-source.zip`, builds the Vite client and the TypeScript Socket.IO server, and runs one Node Web Service. The server serves the client bundle from the same origin, so production Socket.IO uses HTTPS/WSS on the hosted URL. Local development remains the two-terminal setup in the extracted archive's README.

No `node_modules`, secrets, or local build outputs are committed.
