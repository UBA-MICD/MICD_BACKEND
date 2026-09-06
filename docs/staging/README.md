# Staging deployment (backend)

This repo's staging artifacts:

- `Dockerfile.staging` — hardened runtime image, built on GitHub runners → GHCR.
- `docker-compose.staging.yml` — Postgres + Orthanc + backend, **internal only** (no host ports);
  the public edge lives in the `web` repo (Caddy).
- `.env.staging.example` — copy to `.env.staging` **on the VPS** and fill in secrets.
- `.github/workflows/deploy-to-staging.yml` — build+push to GHCR, then SSH deploy (pull & run).

Full design and the cross-repo picture live in the workspace SDD spec set:
`docs/staging-deployment/{spec,plan,tasks}.md` (in the parent workspace).

Quick facts:
- Domain: `dicomviewermed.online` (TLS terminated at the web repo's Caddy edge).
- Shared network: `docker network create micd` (one-time on the VPS).
- Deploy trigger: CI success on the `staging` branch.
- The VPS never builds images — it only pulls from GHCR.
