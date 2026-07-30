/**
 * Build Script for JavaScript Bundling
 * Bundles all JS modules into a single file for production
 */

const esbuild = require('esbuild');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const RELEASE_DIR = '../../release/admin';
const STATIC_DIR = path.join(RELEASE_DIR, 'static');

function makeBuildId() {
    // New build id every run to force browser cache invalidation.
    return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function getBuildConfig(jsFilePath) {
    return {
        entryPoints: ['./src/app.js'],
        outfile: jsFilePath,
        bundle: true,
        minify: true,
        sourcemap: true,
        target: 'es2020',
        format: 'esm',
        external: [
            // CDN modules — dynamic import(), resolved at runtime via import map
            'xterm',
            '@xterm/xterm',
            '@xterm/addon-fit',
            'monaco-editor',
            // lit-core + the markdown pipeline (marked, highlight.js, dompurify)
            // ARE bundled (Phase 6 #4) as plain npm deps from node_modules, so
            // they must NOT be listed here. Heavy lazy-load libs (Mermaid,
            // MathJax) stay CDN but are not bare specifiers (loaded via script).
        ],
        define: {
            'process.env.NODE_ENV': '"production"'
        },
    };
}

console.log('🚀 Starting JavaScript build...');

async function build() {
    try {
        if (!fs.existsSync(STATIC_DIR)) {
            fs.mkdirSync(STATIC_DIR, { recursive: true });
        }

        const buildId = makeBuildId();
        const jsFileName = `app.${buildId}.js`;
        const cssFileName = `style.${buildId}.css`;
        const jsFilePath = path.join(STATIC_DIR, jsFileName);

        cleanOldVersionedAssets(STATIC_DIR);

        // Build bundle
        const result = await esbuild.build(getBuildConfig(jsFilePath));

        if (result.errors.length === 0) {
            console.log('✅ Build completed successfully!');
            console.log(`📁 Output: ${jsFilePath}`);
            console.log(`📏 Size: ${formatFileSize(fs.statSync(jsFilePath).size)}`);

            // Generate index.html with bundled version
            generateIndexHtml(jsFileName, cssFileName);
            writeAssetManifest(buildId, jsFileName, cssFileName);
        } else {
            console.error('❌ Build failed with errors:');
            result.errors.forEach(error => {
                console.error(`  - ${error.location?.file}:${error.location?.line}:${error.location?.column}: ${error.text}`);
            });
        }
    } catch (error) {
        console.error('❌ Build failed:', error.message);
        process.exit(1);
    }
}

function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function cleanOldVersionedAssets(staticOutDir) {
    if (!fs.existsSync(staticOutDir)) return;

    const entries = fs.readdirSync(staticOutDir);
    for (const fileName of entries) {
        const isVersionedApp = /^app\.[a-z0-9-]+\.js(\.map)?$/i.test(fileName);
        const isVersionedStyle = /^style\.[a-z0-9-]+\.css$/i.test(fileName);
        if (isVersionedApp || isVersionedStyle) {
            fs.unlinkSync(path.join(staticOutDir, fileName));
        }
    }
}

function generateIndexHtml(jsFileName, cssFileName) {
    const originalHtml = fs.readFileSync('./index.html', 'utf8');

    // Remove all src/ module imports (bundled into panel.js)
    let bundledHtml = originalHtml.replace(
        /^\s*<script type="module" src=".\/src\/[^"]+"><\/script>\s*$/gm,
        ''
    );
    // Remove leftover comment for the media/pdf viewer modules block
    bundledHtml = bundledHtml.replace(
        /^\s*<!-- Media \/ PDF Viewer Modules -->\s*$/gm,
        ''
    );

    // Replace app stylesheet with versioned output.
    bundledHtml = bundledHtml.replace(
        /<link rel="stylesheet" href="\.\/static\/style\.css"\s*\/?>/,
        `<link rel="stylesheet" href="./static/${cssFileName}">`
    );

    // Insert bundled app.js import before closing </body>
    bundledHtml = bundledHtml.replace(
        /^(\s*)<!-- Main Application Script.*-->\s*$/gm,
        `$1<script type="module" src="./static/${jsFileName}"></script>`
    );

    // Remove Monaco loader script
    const cleanedHtml = bundledHtml.replace(
        /<script src=".\/static\/node_modules\/monaco-editor\/min\/vs\/loader\.js"><\/script>/,
        '<!-- Monaco loaded from CDN -->'
    );

    // Write production index.html to release/admin/
    const outDir = RELEASE_DIR;
    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
    }
    fs.writeFileSync(path.join(outDir, 'index.html'), cleanedHtml);
    console.log('📄 Generated release/admin/index.html');

    // Copy static CSS to release/admin/static/
    const staticOutDir = path.join(outDir, 'static');
    if (!fs.existsSync(staticOutDir)) {
        fs.mkdirSync(staticOutDir, { recursive: true });
    }

    const srcCss = path.join('./static', 'style.css');
    const outCss = path.join(staticOutDir, cssFileName);
    if (fs.existsSync(srcCss)) {
        fs.copyFileSync(srcCss, outCss);
        console.log(`📄 Copied style.css → ../../release/admin/static/${cssFileName}`);
    }

    // Copy manifest.json to release/admin/static/
    const srcManifest = path.join('./static', 'manifest.json');
    const outManifest = path.join(staticOutDir, 'manifest.json');
    if (fs.existsSync(srcManifest)) {
        fs.copyFileSync(srcManifest, outManifest);
        console.log(`📄 Copied manifest.json → ../../release/admin/static/manifest.json`);
    }

    // Copy size-specific icons to release/admin/static/
    const iconFiles = ['icon_24_color.svg', 'icon_32_color.svg', 'icon_48_color.svg'];
    iconFiles.forEach(file => {
        const srcIcon = path.join('./static', file);
        const outIcon = path.join(staticOutDir, file);
        if (fs.existsSync(srcIcon)) {
            fs.copyFileSync(srcIcon, outIcon);
            console.log(`📄 Copied ${file} → ../../release/admin/static/${file}`);
        }
    });
}

function writeAssetManifest(buildId, jsFileName, cssFileName) {
    const manifest = {
        buildId,
        js: `./static/${jsFileName}`,
        css: `./static/${cssFileName}`,
        builtAt: new Date().toISOString(),
    };
    const manifestPath = path.join(RELEASE_DIR, 'asset-manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log('📄 Generated release/admin/asset-manifest.json');
}

// Run build
build();
