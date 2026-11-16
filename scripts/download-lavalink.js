/**
 * Downloads Lavalink.jar from GitHub releases into ./lavalink/
 * Usage: node scripts/download-lavalink.js [version]
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const version = process.argv[2] || '4.2.2';
const outDir = path.join(__dirname, '..', 'lavalink');
const outFile = path.join(outDir, 'Lavalink.jar');

function downloadFrom(url, file, depth = 0) {
  if (depth > 5) {
    console.error('Too many redirects');
    process.exit(1);
  }

  https
    .get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) {
        const loc = res.headers.location;
        if (!loc) {
          console.error('Redirect without Location header');
          process.exit(1);
        }
        const next = new URL(loc, url).href;
        res.resume();
        downloadFrom(next, file, depth + 1);
        return;
      }

      if (res.statusCode !== 200) {
        console.error(`HTTP ${res.statusCode} for ${url}`);
        file.close();
        try {
          fs.unlinkSync(outFile);
        } catch (_) {}
        process.exit(1);
      }

      res.pipe(file);
      file.on('finish', () => {
        file.close();
        console.log(`Wrote ${outFile}`);
      });
    })
    .on('error', (err) => {
      console.error(err);
      try {
        file.close();
        fs.unlinkSync(outFile);
      } catch (_) {}
      process.exit(1);
    });
}

if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

const url = `https://github.com/lavalink-devs/Lavalink/releases/download/${version}/Lavalink.jar`;
console.log(`Downloading Lavalink ${version}...`);
const file = fs.createWriteStream(outFile);
downloadFrom(url, file);
