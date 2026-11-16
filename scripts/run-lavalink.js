/**
 * Starts Lavalink with cwd = lavalink/ so application.yml is picked up.
 *
 * Tuning is env-driven so the same repo works on a laptop and on a small VPS:
 *   LAVALINK_HEAP=2g          JVM max heap (+ -Xms matching it, avoids resize pauses)
 *   LAVALINK_PRETOUCH=1       pre-touch heap pages (only worth it with RAM to spare)
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const lavalinkDir = path.join(__dirname, '..', 'lavalink');
const jar = path.join(lavalinkDir, 'Lavalink.jar');

if (!fs.existsSync(jar)) {
  console.error('Lavalink.jar not found. Run: npm run lavalink:download');
  process.exit(1);
}

// Prefer a bundled JRE (lavalink/jre) so no system-wide Java install is required.
const bundledJava = path.join(
  lavalinkDir,
  'jre',
  'bin',
  process.platform === 'win32' ? 'java.exe' : 'java'
);
const javaBin = fs.existsSync(bundledJava) ? bundledJava : 'java';

const heap = process.env.LAVALINK_HEAP || '2g';
const preTouch = /^(1|true|yes)$/i.test(process.env.LAVALINK_PRETOUCH || '');

const jvmArgs = [
  `-Xms${heap}`,
  `-Xmx${heap}`,
  '-XX:+UseG1GC',
  '-XX:MaxGCPauseMillis=100',
  '-XX:+ParallelRefProcEnabled',
  '-XX:+DisableExplicitGC',
  '-XX:+UseStringDeduplication'
];
// Pre-touching commits the whole heap up front. Good on a desktop, a good way to OOM a
// 1 GB VPS, so it is opt-in.
if (preTouch) jvmArgs.push('-XX:+AlwaysPreTouch');
jvmArgs.push('-jar', 'Lavalink.jar');

const child = spawn(javaBin, jvmArgs, {
  cwd: lavalinkDir,
  stdio: 'inherit',
  shell: false
});

// The wrapper used to leave an orphaned JVM behind: kill the wrapper (pm2 restart, Ctrl-C,
// systemd stop) and Java kept running, holding port 2333, so every later start failed with
// "port already in use". Forward termination to the child and never exit before it does.
let shuttingDown = false;
function forwardSignal(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    child.kill(signal);
  } catch {
    /* already gone */
  }
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => forwardSignal(signal));
}

// If this process dies without a signal handler running (crash), take the JVM with it.
process.on('exit', () => {
  if (!child.killed) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
});

child.on('error', (err) => {
  console.error('Failed to start Lavalink:', err.message || err);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
