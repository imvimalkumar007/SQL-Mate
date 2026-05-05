// Phase 9: SQL display block with hand-rolled syntax highlighting + copy button.
//
// We deliberately do not pull in highlight.js / Prism / Shiki for this — the
// surface needed (one language, dark + light themes, no line numbers, no
// language switching) is small enough that a 60-line tokenizer is the
// honest answer. Bundle stays slim and there's no third-party update
// surface in the security review pack.

import { useState } from "react";

type TokenKind =
  | "keyword"
  | "function"
  | "string"
  | "number"
  | "comment"
  | "punct"
  | "ident";

const KEYWORDS = new Set([
  "select", "from", "where", "join", "inner", "left", "right", "outer", "full",
  "cross", "on", "as", "and", "or", "not", "in", "is", "null", "between",
  "like", "ilike", "exists", "case", "when", "then", "else", "end", "with",
  "recursive", "true", "false", "asc", "desc", "group", "by", "order",
  "having", "limit", "offset", "fetch", "first", "next", "rows", "only",
  "union", "intersect", "except", "all", "distinct", "any", "some",
  "lateral", "values", "into", "using", "natural", "over", "partition",
  "window", "rollup", "cube", "grouping", "sets", "filter", "within",
]);

const FUNCTIONS = new Set([
  "count", "sum", "avg", "min", "max", "coalesce", "nullif", "greatest",
  "least", "abs", "round", "ceil", "ceiling", "floor", "mod", "power", "sqrt",
  "exp", "ln", "log", "concat", "length", "lower", "upper", "trim", "ltrim",
  "rtrim", "substring", "substr", "replace", "position", "left", "right",
  "now", "current_date", "current_time", "current_timestamp", "extract",
  "date_trunc", "date_part", "to_char", "to_date", "to_timestamp", "cast",
  "convert", "row_number", "rank", "dense_rank", "lag", "lead", "first_value",
  "last_value", "ntile", "percent_rank", "cume_dist", "string_agg", "array_agg",
  "json_build_object", "jsonb_build_object", "json_agg", "jsonb_agg",
]);

type Token = { kind: TokenKind; text: string };

export function tokenize(sql: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = sql.length;
  const isIdStart = (c: string) => /[A-Za-z_]/.test(c);
  const isIdCont = (c: string) => /[A-Za-z0-9_]/.test(c);
  const isDigit = (c: string) => /[0-9]/.test(c);

  while (i < n) {
    const c = sql[i];

    // Single-line comment
    if (c === "-" && sql[i + 1] === "-") {
      let j = i;
      while (j < n && sql[j] !== "\n") j++;
      out.push({ kind: "comment", text: sql.slice(i, j) });
      i = j;
      continue;
    }
    // Block comment
    if (c === "/" && sql[i + 1] === "*") {
      let j = i + 2;
      while (j < n - 1 && !(sql[j] === "*" && sql[j + 1] === "/")) j++;
      j = Math.min(n, j + 2);
      out.push({ kind: "comment", text: sql.slice(i, j) });
      i = j;
      continue;
    }
    // String — single-quoted; doubled-quote is the escape per SQL standard
    if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          j++;
          break;
        }
        j++;
      }
      out.push({ kind: "string", text: sql.slice(i, j) });
      i = j;
      continue;
    }
    // Quoted identifier — render as identifier, not string
    if (c === '"' || c === "`") {
      const closer = c;
      let j = i + 1;
      while (j < n && sql[j] !== closer) j++;
      j = Math.min(n, j + 1);
      out.push({ kind: "ident", text: sql.slice(i, j) });
      i = j;
      continue;
    }
    // Number
    if (isDigit(c) || (c === "." && isDigit(sql[i + 1] ?? ""))) {
      let j = i;
      while (j < n && /[0-9eE+\-.]/.test(sql[j])) j++;
      out.push({ kind: "number", text: sql.slice(i, j) });
      i = j;
      continue;
    }
    // Identifier / keyword / function
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isIdCont(sql[j])) j++;
      const word = sql.slice(i, j);
      const lower = word.toLowerCase();
      let nextNonWs = j;
      while (nextNonWs < n && /\s/.test(sql[nextNonWs])) nextNonWs++;
      const looksLikeFunction = sql[nextNonWs] === "(";
      if (KEYWORDS.has(lower)) {
        out.push({ kind: "keyword", text: word });
      } else if (FUNCTIONS.has(lower) || looksLikeFunction) {
        out.push({ kind: "function", text: word });
      } else {
        out.push({ kind: "ident", text: word });
      }
      i = j;
      continue;
    }
    // Punctuation / whitespace — group runs of the same class for fewer DOM nodes
    if (/\s/.test(c)) {
      let j = i + 1;
      while (j < n && /\s/.test(sql[j])) j++;
      out.push({ kind: "ident", text: sql.slice(i, j) });
      i = j;
      continue;
    }
    // Operator / punctuation
    let j = i + 1;
    while (j < n && /[(),;.*=<>!+\-/%|&^~]/.test(sql[j])) j++;
    out.push({ kind: "punct", text: sql.slice(i, j) });
    i = j;
  }
  return out;
}

export function SqlBlock({ sql }: { sql: string }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const tokens = tokenize(sql);

  async function copy() {
    try {
      await navigator.clipboard.writeText(sql);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1400);
    } catch {
      setCopyState("error");
      window.setTimeout(() => setCopyState("idle"), 1800);
    }
  }

  return (
    <div className="sql-block">
      <button
        type="button"
        className="sql-copy"
        onClick={() => void copy()}
        title="Copy SQL"
        aria-label="Copy SQL to clipboard"
      >
        {copyState === "copied" ? "Copied" : copyState === "error" ? "Failed" : "Copy"}
      </button>
      <pre className="sql-pre">
        <code>
          {tokens.map((t, idx) => (
            <span key={idx} className={`tok-${t.kind}`}>
              {t.text}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}
