import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/** The circuits' proving files, produced by `npm run setup` (BRD 2.2.1: proofs are built in the browser). */
const ARTIFACTS = resolve(import.meta.dirname, '../../packages/framework/artifacts');

/** Serves the proving files at /artifacts in development and copies them into the build. */
function provingArtifacts(): Plugin {
  let outDir = '';
  return {
    name: 'calyptra-proving-artifacts',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use('/artifacts', (req, res, next) => {
        const file = join(ARTIFACTS, (req.url ?? '').split('?')[0]?.replace(/^\/+/, '') ?? '');
        if (!file.startsWith(ARTIFACTS) || !existsSync(file)) return next();
        res.setHeader('content-type', 'application/octet-stream');
        createReadStream(file).pipe(res);
      });
    },
    async closeBundle() {
      await cp(ARTIFACTS, join(outDir, 'artifacts'), { recursive: true });
    },
  };
}

/** Files of the public folder that belong to the app shell (served at the origin root). */
const PUBLIC_SHELL = ['/manifest.webmanifest', '/favicon.svg', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];

/** A fingerprint of the proving files: it changes whenever the circuits or their keys change. */
function artifactsVersion(): string {
  if (!existsSync(ARTIFACTS)) return 'none';
  const hash = createHash('sha256');
  for (const name of readdirSync(ARTIFACTS).sort()) {
    const file = join(ARTIFACTS, name);
    hash.update(`${name}:${statSync(file).size}\n`);
    if (name.endsWith('.vkey.json')) hash.update(readFileSync(file));
  }
  return hash.digest('hex').slice(0, 12);
}

/**
 * The PWA's service worker (§11.6): the app shell and the proving files are served cache-first from
 * caches named after this build, so a new build replaces them and an old one is deleted on activation.
 * Only production builds get one; the dev server never registers it.
 */
function serviceWorker(): Plugin {
  return {
    name: 'calyptra-service-worker',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const built = Object.keys(bundle).filter((file) => !file.endsWith('.map')).map((file) => `/${file}`);
      const shell = ['/', ...PUBLIC_SHELL, ...built].sort();
      const version = createHash('sha256').update(shell.join('\n')).update(readFileSync(resolve(import.meta.dirname, 'public/favicon.svg'))).digest('hex').slice(0, 12);
      const source = readFileSync(resolve(import.meta.dirname, 'src/app/sw.template.js'), 'utf8')
        .replace('__SHELL_VERSION__', version)
        .replace('__ARTIFACTS_VERSION__', artifactsVersion())
        .replace('__SHELL_FILES__', JSON.stringify(shell));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  plugins: [react(), provingArtifacts(), serviceWorker()],
  build: { target: 'es2023', chunkSizeWarningLimit: 8000 },
});
