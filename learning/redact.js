// redact.js — Strip secrets from tool input/output before anything reaches disk.
//
// Known token shapes are replaced outright. Values of key/value pairs whose key names a
// credential (token, secret, password, api_key, authorization…) are replaced too.
// Each pattern needs a distinctive prefix or enough length, so ordinary words survive.

const R = '[REDACTED]';

const TOKEN_PATTERNS = [
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bsk-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}/g,
  /\bntn_[A-Za-z0-9]{20,}/g,
  /\bsecret_[A-Za-z0-9]{32,}/g,
  /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\bya29\.[A-Za-z0-9_-]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9\/_-]+/g,
];

// "scheme://user:password@host": keep the user, drop the password.
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@\/]+:)[^\s@\/]+@/gi;

// "Bearer <token>": keep the scheme, drop the token. Tokens must contain a digit so
// prose such as "Bearer authentication" stays.
const BEARER = /\b(Bearer\s+)(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{8,}/gi;

// Credential-looking key names. "tokens" (max_tokens, num_tokens) and "tokenizer" are counts
// and settings, not credentials.
const SENSITIVE_KEY = /token(?!s(?![a-z])|iz)|secret|passw(?:or)?d|api[_-]?key|apikey|authorization/i;
const KEY = '[A-Za-z0-9_.-]*';

// "key": "value"  /  'key': 'value'   (JSON and JS object literals)
const KV_QUOTED = new RegExp(`(["'])(${KEY})\\1(\\s*:\\s*)(["'])((?:\\\\.|(?!\\4)[^\\\\])*)\\4`, 'g');
// key=value  /  key = "value"   (shell, env files, query strings, CLI flags, code literals).
// Spaces around "=" only count before a quoted value, so `token = getToken()` stays.
const KV_EQUALS = new RegExp(`(^|[^A-Za-z0-9_.-])(${KEY})(\\s*=\\s*(?=["'])|=)("[^"]*"|'[^']*'|[^\\s&"',;)]+)`, 'gm');
// key: value  (headers, YAML). Unquoted, so the value must contain a digit to count.
const KV_COLON = new RegExp(`(^|[\\s"'{,])(${KEY})(:[ \\t]*)((?=[^\\s"',;]*\\d)[^\\s"',;]{6,})`, 'gm');

function keepValue(value) {
  const v = value.replace(/^["']|["']$/g, '');
  return !v || v.includes(R) || /^[$%]/.test(v);
}

function redactKv(match, pre, key, sep, value) {
  if (!SENSITIVE_KEY.test(key) || keepValue(value)) return match;
  const q = /^["']/.test(value) ? value[0] : '';
  return `${pre}${key}${sep}${q}${R}${q}`;
}

function redact(text) {
  if (typeof text !== 'string' || !text) return text || '';
  let out = text;
  for (const re of TOKEN_PATTERNS) out = out.replace(re, R);
  out = out.replace(BEARER, `$1${R}`);
  out = out.replace(URL_PASSWORD, `$1${R}@`);
  out = out.replace(KV_QUOTED, (m, q1, key, sep, q2, value) =>
    (!SENSITIVE_KEY.test(key) || keepValue(value)) ? m : `${q1}${key}${q1}${sep}${q2}${R}${q2}`);
  out = out.replace(KV_EQUALS, redactKv);
  out = out.replace(KV_COLON, redactKv);
  return out;
}

// JSON.stringify with every string redacted on the way out. Values under a credential-named
// key are dropped whole. maxString cuts long strings first (callers truncate anyway).
function redactJson(value, maxString = Infinity) {
  return JSON.stringify(value, (k, v) => {
    if (typeof v !== 'string') return v;
    if (k && v && SENSITIVE_KEY.test(k)) return R;
    return redact(v.length > maxString ? v.slice(0, maxString) : v);
  });
}

module.exports = { redact, redactJson, REDACTED: R };
