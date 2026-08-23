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
};
