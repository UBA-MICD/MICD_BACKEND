.PHONY: help install up down build logs ps restart clean test check

# ── Default ───────────────────────────────────────────────────────────────────
help:
	@echo ""
	@echo "  MICD backend — available commands"
	@echo ""
	@echo "  make install     Install dependencies and create .env"
	@echo "  make up          Start the Docker stack (postgres + orthanc + backend)"
	@echo "  make down        Stop and remove containers"
	@echo "  make build       Rebuild all Docker images"
	@echo "  make logs        Follow logs from all services"
	@echo "  make ps          Show container status"
	@echo "  make restart     Rebuild images and restart stack"
	@echo "  make test        Run integration tests (requires stack up)"
	@echo "  make check       Verify all services are running correctly"
	@echo "  make clean       Remove containers, volumes and images"
	@echo ""

# ── Dependencies ──────────────────────────────────────────────────────────────
install:
	npm install
	@[ -f .env ] || (cp .env.example .env && echo ".env created from .env.example")

# ── Docker ────────────────────────────────────────────────────────────────────
up:
	docker compose up -d

down:
	docker compose down

build:
	docker compose build

logs:
	docker compose logs -f

ps:
	docker compose ps

restart: build up

# ── Tests ─────────────────────────────────────────────────────────────────────
check:
	@./scripts/check.sh

test:
	npm run test:integration

# ── Cleanup ───────────────────────────────────────────────────────────────────
clean:
	docker compose down -v --rmi local
