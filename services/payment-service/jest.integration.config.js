module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/integration/**/*.integration.test.ts'],
  setupFiles: ['<rootDir>/../../test/integration-setup.js'],
  // Containers can take time to pull and start on the first run.
  testTimeout: 240000,
  maxWorkers: 1,
};
