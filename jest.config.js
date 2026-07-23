/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  testEnvironment: "node",
  // Unit tests live under tests/unit, integration suites under tests/integration.
  // Sources are compiled from src via a jest-specific tsconfig that widens
  // rootDir so tests outside src can import them.
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "tsconfig.jest.json" }],
  },
};
