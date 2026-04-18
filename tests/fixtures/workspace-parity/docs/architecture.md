# Workspace Architecture

The web-app/session.ts and backend/api.ts both depend on shared/index.ts, which forwards the anonymous default export from shared/auth.ts through a local default barrel for session creation.

The worker/jobs.ts flow stays separate so the fixture keeps a fragmented mixed-workspace shape.
