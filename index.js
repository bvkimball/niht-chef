#!/usr/bin/env node
const fs = require('fs');
const { extname } = require('path');
const meow = require('meow');
const builtins = require('rollup-plugin-node-builtins');
const commonjs = require('rollup-plugin-commonjs');
const globals = require('rollup-plugin-node-globals');
const nodeResolve = require('rollup-plugin-node-resolve');
const string = require('rollup-plugin-string').string;
const json = require('rollup-plugin-json');
const typescript = require('rollup-plugin-typescript2');
const { terser } = require('rollup-plugin-terser');
const { rollup, watch } = require("rollup");

let pkg = JSON.parse(fs.readFileSync(process.cwd() + '/package.json'))

const WATCH_OPTS = {
	exclude: 'node_modules/**',
};

const nodeExternals = [
  'url', 'http', 'util', 'https', 'zlib', 'stream', 'path',
  'crypto', 'buffer', 'string_decoder', 'querystring', 'punycode',
  'child_process', 'events'
];

const cli = meow(`
  Usage
    $ bundle <input>

  Options
    --out,      -o Output file
    --format,   -f Format
    --minify,   -m Minify
    --external, -e Externals (comma separated)
    --chunks,   -c Chunks (comma separated)
    --name,     -n Name (for UMD builds)
    --exports,     Exports mode
    --string,   -s File extensions to be strings (comma separated)
`, {
  flags: {
    name: {
      type: 'string',
      alias: 'n'
    },
    minify: {
      type: 'boolean',
      alias: 'm',
      default: true
    },
    string: {
      type: 'string',
      alias: 's'
    }
  }
});

// const outFormat = cli.flags.format || cli.flags.f;
if(pkg.source.length === 0) {
  cli.showHelp();
  return;
}

async function compile(outFile, outFormat) {
  let externals = [];
  let isBuiltForNode = outFormat === 'cjs';

  if(isBuiltForNode) {
    externals = Array.from(nodeExternals);
  }

  let externalList = cli.flags.external || cli.flags.e;
  if(externalList) {
    externals.push.apply(externals, externalList.split(','));
  }

  let chunks = void 0;
  if(cli.flags.chunks) {
    chunks = {};
    cli.flags.chunks.split(',').forEach(chunk => {
      let [name, entry] = chunk.split('=');
      chunks[name] = [entry];
    });
  }

  const plugins = [
    json(),
    nodeResolve({
      jsnext: true,
      main: true
    }),
    commonjs({}),
    globals(),
    builtins(),
    http(),
    tsc(pkg.source),
    minify(outFormat)
  ].filter(Boolean);

  let bundle = await rollup({
    input: pkg.source,
    external: externals,
    manualChunks: chunks,
    treeshake: {
      propertyReadSideEffects: false,
    },
    plugins
  });

  let outIsDir = false;
  try {
    outIsDir = fs.lstatSync(outFile).isDirectory();
  } catch {}

  let writeOptions = {
    format: outFormat,
    file: outFile,
    exports: cli.flags.exports || 'named'
  };

  if(cli.flags.name || outFormat === "umd") {
    writeOptions.name = cli.flags.name || pkg.name;
  }

  if(outIsDir) {
    delete writeOptions.file;
    writeOptions.dir = cli.flags.out;

    if(chunks) {
      writeOptions.chunkFileNames = '[name].js';
    }
  }

  await bundle.write(writeOptions);
}

function tsc(entry) {
  // check if source is ts
  if( extname(entry) !== '.ts' || extname(entry) !== '.tsx' ) return false;
  return typescript({
    typescript: require('typescript'),
    cacheRoot: `./node_modules/.cache/.rts2_cache_${format}`,
    tsconfigDefaults: {
      compilerOptions: {
        sourceMap: options.sourcemap,
        declaration: true,
        jsx: 'react',
        jsxFactory: options.jsx || 'h',
      },
    },
    tsconfig: options.tsconfig,
    tsconfigOverride: {
      compilerOptions: {
        target: 'esnext',
      },
    },
  })				
}

function minify(outFormat) {
  if (!cli.flags.minify) return false;
  const minifyOptions = pkg.minify || {}
  return terser({
      sourcemap: true,
      compress: Object.assign(
        {
          keep_infinity: true,
          pure_getters: true,
          passes: 10,
        },
        minifyOptions.compress || {},
      ),
      warnings: true,
      ecma: 9,
      toplevel: outFormat === 'cjs' || outFormat === 'es',
      mangle: Object.assign({}, minifyOptions.mangle || {}),
    })
}

function http() {
  let urls = new Map();
  let httpExp = /^https?:\/\//;

  function load(url, isHttps) {
    let http = require('follow-redirects')[isHttps ? 'https' : 'http'];

    return new Promise(function(resolve, reject){
      http.get(url, res => {
        let body = '';
        res.on('data', data => { body += data; });
        res.on('end', () => {
          resolve(body);
        });
      });
    });
  }

  return {
    resolveId(id) {
      let match = httpExp.exec(id);
      if(match) {
        let record = {
          isHttps: match[0] === 'https://',
          url: id
        };

        let idx = id.lastIndexOf('/');
        let pth = id.substr(idx + 1);
        let newId = pth.split('.').shift();
        urls.set(newId, record);
        return newId;
      }
    },
    load(id) {
      if(urls.has(id)) {
        let { url, isHttps } = urls.get(id);
        return load(url, isHttps);
      }
    }
  };
}

async function run() {
  if( pkg.main ) {
    await compile(pkg.main, 'cjs');
  }
  if (pkg.module) {
    await compile(pkg.module, 'es');
  }
  if (pkg.unpkg) {
    await compile(pkg.unpkg, 'umd');
  }
}

run()