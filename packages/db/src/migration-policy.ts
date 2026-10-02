/** SQL files already shipped when the expand/contract guard was introduced.
 * Never change historical SQL hashes to add policy comments. */
export const MIGRATION_POLICY_BASELINE = 44;

function statements(source: string): string[] {
  const result: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  let dollar: string | null = null;
  let line = false;
  let block = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];
    if (line) { if (c === "\n") line = false; continue; }
    if (block) { if (c === "*" && next === "/") { block = false; i++; } continue; }
    if (dollar) { if (source.startsWith(dollar, i)) { i += dollar.length - 1; dollar = null; } continue; }
    if (quote) { if (c === quote) { if (next === quote) i++; else quote = null; } continue; }
    if (c === "-" && next === "-") { line = true; i++; continue; }
    if (c === "/" && next === "*") { block = true; i++; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === "$") { const match = source.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0]; if (match) { dollar = match; i += match.length - 1; continue; } }
    if (c === ";") { result.push(source.slice(start, i + 1)); start = i + 1; }
  }
  result.push(source.slice(start));
  return result;
}

/** Conservative by design: dynamic DDL inside a DO block also needs its
 * surrounding statement marked. A marker never applies to the next statement. */
export function migrationPolicyIssues(source: string): { statement: number; operation: string }[] {
  return statements(source).flatMap((statement, index) => {
    if (/^\s*--\s*contract:\s*\S.+$/im.test(statement)) return [];
    const code = statement.replace(/--[^\n]*/g, " ").replace(/\/\*[\s\S]*?\*\//g, " ");
    const operation = code.match(/\bDROP\b|\bRENAME\b|\bALTER\b[\s\S]*?\bTYPE\b|\b(?:UPDATE\s+(?:ONLY\s+)?|DELETE\s+FROM\s+)(?:"?public"?\s*\.\s*)?"?platform_settings"?\b/i)?.[0];
    return operation ? [{ statement: index + 1, operation: operation.replace(/\s+/g, " ") }] : [];
  });
}
