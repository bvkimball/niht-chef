#!/usr/bin/env node
const fs = require("fs")
const { extname } = require("path")
const meow = require("meow")
const builtins = require("rollup-plugin-node-builtins")
const commonjs = require("rollup-plugin-commonjs")
const globals = require("rollup-plugin-node-globals")
const nodeResolve = require("rollup-plugin-node-resolve")
const urlResolve = require("rollup-plugin-url-resolve")
const unpkg = require("rollup-plugin-unpkg")
const string = require("rollup-plugin-string").string
const json = require("rollup-plugin-json")
const typescript = require("rollup-plugin-typescript2")
const { terser } = require("rollup-plugin-terser")
const { rollup, watch } = require("rollup")
const { blue, bold, red, dim } = require("kleur")

const stdout = console.log.bind(console)
const stderr = console.error.bind(console)
const logError = err => {
  const error = err.error || err
  const message = `${error.name ? error.name + ": " : ""}${error.message || error}`
  stderr(red().bold(message))
  if (error.loc) {
    stderr()
    stderr(`at ${error.loc.file}:${error.loc.line}:${error.loc.column}`)
  }
  if (error.frame) {
    stderr()
    stderr(dim(error.frame))
  } else if (err.stack) {
    const headlessStack = error.stack.replace(message, "")
    stderr(dim(headlessStack))
  }
  stderr()
}

let pkg = JSON.parse(fs.readFileSync(process.cwd() + "/package.json"))

const WATCH_OPTS = {
  exclude: "node_modules/**",
}

const nodeExternals = ["url", "http", "util", "https", "zlib", "stream", "path", "crypto", "buffer", "string_decoder", "querystring", "punycode", "child_process", "events"]

const cli = meow(
  `
  Usage
    $ bake <input>

  Options
    --output,      -o Output file
    --watch,    -w Watch
    --format,   -f Format
    --minify,   -m Minify
    --external, -e Externals (comma separated)
    --chunks,   -c Chunks (comma separated)
    --name,     -n Name (for UMD builds)
    --exports,     Exports mode
    --string,   -s File extensions to be strings (comma separated)
`,
  {
    flags: {
      name: {
        type: "string",
        alias: "n",
      },
      external: {
        type: "string",
        alias: "e",
      },
      minify: {
        type: "boolean",
        alias: "m",
        default: false,
      },
      watch: {
        type: "boolean",
        alias: "w",
        default: false,
      },
      string: {
        type: "string",
        alias: "s",
      },
      out: {
        type: "string",
        alias: "o",
      },
    },
  }
)

async function compile(source, outFile, outFormat) {
  let externals = []
  let isBuiltForNode = outFormat === "cjs"

  if (isBuiltForNode) {
    externals = Array.from(nodeExternals)
  }

  let externalList = cli.flags.external || cli.flags.e
  if (externalList) {
    externals.push.apply(externals, externalList.split(","))
  }

  let chunks = void 0
  if (cli.flags.chunks) {
    chunks = {}
    cli.flags.chunks.split(",").forEach(chunk => {
      let [name, entry] = chunk.split("=")
      chunks[name] = [entry]
    })
  }

  const plugins = [
    json(),
    // resolveUrls(outFormat),
    nodeResolve({
      jsnext: true,
      main: true,
      browser: outFormat === "es",
    }),
    commonjs({
      include: /\/node_modules\//,
    }),
    globals(),
    builtins(),
    http(),
    tsc(source, outFormat),
    minify(outFormat),
  ].filter(Boolean)

  const readOptions = {
    input: source,
    external: externals,
    manualChunks: chunks,
    treeshake: {
      propertyReadSideEffects: false,
    },
    plugins,
  }
  let writeOptions = {
    format: outFormat,
    file: outFile,
    exports: cli.flags.exports || "named",
  }

  if (cli.flags.name || outFormat === "umd") {
    writeOptions.name = cli.flags.name || pkg.name
  }
  try {
    let outIsDir = fs.lstatSync(outFile).isDirectory()
    if (outIsDir) {
      delete writeOptions.file
      writeOptions.dir = outFile
      if (chunks) {
        writeOptions.chunkFileNames = "[name].js"
      }
    }
  } catch {}

  if (cli.flags.watch) {
    stdout(blue(`watching the oven...`))
    watch({
      ...readOptions,
      watch: WATCH_OPTS,
      output: writeOptions,
    }).on("event", e => {
      if (e.code === "FATAL") {
        return reject(e.error)
      } else if (e.code === "ERROR") {
        logError(e.error)
      }
    })
  } else {
    let bundle = await rollup(readOptions)
    await bundle.write(writeOptions)
    stdout(blue(`fully baked ${bold(outFile)}!`))
  }
}

function resolveUrls(outFormat) {
  if (outFormat !== "es") return urlResolve()
  const transform = (name, version) => `https://cdn.pika.dev/${name}/v${version[0]}`
  return unpkg({ transform, autoDiscoverExternals: false })
}

function tsc(entry, format) {
  // check if source is ts
  if (extname(entry) === ".ts" || extname(entry) === ".tsx") {
    return typescript({
      typescript: require("typescript"),
      cacheRoot: `./node_modules/.cache/.rts2_cache_${format}`,
      tsconfigDefaults: {
        compilerOptions: {
          experimentalDecorators: true,
          sourceMap: false,
          declaration: true,
          jsx: "react",
          jsxFactory: "h",
        },
      },
      tsconfig: "tsconfig.json",
      tsconfigOverride: {
        compilerOptions: {
          // target: "es5",
        },
      },
    })
  }
  return false
}

function minify(outFormat) {
  if (!cli.flags.minify) return false
  const minifyOptions = pkg.minify || {}
  return terser({
    sourcemap: true,
    compress: Object.assign(
      {
        keep_infinity: true,
        pure_getters: true,
        passes: 10,
      },
      minifyOptions.compress || {}
    ),
    warnings: true,
    ecma: 9,
    toplevel: outFormat === "cjs" || outFormat === "es",
    mangle: Object.assign({}, minifyOptions.mangle || {}),
  })
}

function http() {
  let urls = new Map()
  let httpExp = /^https?:\/\//

  function load(url, isHttps) {
    let http = require("follow-redirects")[isHttps ? "https" : "http"]

    return new Promise(function(resolve, reject) {
      http.get(url, res => {
        let body = ""
        res.on("data", data => {
          body += data
        })
        res.on("end", () => {
          resolve(body)
        })
      })
    })
  }

  return {
    resolveId(id) {
      let match = httpExp.exec(id)
      if (match) {
        let record = {
          isHttps: match[0] === "https://",
          url: id,
        }

        let idx = id.lastIndexOf("/")
        let pth = id.substr(idx + 1)
        let newId = pth.split(".").shift()
        urls.set(newId, record)
        return newId
      }
    },
    load(id) {
      if (urls.has(id)) {
        let { url, isHttps } = urls.get(id)
        return load(url, isHttps)
      }
    },
  }
}

async function run() {
  if (!pkg.source && cli.input.length === 0) {
    cli.showHelp()
    return
  }
  if (cli.input.length === 0) {
    if (pkg.main) {
      stdout(dim(`baking ${blue().italic(pkg.source)} as ${pkg.browser ? "es" : "cjs"} module`))
      await compile(pkg.source, pkg.main, pkg.browser ? "es" : "cjs")
    }
    if (pkg.module) {
      stdout(dim(`baking ${blue().italic(pkg.source)} as ES module`))
      await compile(pkg.source, pkg.module, "es")
    }
    if (pkg.unpkg) {
      stdout(dim(`baking ${blue().italic(pkg.source)} as UMD module`))
      await compile(pkg.source, pkg.unpkg, "umd")
    }
  } else {
    stdout(dim(`baking ${blue().italic(cli.input)}...`))
    const outFile = cli.flags.output || cli.flags.o || "baked.js"
    const outFormat = cli.flags.format || cli.flags.f || "cjs"
    await compile(`${cli.input}`, outFile, outFormat)
  }
}

run()
