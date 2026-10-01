/* Royale IDE compiler worker.
 *
 * Runs the royale-ts build pipeline entirely in memory (no server): the
 * project comes in as a virtual file system, the frameworks + TypeScript lib
 * definitions come from the generated data scripts, and the built app goes
 * back out as one self-contained HTML document for the preview iframe.
 *
 * The compiler stack is pulled in here (importScripts), in order, so the
 * host only has to `new Worker("scripts/compiler-worker.js")`:
 *   ../generated/typescript.js        global ts          (UMD compiler API)
 *   ../generated/ts-shim.js           ts.sys             (browser stand-in)
 *   ../generated/tslib-data.js        global RoyaleTsLib (lib *.d.ts by name)
 *   ../generated/compiler.js          global RoyaleCompiler
 *   ../generated/frameworks-data.js   global RoyaleFrameworks
 *
 * Message in:  { id, release, config, files }
 *   config — the project's royale.json (object)
 *   files  — the project's virtual file system: path -> text
 * Message out: { id, ok, html?, problems?, stats?, error?, durationMs }
 *   problems — structured, source-positioned:
 *     { file, line?, column?, endLine?, endColumn?, message, severity, code }
 *   where `file` is a source-dir-relative file-map key (a generated MXML
 *   component's `.ts` diagnostics are remapped onto the `.mxml` line via
 *   the compiler's line maps), `line`/`column` are 1-based, and
 *   `severity` is "error" | "warning" | "suggestion" | "info".
 */
importScripts(
  "../generated/typescript.js",
  "../generated/ts-shim.js",
  "../generated/tslib-data.js",
  "../generated/compiler.js",
  "../generated/frameworks-data.js"
);

(function () {
  "use strict";

  const RC = globalThis.RoyaleCompiler;
  const post = (m) => self.postMessage(m);

  if (!RC || !globalThis.ts || !globalThis.RoyaleFrameworks || !globalThis.RoyaleTsLib) {
    // The generated scripts did not load (wrong URL / stale build).
    self.onmessage = (e) =>
      post({ id: e.data && e.data.id, ok: false, error: "compiler worker is missing its generated scripts (re-run tools/gen-data.mjs)" });
    return;
  }

  /** CSS cascade file resolution: project VFS first, then the framework
   * data (config references of the form `…/frameworks/<rel>`). */
  function cssFileText(ref, files) {
    if (Object.prototype.hasOwnProperty.call(files, ref)) return files[ref];
    const i = ref.lastIndexOf("frameworks/");
    if (i !== -1) {
      const key = ref.slice(i + "frameworks/".length);
      const fw = globalThis.RoyaleFrameworks.files;
      if (Object.prototype.hasOwnProperty.call(fw, key)) return fw[key];
    }
    return undefined;
  }

  /**
   * A structured problem for the IDE: the raw compiler problem, with a
   * diagnostic on a generated MXML component (`.ts`) remapped onto its
   * `.mxml` source line via the compiler's line maps (compiler-generated
   * lines map to null and stay at the generated position). The source
   * augmentation is line-preserving, so positions are original-file
   * coordinates.
   */
  function toProblem(p, lineMaps) {
    const pos = p.position;
    let file = p.file;
    let line = pos ? pos.line : undefined;
    let column = pos ? pos.column : undefined;
    let endLine = pos && pos.endLine !== undefined ? pos.endLine : undefined;
    let endColumn = pos && pos.endColumn !== undefined ? pos.endColumn : undefined;
    if (lineMaps && file && pos) {
      const lm = lineMaps.get(file);
      if (lm) {
        const start = lm[line - 1];
        if (start !== null && start !== undefined) {
          const end = endLine !== undefined ? lm[endLine - 1] : null;
          return {
            file: file.replace(/\.ts$/, ".mxml"),
            line: start + 1,
            // The lifted script member is re-indented in the generated
            // source; the original column is not recoverable — line-level.
            column: 1,
            endLine: (end === null || end === undefined ? start : end) + 1,
            message: p.message,
            severity: p.severity,
            code: p.code,
          };
        }
      }
    }
    const out = { file, message: p.message, severity: p.severity, code: p.code };
    if (line !== undefined) out.line = line;
    if (column !== undefined) out.column = column;
    if (endLine !== undefined) out.endLine = endLine;
    if (endColumn !== undefined) out.endColumn = endColumn;
    return out;
  }

  /**
   * MXML well-formedness gate. compileMXML throws on unparseable XML (an
   * Error without a structured position), so every project .mxml is parsed
   * up front and the failures are reported as problems at the .mxml
   * position (parseXML's message carries "(line N, column M)").
   */
  function xmlProblemsFor(keys, fm) {
    const out = [];
    for (const key of keys) {
      if (!key.endsWith(".mxml")) continue;
      try {
        RC.parseXML(fm.get(key));
      } catch (e) {
        const m = String(e.message).match(/\(line (\d+)(?:, column (\d+))?\)/);
        const p = {
          file: key,
          message: String(e.message),
          severity: "error",
          code: "royale/mxml-xml-error",
        };
        if (m) {
          p.line = Number(m[1]);
          if (m[2]) p.column = Number(m[2]);
        }
        out.push(p);
      }
    }
    return out;
  }

  /** Inline the built app's script + CSS into its index.html so the result
   * runs from an opaque origin (blob URL) with no external references. */
  function htmlForPreview(output, script, css) {
    let html = output.get("index.html");
    if (html === undefined) {
      return "<!DOCTYPE html><html><body>no index.html in the project resources</body></html>";
    }
    // The module bootstrap becomes the (classic) bundle script plus the
    // original startup tail — the same shape the CLI's release transform
    // writes to disk.
    const mod = html.match(/<script type="module">([\s\S]*?)<\/script>/);
    if (mod) {
      const importM = mod[1].match(/^\s*import\s*\{[^}]*\}\s*from\s*"[^"]+"\s*;?/m);
      const rest = importM ? mod[1].replace(importM[0], "").trim() : "";
      html = html.replace(
        mod[0],
        `<script type="text/javascript">\n${script}\n</script>\n  <script type="text/javascript">\n    ${rest}\n  </script>`
      );
    }
    // Stylesheet links -> inline <style> (the cascade the build generated).
    html = html.replace(/<link rel="stylesheet" type="text\/css" href="([^"]+)">/g, (m, href) =>
      output.has(href) ? `<style>\n${output.get(href)}\n</style>` : m
    );
    if (css !== undefined && cfgCssOutFile) {
      html = html.replace(/<link rel="stylesheet" type="text\/css" href="([^"]+)">/g, (m, href) =>
        href === cfgCssOutFile ? `<style>\n${css}\n</style>` : m
      );
    }
    // Any remaining local asset (font/image) referenced by the page or the
    // inlined CSS becomes a data: URI.
    const dataUri = (text, mime) =>
      "data:" + mime + ";base64," + btoa(unescape(encodeURIComponent(text)));
    const mimeOf = (p) =>
      p.endsWith(".css") ? "text/css"
      : p.endsWith(".js") ? "text/javascript"
      : p.endsWith(".svg") ? "image/svg+xml"
      : p.endsWith(".png") ? "image/png"
      : p.endsWith(".gif") ? "image/gif"
      : p.endsWith(".jpg") || p.endsWith(".jpeg") ? "image/jpeg"
      : p.endsWith(".woff2") ? "font/woff2"
      : p.endsWith(".woff") ? "font/woff"
      : p.endsWith(".ttf") ? "font/ttf"
      : "application/octet-stream";
    const refs = new Set();
    for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) if (m[1] && !/^(data:|https?:|\/\/|#)/.test(m[1])) refs.add(m[1].split(/[?#]/)[0]);
    for (const m of html.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) if (m[1] && !/^(data:|https?:|\/\/|#)/.test(m[1])) refs.add(m[1].split(/[?#]/)[0]);
    for (const ref of refs) {
      if (!output.has(ref)) continue;
      const uri = dataUri(output.get(ref), mimeOf(ref));
      html = html.split('"' + ref + '"').join('"' + uri + '"');
      html = html.split("'" + ref + "'").join("'" + uri + "'");
      html = html.split("(" + ref + ")").join("(" + uri + ")");
    }
    return html;
  }

  let cfgCssOutFile = null;

  function buildProject(msg) {
    const t0 = Date.now();
    const done = (r) => { r.durationMs = Date.now() - t0; post(Object.assign({ id: msg.id }, r)); };
    const fail = (error) => done({ ok: false, error: String((error && error.message) || error) });

    let cfg;
    try {
      cfg = RC.parseProjectConfig(msg.config, "royale.json");
    } catch (e) {
      return fail(e);
    }
    const files = msg.files;

    // 1. FileMap: TS lib definitions + frameworks + the project source tree.
    const fm = new RC.FileMap();
    for (const k of Object.keys(globalThis.RoyaleTsLib)) fm.add(k, globalThis.RoyaleTsLib[k]);
    for (const k of Object.keys(globalThis.RoyaleFrameworks.files)) fm.add(k, globalThis.RoyaleFrameworks.files[k]);
    const srcDir = cfg.sourceDir.replace(/\\/g, "/");
    const srcPrefix = srcDir + "/";
    const projectSrcKeys = [];
    for (const k of Object.keys(files)) {
      if (!k.startsWith(srcPrefix)) continue;
      const rel = k.slice(srcPrefix.length);
      if (rel.endsWith(".ts") || rel.endsWith(".mxml")) {
        fm.add(rel, files[k]);
        projectSrcKeys.push(rel);
      }
    }

    // 2. Entry (file-map key, relative to the source dir).
    let entryKey = RC.normalizePath(cfg.entry);
    if (entryKey.startsWith(srcPrefix)) entryKey = entryKey.slice(srcPrefix.length);
    if (!fm.has(entryKey)) return fail(`entry "${cfg.entry}" not found in the project`);

    // 2b. MXML well-formedness gate (see xmlProblemsFor): an unparseable
    // .mxml would otherwise surface as a raw compileMXML throw.
    const xmlProblems = xmlProblemsFor(projectSrcKeys, fm);
    if (xmlProblems.length) return done({ ok: false, problems: xmlProblems });

    // 3. CSS cascade: cssBundle files + inline <fx:Style> (CLI parity).
    let cssFiles = null;
    if (cfg.cssBundle) {
      cssFiles = [];
      for (const ref of cfg.cssBundle.files) {
        const text = cssFileText(ref, files);
        if (text === undefined) return fail(`cssBundle file not found: ${ref}`);
        cssFiles.push({ path: ref, text });
      }
      for (const key of projectSrcKeys) {
        if (!key.endsWith(".mxml")) continue;
        let model;
        try {
          model = RC.parseMXML(RC.parseXML(fm.get(key)));
        } catch (e) {
          continue;
        }
        (model.styles ?? []).forEach((style, i) => {
          if (style.text) cssFiles.push({ path: `${key} (fx:Style ${i + 1})`, text: style.text });
        });
      }
    }

    // 4. Resolvers, manifests, roots.
    const manifests = new Map(Object.entries(globalThis.RoyaleFrameworks.manifests));
    const resolveModule = RC.makeClassResolver(fm);
    const resolveTypeName = RC.makeTypeNameResolver(fm, manifests);
    const entryTs = entryKey.replace(/\.mxml$/, ".ts");
    const entryDir = entryKey.includes("/") ? entryKey.slice(0, entryKey.lastIndexOf("/")) : "";
    const roots = [entryTs];
    if (!cfg.goldenLayout) roots.push(entryDir ? `${entryDir}/main.ts` : "main.ts");
    for (const raw of cfg.emitRoots ?? []) {
      const root = raw.endsWith(".mxml") ? raw.slice(0, -5) + ".ts" : raw;
      if (!fm.has(root) && !fm.has(raw)) return fail(`emitRoots entry "${raw}" not found in the file map`);
      roots.push(root);
    }

    // 5. Compile: with a cssBundle the two-pass activation (the full cascade
    // discovers the linked class set; the pass that emits uses it).
    const compileWith = (cssDataInline) =>
      RC.compileMXML({
        files: fm,
        entry: entryKey,
        options: cfg.compilerOptions,
        manifest: RC.manifestFromProject(cfg.namespaces),
        cssDataInline,
        roots,
        frameworkModules: globalThis.RoyaleFrameworks.modules,
        checkAllFiles: true,
      });
    let activeQNames;
    let result;
    if (cfg.cssBundle && cssFiles) {
      const firstPass = compileWith(RC.generateCSSDataModule(cssFiles, { resolveModule, resolveTypeName }));
      if (!firstPass.success)
        return done({
          ok: false,
          problems: firstPass.problems.map((p) => toProblem(p, firstPass.lineMaps)),
        });
      activeQNames = RC.activeQNamesFromEmittedFiles(firstPass.emittedFiles);
      result = compileWith(RC.generateCSSDataModule(cssFiles, { resolveModule, resolveTypeName, activeQNames }));
    } else {
      result = compileWith(undefined);
    }
    if (!result.success)
      return done({ ok: false, problems: result.problems.map((p) => toProblem(p, result.lineMaps)) });

    // 6. Output tree: staged resources (minus removePaths) + emitted JS/maps
    //    + the generated browser CSS.
    const output = new Map();
    for (const dir of cfg.resources ?? []) {
      const d = dir.replace(/\\/g, "/");
      for (const k of Object.keys(files)) {
        if (k.startsWith(d + "/")) output.set(k.slice(d.length + 1), files[k]);
      }
    }
    for (const p of cfg.removePaths ?? []) {
      const d = p.replace(/\\/g, "/");
      for (const k of [...output.keys()]) if (k === d || k.startsWith(d + "/")) output.delete(k);
    }
    for (const ef of result.emittedFiles)
      if (ef.kind === "js" || ef.kind === "map") output.set(ef.path, ef.text);
    cfgCssOutFile = cfg.cssBundle ? cfg.cssBundle.outFile : null;
    if (cfg.cssBundle && cssFiles) {
      output.set(
        cfgCssOutFile,
        RC.generateBrowserCSS(cssFiles, { resolveTypeName, activeQNames })
      );
    }

    // 7. Bundle + (release) minify, then fold everything into one document.
    const entryEmit = result.emittedFiles.find((f) => f.kind === "js" && f.sourceFile === entryTs);
    if (!entryEmit) return fail("entry module not found in the emitted output");
    const jsFiles = result.emittedFiles.filter((f) => f.kind === "js").map((f) => ({ path: f.path, text: f.text }));
    let bundle;
    try {
      bundle = RC.bundleESMModules(jsFiles, entryEmit.path);
    } catch (e) {
      return fail("bundle: " + ((e && e.message) || e));
    }
    let script = bundle.code;
    let css = cfgCssOutFile ? (output.get(cfgCssOutFile) ?? "") : "";
    if (msg.release) {
      script = RC.minifyReleaseBundle(bundle.code, { reserved: bundle.entryGlobalNames }).code;
      css = RC.minifyCSSString(css);
    }
    return done({
      ok: true,
      html: htmlForPreview(output, script, css),
      problems: result.problems.map((p) => toProblem(p, result.lineMaps)),
      stats: {
        modules: jsFiles.length,
        scriptBytes: script.length,
        cssBytes: css.length,
        release: !!msg.release,
      },
    });
  }

  self.onmessage = (e) => {
    try {
      buildProject(e.data);
    } catch (err) {
      // A structured fx:Script codegen error (file + line) becomes a build
      // problem, so the IDE annotates the offending line in the open editor;
      // anything else stays a plain error string.
      if (err && err.mxmlFile && err.mxmlLine) {
        post({
          id: e.data && e.data.id,
          ok: false,
          problems: [
            {
              file: err.mxmlFile,
              line: err.mxmlLine,
              column: 1,
              message: String(err.message).replace(/^<fx:Script> line \d+: /, ""),
              severity: "error",
              code: "royale/mxml-script",
            },
          ],
        });
        return;
      }
      post({ id: e.data && e.data.id, ok: false, error: String((err && err.stack) || err) });
    }
  };
})();
