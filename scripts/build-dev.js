import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname as pathDirname } from 'path';
import { fileURLToPath } from 'url';
import { build } from 'esbuild';
import { globSync } from 'glob';
import pkg from '../package.json' with { type: 'json' };
import { gzipSync } from 'zlib';

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathDirname(__filename);
const projectRoot = join(__dirname, '..');
const assetPath = join(projectRoot, 'src/assets');
const distPath = join(projectRoot, 'dist');

async function processHtmlPages() {
    const result = {};

    for (const relativeIndexPath of globSync('**/index.html', { cwd: assetPath })) {
        const dir = pathDirname(relativeIndexPath);
        const base = file => join(assetPath, dir, file);
        let html = readFileSync(base('index.html'), 'utf8').replaceAll('__VERSION__', pkg.version);

        if (dir !== 'error') {
            html = html
                .replace('/* CSS_PLACEHOLDER */', readFileSync(base('style.css'), 'utf8'))
                .replace('/* JS_PLACEHOLDER */', readFileSync(base('script.js'), 'utf8'));
        }

        result[dir] = gzipSync(html, { level: 1 }).toString('base64');
    }

    return result;
}

async function buildDevWorker() {
    const htmls = await processHtmlPages();
    const faviconBase64 = readFileSync(join(assetPath, 'favicon.ico')).toString('base64');
    const result = await build({
        entryPoints: [join(projectRoot, 'src/worker.ts')],
        bundle: true,
        format: 'esm',
        write: false,
        external: ['cloudflare:sockets'],
        platform: 'browser',
        target: 'esnext',
        loader: { '.ts': 'ts' },
        define: { VERSION: JSON.stringify(pkg.version) },
        sourcemap: 'inline'
    });

    const script = result.outputFiles[0].text;
    const embeddedContents = {
        SOURCE_CONTENT: gzipSync(script, { level: 1 }).toString('base64'),
        PANEL_HTML_CONTENT: htmls.panel,
        LOGIN_HTML_CONTENT: htmls.login,
        ERROR_HTML_CONTENT: htmls.error,
        PROXY_IP_HTML_CONTENT: htmls['proxy-ip'],
        ICON_CONTENT: faviconBase64
    };

    mkdirSync(distPath, { recursive: true });
    writeFileSync(
        join(distPath, 'worker.js'),
        `Object.assign(globalThis, ${JSON.stringify(embeddedContents)});${script}`,
        'utf8'
    );
    console.log('Development worker built successfully.');
}

buildDevWorker().catch(error => {
    console.error('Development build failed:', error);
    process.exitCode = 1;
});
