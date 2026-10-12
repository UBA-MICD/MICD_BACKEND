/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  testEnvironment: "node",
  // Unit tests live under tests/unit, integration suites under tests/integration.
  // Sources are compiled from src via a jest-specific tsconfig that widens
  // rootDir so tests outside src can import them.
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
  // Integration tests that create invited users wait on a real SMTP send
  // (shared/mailer.ts) when SMTP_HOST is configured — the default 5s is too
  // tight for that round trip.
  testTimeout: 15000,
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "tsconfig.jest.json" }],
  },
  // TK-11: keep the independent PHI check and the ingest gate well covered, so
  // a regression that stops verifying (or stops blocking) fails CI. Scoped to
  // these files rather than the whole repo, which has no global bar yet.
  coverageThreshold: {
    "src/shared/phi-verification.ts": {
      lines: 80,
      branches: 80,
      functions: 80,
    },
    "src/modules/upload/upload.service.ts": {
      lines: 80,
      branches: 80,
    },
  },
};
