# MICD_BACKEND

MICD API — backend for DICOM study management. Express/TypeScript REST API backed by **PostgreSQL** (study metadata) and **Orthanc** (DICOM PACS storage).

> Split out of [UBA-MICD/MICD_APP](https://github.com/UBA-MICD/MICD_APP). The web frontend lives in [UBA-MICD/MICD_WEB](https://github.com/UBA-MICD/MICD_WEB) and connects to this stack through the shared Docker network `micd` (created by this repo's compose file — **start this stack first**).

## Project Structure

```
MICD_BACKEND/
├── src/
│   ├── index.ts                # Express app: routes + healthcheck + Orthanc proxy
│   ├── db.ts                   # PostgreSQL pool
│   ├── upload.ts               # DICOM upload handling
│   ├── instances-util.ts       # Instance ordering helpers
│   └── *.test.ts               # Unit + integration tests (Jest)
├── Dockerfile                  # Multi-stage: builder (tsc) → runtime (alpine slim)
├── docker-compose.yml          # postgres + orthanc + backend (network: micd)
├── Makefile                    # Dev commands (see docs/makefile.md)
├── scripts/check.sh            # Stack verification (make check)
├── docs/                       # Architecture & testing docs
├── .data.example/              # Sample DICOM series for testing
└── .env.example                # Documented environment variables
```

## Quick Start

```bash
make install    # npm install + create .env from .env.example
make up         # start postgres + orthanc + backend (Docker)
make check      # verify all services are healthy
```

Backend API: `http://localhost:3000/api/health` · Orthanc UI: `http://localhost:8042` (user/pass: `orthanc`/`orthanc` by default).

## Development

```bash
npm run dev     # ts-node-dev with auto-reload (needs postgres + orthanc up)
npm run build   # compile TypeScript to dist/
npm test        # unit tests
make test       # integration tests (requires stack up: make up)
```

## Documentation

- [docs/DOCKER.md](docs/DOCKER.md) — architecture rationale, services, networking
- [docs/makefile.md](docs/makefile.md) — Makefile command guide
- [docs/testing-docker.md](docs/testing-docker.md) — end-to-end stack verification
- [docs/reset-and-reseed.md](docs/reset-and-reseed.md) — wipe and re-seed DICOM data
