.PHONY: help install hooks up down build logs ps restart check test pre-commit clean generate-fake-data test-python

# ── Default ───────────────────────────────────────────────────────────────────
help:
	@echo ""
	@echo "  MICD backend — available commands"
	@echo ""
	@echo "  make install     Install dependencies and create .env"
	@echo "  make hooks       Install pre-commit Git hooks"
	@echo "  make up          Start the Docker stack (postgres + orthanc + backend)"
	@echo "  make down        Stop and remove containers"
	@echo "  make build       Rebuild all Docker images"
	@echo "  make logs        Follow logs from all services"
	@echo "  make ps          Show container status"
	@echo "  make restart     Rebuild images and restart stack"
	@echo "  make pre-commit  Run pre-commit checks manually"
	@echo "  make test        Run integration tests (requires stack up)"
	@echo "  make check       Verify all services are running correctly"
	@echo "  make generate-fake-data  Generate synthetic DICOM files for testing"
	@echo "  make clean       Remove containers, volumes and images"
	@echo ""

# ── Dependencies ──────────────────────────────────────────────────────────────
install:
	npm install
	@[ -f .env ] || (cp .env.example .env && echo ".env created from .env.example")

hooks:
	@if command -v pre-commit >/dev/null 2>&1; then \
		pre-commit install; \
		echo "Git hooks installed successfully."; \
	else \
		echo "Error: 'pre-commit' is not installed. Please install it first."; \
		exit 1; \
	fi

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

# ── Tests and Checks ──────────────────────────────────────────────────────────
check:
	@./scripts/check.sh

test:
	npm run test:integration

test-python:
	uv run --with pydicom python3 scripts/test_generate_synthetic_data.py

generate-fake-data:
	uv run --with pydicom python3 scripts/generate_synthetic_data.py --input ./.data.example --output ./data/staging/dicom --count 5

pre-commit:
	@if command -v pre-commit >/dev/null 2>&1; then \
		pre-commit run --all-files; \
	else \
		echo "Error: 'pre-commit' is not installed. Please install it first."; \
		exit 1; \
	fi

# ── Cleanup ───────────────────────────────────────────────────────────────────
clean:
	docker compose down -v --rmi local
