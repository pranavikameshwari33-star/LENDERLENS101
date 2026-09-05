/**
 * Grouping keys for leakage-free dataset splits.
 *
 * The single biggest way to fake a good entity-resolution score is to let two
 * near-identical names land on opposite sides of the train/test boundary. A
 * model that has seen "Bajaj Finance Limited" during training will match
 * "Bajaj Housing Finance Limited" at test time for reasons that have nothing
 * to do with generalisation, and the held-out number stops meaning anything.
 *
 * So the split is done over *groups* rather than rows, and a group is defined
 * by the first distinctive word of a company's suffix-stripped name — the
 * brand word, in practice. Every Bajaj entity therefore travels together.
 *
 * The rule deliberately errs towards over-grouping. Putting two unrelated
 * companies in the same group only makes the split coarser; putting two
 * related ones in different groups inflates the score.
 */

/**
 * Words that carry no identity on their own. When a name begins with one of
 * these the next word is taken instead, so that "The Delhi State Co-operative
 * Bank" groups on DELHI rather than dragging in every company starting with
 * "The".
 */
const LEADING_STOPWORDS = new Set([
  "THE",
  "M",
  "MS",
  "SHRI",
  "SHREE",
  "SRI",
  "NEW",
  "INDIAN",
  "INDIA",
]);

/** Longest prefix used from a token, so minor tail typos still group together. */
const KEY_LENGTH = 8;

export function clusterKeyFor(nameCore: string): string {
  const tokens = nameCore.split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) return "__empty__";

  let index = 0;
  while (index < tokens.length - 1 && LEADING_STOPWORDS.has(tokens[index])) index += 1;

  const token = tokens[index];
  // A one- or two-letter head ("A C CHOKSI") is not distinctive on its own, so
  // the following word joins it.
  if (token.length <= 2 && index + 1 < tokens.length) {
    return `${token}_${tokens[index + 1].slice(0, KEY_LENGTH)}`;
  }

  return token.slice(0, KEY_LENGTH);
}
