/* ============================================================================
   Development Diagnostic Log — the single logging system for this extension.

   WHY THIS FILE EXISTS IN THIS SHAPE
   ----------------------------------
   It is a CLASSIC script that installs `globalThis.YTAR_DEVLOG`, deliberately with
   no `import`/`export` syntax, because it has to serve two kinds of context:

     - the service worker, the side panel and the options page are ES modules and
       reach it via `core/debug.js`, which imports this file for the side effect and
       re-exports named bindings;
     - `content/content.js` and `content/youtube-adapter.js` are CLASSIC scripts
       (content_scripts declares no "type": "module"), so they cannot import
       anything at all. Listing this file in `content_scripts` makes the same engine
       available to them through the shared isolated world.

   One engine, therefore one redaction implementation. A duplicated copy could
   drift, and a drifting copy of the redaction rules is a privacy bug waiting to
   happen.

   WHAT THIS SYSTEM DOES NOT DO
   ----------------------------
   It only observes. Nothing here reads settings, touches the queue, changes a
   prompt, clicks anything, or alters a return value. Every function is a leaf:
   it formats a record, prints it, and forgets it.

   PRIVACY
   -------
   Credentials are redacted by KEY NAME on every object that reaches `data`, at any
   depth, before the entry is formatted or buffered. Long strings are truncated to
   a fixed budget so a full reply cannot flood the console. Prompt and response
   previews are suppressed at NORMAL and only emitted under VERBOSE.
   ========================================================================== */

(function installDevLog(root) {
  'use strict';

  /** Console prefix. Short and greppable, so a whole run can be filtered in devtools. */
  var PREFIX = '[YTAR]';

  var LEVEL = Object.freeze({
    DEBUG: 'DEBUG',
    INFO: 'INFO',
    WARN: 'WARN',
    ERROR: 'ERROR'
  });

  var VERBOSITY = Object.freeze({
    OFF: 'OFF',
    NORMAL: 'NORMAL',
    VERBOSE: 'VERBOSE'
  });

  /**
   * The components that may appear in an entry. Enumerated so a typo shows up as a
   * rejected call rather than as a component name nobody greps for.
   */
  var COMPONENT = Object.freeze({
    CONTENT: 'CONTENT',
    BACKGROUND: 'BACKGROUND',
    QUEUE: 'QUEUE',
    MATCHER: 'MATCHER',
    SEMANTIC_MATCHER: 'SEMANTIC_MATCHER',
    LM_STUDIO: 'LM_STUDIO',
    REPLY: 'REPLY',
    YOUTUBE_ADAPTER: 'YOUTUBE_ADAPTER',
    STORAGE: 'STORAGE',
    SIDEPANEL: 'SIDEPANEL',
    POPUP: 'POPUP',
    TIMER: 'TIMER',
    SYSTEM: 'SYSTEM',
    // Phase 20 — the knowledge base: documents, index lifecycle, retrieval and grounding.
    // Added in 20.2, when the first module that logs under it shipped. It is a separate
    // component rather than more STORAGE/BACKGROUND events because "why did this comment
    // get no answer" is answered by filtering on KNOWLEDGE alone.
    KNOWLEDGE: 'KNOWLEDGE'
  });

  var KNOWN_COMPONENTS = Object.keys(COMPONENT).map(function (k) { return COMPONENT[k]; });
  var KNOWN_LEVELS = Object.keys(LEVEL).map(function (k) { return LEVEL[k]; });

  /**
   * Ring-buffer capacity.
   *
   * Sized for "something broke, scroll back and read it" without letting a long
   * session grow without bound. Oldest entries are dropped once it is full. This is
   * deliberately in-memory only: no database, no backend, nothing persisted.
   */
  var MAX_BUFFER_ENTRIES = 500;

  /** Per-string character budget inside `data`. Generous for diagnostics, finite by design. */
  var MAX_STRING_CHARS = 300;

  /** How much of a prompt/response may be echoed under VERBOSE. */
  var MAX_PREVIEW_CHARS = 1200;

  /**
   * Object keys whose values are replaced with a placeholder wherever they appear,
   * at any nesting depth. Matching is on a lower-cased, punctuation-stripped key so
   * `apiKey`, `api_key` and `API-KEY` are all caught.
   *
   * Deliberately does NOT include a bare `key`: this codebase logs storage keys by
   * name all the time (`STORAGE_READ key=pendingJobs`), and redacting those would
   * destroy the diagnostic value of the storage events.
   */
  var SECRET_KEYS = [
    'apikey', 'authorization', 'authtoken', 'accesstoken', 'refreshtoken',
    'bearer', 'cookie', 'cookies', 'password', 'passwd', 'secret', 'credential',
    'credentials', 'sessionid', 'sessioncookie', 'privatekey', 'clientsecret'
  ];

  var REDACTED = '[redacted]';

  /** Verbosity + enable state. Defaults to OFF so nothing logs until asked for. */
  var config = {
    enabled: false,
    verbosity: VERBOSITY.OFF
  };

  /** Ring buffer of the most recent entries. */
  var buffer = [];
  /** Monotonic counter so dropped entries are visible rather than silently lost. */
  var droppedCount = 0;

  var perf = (typeof performance !== 'undefined' && performance) || null;

  /** High-resolution elapsed source; monotonic wherever the platform offers one. */
  function monotonicNow() {
    if (perf && typeof perf.now === 'function') return perf.now();
    return Date.now();
  }

  function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  /** Lower-case, punctuation-free form of a key, for secret-key matching. */
  function normalizeKey(key) {
    return String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  /** Whether a key name is one that must never have its value logged. */
  function isSecretKey(key) {
    var n = normalizeKey(key);
    for (var i = 0; i < SECRET_KEYS.length; i++) {
      if (n.indexOf(SECRET_KEYS[i]) !== -1) return true;
    }
    return false;
  }

  /**
   * Truncate a string to a budget, marking that it was cut.
   * @param {string} value
   * @param {number} [limit]
   * @returns {string}
   */
  function truncate(value, limit) {
    var max = typeof limit === 'number' && limit > 0 ? limit : MAX_STRING_CHARS;
    var text = String(value);
    if (text.length <= max) return text;
    return text.slice(0, max) + '…[' + (text.length - max) + ' more chars]';
  }

  /**
   * Deep-copy a value into something safe to log: secrets replaced, strings bounded,
   * cycles broken, depth limited.
   *
   * Everything that reaches `data` goes through here, so a caller cannot bypass
   * redaction by nesting a credential two levels down.
   *
   * @param {*} value
   * @param {number} [depth] internal recursion guard
   * @returns {*} a loggable, redacted copy
   */
  function sanitize(value, depth) {
    var level = depth || 0;
    if (level > 4) return '[max depth]';
    if (value === null || value === undefined) return value;

    var type = typeof value;
    if (type === 'string') return truncate(value);
    if (type === 'number' || type === 'boolean') return value;
    if (type === 'bigint') return String(value);
    if (type === 'function') return '[function ' + (value.name || 'anonymous') + ']';
    if (type === 'symbol') return String(value);

    if (value instanceof Error) return sanitizeError(value);

    if (Array.isArray(value)) {
      var arr = [];
      for (var i = 0; i < value.length && i < 50; i++) {
        arr.push(sanitize(value[i], level + 1));
      }
      if (value.length > 50) arr.push('…[' + (value.length - 50) + ' more items]');
      return arr;
    }

    if (isPlainObject(value)) {
      var out = {};
      var keys;
      try {
        keys = Object.keys(value);
      } catch (_) {
        return '[unreadable object]';
      }
      for (var k = 0; k < keys.length; k++) {
        var key = keys[k];
        if (isSecretKey(key)) {
          out[key] = REDACTED;
        } else {
          try {
            out[key] = sanitize(value[key], level + 1);
          } catch (_) {
            out[key] = '[unreadable]';
          }
        }
      }
      return out;
    }

    // Anything exotic (DOM node, Map, class instance) is described, not traversed:
    // walking a DOM node would be both useless in a log and very expensive.
    return '[' + (value.nodeName ? 'node ' + value.nodeName : (value.constructor && value.constructor.name) || typeof value) + ']';
  }

  /**
   * Normalise an Error into a loggable record, keeping the stack because the stack
   * is usually the only thing that identifies the failing line.
   *
   * @param {Error|*} error
   * @returns {{name: string, message: string, stack: string}}
   */
  function sanitizeError(error) {
    if (!error) return { name: 'Error', message: 'unknown error', stack: '' };
    if (typeof error === 'string') return { name: 'Error', message: truncate(error), stack: '' };
    return {
      name: String(error.name || 'Error'),
      message: truncate(error.message || String(error)),
      stack: truncate(error.stack || '', 2000)
    };
  }

  /** Build `run-YYYYMMDD-HHMMSS-xxxxxx`. */
  function newRunId() {
    var d = new Date();
    function pad(n, w) {
      var s = String(n);
      while (s.length < w) s = '0' + s;
      return s;
    }
    var stamp = d.getFullYear() + pad(d.getMonth() + 1, 2) + pad(d.getDate(), 2) + '-' +
      pad(d.getHours(), 2) + pad(d.getMinutes(), 2) + pad(d.getSeconds(), 2);
    return 'run-' + stamp + '-' + randomSuffix();
  }

  /** Build `req-YYYYMMDD-HHMMSS-xxxxxx`, distinct from a run id at a glance. */
  function newRequestId() {
    return 'req-' + newRunId().slice(4);
  }

  /** Six characters of entropy; enough to disambiguate ids, not a security token. */
  function randomSuffix() {
    var alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    var out = '';
    for (var i = 0; i < 6; i++) {
      out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
    }
    return out;
  }

  /** Whether an entry at `level` should be emitted under the current verbosity. */
  function shouldEmit(level) {
    if (!config.enabled) return false;
    if (config.verbosity === VERBOSITY.OFF) return false;
    // ERROR always passes once diagnostics are switched on at all.
    if (level === LEVEL.ERROR) return true;
    if (config.verbosity === VERBOSITY.VERBOSE) return true;
    if (level === LEVEL.DEBUG) return false;
    return true;
  }

  /** Render `key=value` pairs for the console line, skipping empties. */
  function formatFields(data, extra) {
    var parts = [];
    var source = data || {};
    for (var key in source) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      var value = source[key];
      if (value === undefined || value === null || value === '') continue;
      parts.push(key + '=' + formatValue(value));
    }
    if (extra) {
      for (var k in extra) {
        if (!Object.prototype.hasOwnProperty.call(extra, k)) continue;
        if (extra[k] === undefined || extra[k] === null || extra[k] === '') continue;
        parts.push(k + '=' + formatValue(extra[k]));
      }
    }
    return parts.join(' ');
  }

  function formatValue(value) {
    if (typeof value === 'string') return value.indexOf(' ') === -1 ? value : JSON.stringify(truncate(value, 120));
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try {
      return JSON.stringify(value);
    } catch (_) {
      return '[unserialisable]';
    }
  }

  /**
   * Emit one diagnostic entry.
   *
   * The single funnel every other function here goes through. Always returns the
   * entry (even when suppressed) so callers can pass it on without branching.
   *
   * @param {Object} entry
   * @param {string} entry.component  one of COMPONENT
   * @param {string} entry.event      SCREAMING_SNAKE, e.g. REQUEST_START
   * @param {string} [entry.level]    defaults to INFO
   * @param {string} [entry.message]  human-readable detail
   * @param {string} [entry.runId]
   * @param {string} [entry.commentId]
   * @param {string} [entry.requestId]
   * @param {number} [entry.durationMs]
   * @param {Object} [entry.data]     sanitized before use
   * @param {Error}  [entry.error]
   * @param {boolean}[entry.preview]  allow a prompt/response excerpt (VERBOSE only)
   * @returns {Object|null} the buffered entry, or null when suppressed
   */
  function log(entry) {
    var e = entry || {};
    var level = KNOWN_LEVELS.indexOf(e.level) !== -1 ? e.level : LEVEL.INFO;
    var component = KNOWN_COMPONENTS.indexOf(e.component) !== -1 ? e.component : COMPONENT.SYSTEM;
    var event = String(e.event || 'UNSPECIFIED');

    var record = {
      timestamp: new Date().toISOString(),
      level: level,
      component: component,
      event: event,
      message: e.message ? truncate(e.message) : ''
    };
    if (e.runId) record.runId = String(e.runId);
    if (e.commentId) record.commentId = String(e.commentId);
    if (e.requestId) record.requestId = String(e.requestId);
    if (typeof e.durationMs === 'number' && isFinite(e.durationMs)) {
      record.durationMs = Math.round(e.durationMs * 1000) / 1000;
    }
    if (e.error) record.error = sanitizeError(e.error);
    if (e.data !== undefined) record.data = sanitize(e.data);
    // A prompt/response excerpt is opt-in per call AND verbosity-gated, so the default
    // diagnostic log never contains a full reply.
    if (e.preview !== undefined) {
      record.preview = config.verbosity === VERBOSITY.VERBOSE
        ? truncate(String(e.preview), MAX_PREVIEW_CHARS)
        : '[preview hidden — set diagnostics to VERBOSE]';
    }

    if (!shouldEmit(level)) return null;

    var header = PREFIX + '[' + component + '][' + level + ']';
    if (record.runId) header += '[' + record.runId + ']';
    if (record.commentId) header += '[' + record.commentId + ']';

    var tail = formatFields(record.data);
    var duration = record.durationMs === undefined ? '' : ' duration=' + record.durationMs + 'ms';
    var line = header + ' ' + event + duration +
      (record.message ? ' ' + record.message : '') +
      (tail ? ' ' + tail : '');

    if (record.error) line += ' error=' + record.error.name + ': ' + record.error.message;

    if (level === LEVEL.ERROR) console.error(line);
    else if (level === LEVEL.WARN) console.warn(line);
    else console.log(line);

    buffer.push(record);
    while (buffer.length > MAX_BUFFER_ENTRIES) {
      buffer.shift();
      droppedCount++;
    }
    return record;
  }

  /**
   * Start a timed operation. The returned handle produces the matching END or ERROR
   * entry, so a START can never be logged without its completion.
   *
   * `endEvent` / `errorEvent` override the derived `<base>_END` / `<base>_ERROR`
   * names, for the operations whose success is worth naming differently — a side panel
   * that opens reports SIDEPANEL_INIT_SUCCESS, not SIDEPANEL_INIT_END.
   *
   * @param {Object} spec
   * @param {string} spec.component
   * @param {string} spec.event      base name; `_START` is appended
   * @param {string} [spec.endEvent]   name for the completion entry
   * @param {string} [spec.errorEvent] name for the failure entry
   * @param {Object} [spec.fields]   merged into every entry (runId, commentId, data)
   * @returns {{done: Function, fail: Function, elapsed: Function}}
   */
  function startTimer(spec) {
    var s = spec || {};
    var startedAt = monotonicNow();
    var base = s.event || 'OPERATION';
    var endName = s.endEvent || base + '_END';
    var errorName = s.errorEvent || base + '_ERROR';
    var shared = {
      component: s.component,
      level: LEVEL.INFO,
      runId: s.runId,
      commentId: s.commentId,
      requestId: s.requestId,
      data: s.data
    };

    log(Object.assign({}, shared, {
      event: base + '_START',
      message: s.startMessage
    }));

    function elapsed() {
      return monotonicNow() - startedAt;
    }

    return {
      elapsed: elapsed,
      done: function (fields) {
        return log(Object.assign({}, shared, {
          event: endName,
          level: (fields && fields.level) || LEVEL.INFO,
          durationMs: elapsed(),
          data: mergeData(s.data, fields)
        }));
      },
      fail: function (error, fields) {
        return log(Object.assign({}, shared, {
          event: errorName,
          level: LEVEL.ERROR,
          durationMs: elapsed(),
          error: error,
          data: mergeData(s.data, fields)
        }));
      }
    };
  }

  /** Shallow-merge two optional data objects; `override` wins. */
  function mergeData(base, override) {
    if (!base && !override) return undefined;
    return Object.assign({}, base || {}, override || {});
  }

  var api = {
    PREFIX: PREFIX,
    LEVEL: LEVEL,
    VERBOSITY: VERBOSITY,
    COMPONENT: COMPONENT,
    MAX_BUFFER_ENTRIES: MAX_BUFFER_ENTRIES,

    /**
     * Turn diagnostics on or off. `verbosity` is one of VERBOSITY; OFF is equivalent
     * to `enabled: false`, so a caller never has to pass two flags to silence output.
     *
     * @param {{enabled?: boolean, verbosity?: string}} next
     */
    configure: function (next) {
      var n = next || {};
      if (typeof n.enabled === 'boolean') config.enabled = n.enabled;
      if (n.verbosity && Object.keys(VERBOSITY).some(function (k) { return VERBOSITY[k] === n.verbosity; })) {
        config.verbosity = n.verbosity;
      }
      if (config.verbosity === VERBOSITY.OFF) config.enabled = false;
      return api.getConfig();
    },

    getConfig: function () {
      return { enabled: config.enabled, verbosity: config.enabled ? config.verbosity : VERBOSITY.OFF };
    },

    isEnabled: function () {
      return shouldEmit(LEVEL.INFO);
    },

    isVerbose: function () {
      return config.enabled && config.verbosity === VERBOSITY.VERBOSE;
    },

    newRunId: newRunId,
    newRequestId: newRequestId,
    log: log,
    startTimer: startTimer,

    /** Shorthands, so call sites read as `devLog.info(COMPONENT.X, 'EVENT', {...})`. */
    debug: function (component, event, fields) {
      return log(Object.assign({ component: component, event: event, level: LEVEL.DEBUG }, fields));
    },
    info: function (component, event, fields) {
      return log(Object.assign({ component: component, event: event, level: LEVEL.INFO }, fields));
    },
    warn: function (component, event, fields) {
      return log(Object.assign({ component: component, event: event, level: LEVEL.WARN }, fields));
    },
    error: function (component, event, fields) {
      return log(Object.assign({ component: component, event: event, level: LEVEL.ERROR }, fields));
    },

    /** Recent entries, oldest first. A copy, so a caller cannot mutate the buffer. */
    getEntries: function () {
      return buffer.slice();
    },

    entryCount: function () {
      return buffer.length;
    },

    /** How many entries the bounded buffer has discarded since it started. */
    droppedCount: function () {
      return droppedCount;
    },

    clearEntries: function () {
      buffer.length = 0;
      droppedCount = 0;
    },

    // Exposed for the logging tests and for anyone redacting something unusual by hand.
    sanitize: sanitize,
    sanitizeError: sanitizeError,
    isSecretKey: isSecretKey,
    truncate: truncate
  };

  root.YTAR_DEVLOG = api;
})(typeof globalThis !== 'undefined' ? globalThis : self);