// Shared setup for Testcontainers-backed integration tests.
// Works out of the box in CI (default /var/run/docker.sock) and locally on
// colima or Docker Desktop by pointing DOCKER_HOST at whichever socket exists.
const fs = require('fs');
const os = require('os');

if (!process.env.TESTCONTAINERS_RYUK_DISABLED) {
  process.env.TESTCONTAINERS_RYUK_DISABLED = 'true';
}

// Keep service logs out of the test output unless explicitly requested.
if (!process.env.LOG_LEVEL) {
  process.env.LOG_LEVEL = 'silent';
}

if (!process.env.DOCKER_HOST) {
  const candidates = [
    `${os.homedir()}/.colima/default/docker.sock`,
    `${os.homedir()}/.docker/run/docker.sock`,
    '/var/run/docker.sock',
  ];
  for (const sock of candidates) {
    if (fs.existsSync(sock)) {
      process.env.DOCKER_HOST = `unix://${sock}`;
      break;
    }
  }
}
