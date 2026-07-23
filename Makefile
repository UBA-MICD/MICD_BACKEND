.PHONY: help install hooks up down build logs ps restart check test test-integration-docker pre-commit clean clean-data clean-python generate-fake-data test-python seed

# ── Default ───────────────────────────────────────────────────────────────────
help:
	@echo ""
	@echo "  MICD backend — available commands"
	@echo ""
	@echo "  make install     Install dependencies and create .env"
	@echo "  make hooks       Install pre-commit Git hooks"
	@echo "  make up          Start the Docker stack (postgres + orthanc + backend) and seed data"
	@echo "  make down        Stop and remove containers"
	@echo "  make build       Rebuild all Docker images"
	@echo "  make logs        Follow logs from all services"
	@echo "  make ps          Show container status"
	@echo "  make restart     Rebuild images and restart stack"
	@echo "  make pre-commit  Run pre-commit checks manually"
	@echo "  make test        Run integration tests (requires stack up)"
	@echo "  make test-integration-docker  Spin up a throwaway stack and run integration tests end-to-end"
	@echo "  make check       Verify all services are running correctly"
	@echo "  make generate-fake-data  Generate synthetic and volumetric DICOM files for testing"
	@echo "  make seed        Wait for backend and seed all staging DICOM data"
	@echo "  make clean-data  Remove generated synthetic DICOM data"
	@echo "  make clean-python Remove Python cache and pyc files"
	@echo "  make clean       Remove containers, volumes, images, synthetic data and Python caches"
	@echo ""

# ── Dependencies ──────────────────────────────────────────────────────────────
install:
	npm install
	@[ -f .env ] || (cp .env.example .env && echo ".env created from .env.example")
	uv run --with pydicom --with requests --with numpy python3 -c "print('Python dependencies cached.')"

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

# Fully self-contained: builds a throwaway Postgres + Orthanc + backend stack on
# an isolated network, runs the Jest integration suites from inside it, and tears
# everything down. Exit code mirrors the test run so it's CI-friendly.
COMPOSE_TEST := docker compose -p micd-test -f docker-compose.test.yml
test-integration-docker:
	@$(COMPOSE_TEST) down -v --remove-orphans >/dev/null 2>&1 || true
	@set -e; \
	$(COMPOSE_TEST) up --build --abort-on-container-exit --exit-code-from tests; \
	status=$$?; \
	$(COMPOSE_TEST) down -v --remove-orphans >/dev/null 2>&1 || true; \
	exit $$status

test-python:
	uv run --with pydicom python3 scripts/test_generate_synthetic_data.py

generate-fake-data:
	uv run --with pydicom python3 scripts/generate_synthetic_data.py --input ./.data.example --output ./data/staging/dicom --count 5
	uv run --with pydicom --with numpy python3 scripts/generate_volumetric_data.py

seed:
	docker compose --profile seed run --rm micd-seeder

pre-commit:
	@if command -v pre-commit >/dev/null 2>&1; then \
		pre-commit run --all-files; \
	else \
		echo "Error: 'pre-commit' is not installed. Please install it first."; \
		exit 1; \
	fi

# ── Cleanup ───────────────────────────────────────────────────────────────────
clean: clean-data clean-python
	docker compose down -v --rmi local

clean-data:
	@echo "Removing synthetic data folder..."
	@rm -rf ./data
	@echo "Data cleaned."

clean-python:
	@echo "Cleaning Python cache files..."
	@find . -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
	@find . -type f -name "*.pyc" -delete 2>/dev/null || true
	@rm -rf .pytest_cache
	@uv cache clean
	@echo "Python cache cleaned."
