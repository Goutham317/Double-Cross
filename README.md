# DOUBLE CROSS — Multiplayer Game

This repository deploys DOUBLE CROSS as one Node.js Web Service that serves the Vite frontend and Socket.IO backend from the same public origin.

## Source layout required

The repository root must contain:

- `client/` — React + TypeScript + Vite app, including `package-lock.json`
- `server/` — Node.js + TypeScript + Express + Socket.IO app, including `package-lock.json`
- `Dockerfile` and `render.yaml`

The actual `client/` and `server/` folders still need to be pushed to this repository from the deployment-ready source ZIP.

## Deploy on Render

1. Push the `client/` and `server/` folders to this repository's `main` branch.
2. Connect the GitHub repository to Render: https://dashboard.render.com/blueprints/new
3. Create a Blueprint from `render.yaml`. It creates a Docker web service named `double-cross`.
4. Wait for the deploy to finish. Open the generated HTTPS URL and check `/health` returns `{"ok":true,"service":"double-cross-server"}`.
5. Test room creation and have another player open the same public URL from a separate device/browser to join by room code.

## Local development

Run server and client separately using the README included with the source project. The client uses `http://localhost:3001` by default in development and the current public origin in production.

Do not submit the public URL until health and external multiplayer tests pass.
