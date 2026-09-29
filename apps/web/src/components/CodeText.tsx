/**
 * A translated sentence with commands in it (PETTY-281). The dictionaries mark a command with
 * backticks — "Run `petty auth login` again." — and it shows as code. A short command keeps its
 * words on one line (it broke between "petty" and "auth"); a long one may still wrap.
 */
export function CodeText({ text }: { text: string }) {
  return <>{text.split("`").map((part, i) => (i % 2 ? <code className="cmd" key={i}>{part.length <= 28 ? part.replace(/ /g, " ") : part}</code> : part))}</>;
}
