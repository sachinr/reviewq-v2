/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/test"],
  testMatch: ["**/*.test.ts"],
  setupFilesAfterEnv: ["<rootDir>/test/setup.ts"],
  clearMocks: true,
};
