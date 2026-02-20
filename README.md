# Social Genie

Social Genie is a combined Instagram + YouTube module for SuiteGenie.
It also supports Threads posting and account connection.

## Structure

- `client`: React + Vite frontend
- `server`: Express API for OAuth, posts, scheduling, analytics, and account management

## Scripts

- `npm run dev`
- `npm run build`
- `npm run start`

## OAuth Setup

Copy `server/.env.example` to `server/.env` and fill credentials.

Required callback URLs:

- Instagram: `http://localhost:3006/api/oauth/instagram/callback`
- Threads: `http://localhost:3006/api/oauth/threads/callback`
- YouTube: `http://localhost:3006/api/oauth/youtube/callback`

Threads OAuth supports dedicated keys:

- `THREADS_APP_ID`
- `THREADS_APP_SECRET`

If these are empty, Social Genie falls back to:

- `INSTAGRAM_APP_ID`
- `INSTAGRAM_APP_SECRET`