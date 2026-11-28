/**
 * Reader for Vouch's `.td` trust list format (https://github.com/mitchellh/vouch):
 *
 *   # comment
 *   username
 *   platform:username
 *   -platform:denounced-user optional details
 *
 * Only GitHub entries are kept. Logins are compared case-insensitively, as GitHub does.
 */
export type VouchList = {
  vouched: ReadonlySet<string>;
  denounced: ReadonlySet<string>;
};

export const EMPTY_LIST: VouchList = { vouched: new Set(), denounced: new Set() };

export function normalizeLogin(login: string): string {
  return login.trim().replace(/^@/, "").toLowerCase();
}

export function parseVouchFile(text: string): VouchList {
  const vouched = new Set<string>();
  const denounced = new Set<string>();

  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    let isDenounced = false;
    if (line.startsWith("-")) {
      isDenounced = true;
      line = line.slice(1).trim();
    } else if (line.startsWith("+")) {
      line = line.slice(1).trim();
    }

    const handle = line.split(/\s+/, 1)[0] ?? "";
    const colon = handle.indexOf(":");
    const platform = colon === -1 ? "github" : handle.slice(0, colon).toLowerCase();
    const login = normalizeLogin(colon === -1 ? handle : handle.slice(colon + 1));
    if (login === "" || (platform !== "github" && platform !== "github.com")) continue;

    (isDenounced ? denounced : vouched).add(login);
  }

  // If a login appears both ways, the denouncement wins.
  for (const login of denounced) vouched.delete(login);
  return { vouched, denounced };
}

/** A GitHub login: letters, digits and hyphens, not starting with a hyphen, at most 39 long. */
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;

export function isLogin(value: string): boolean {
  return LOGIN.test(value);
}

/** The header Vouch's `init-file` writes into a new list. */
export const NEW_VOUCH_FILE_HEADER = `# Vouched contributors for this project.
#
# See https://github.com/mitchellh/vouch for details.
#
# Syntax:
#   - One handle per line (without @), sorted alphabetically.
#   - Optional platform prefix: platform:username (e.g., github:user).
#   - Denounce with minus prefix: -username or -platform:username.
#   - Optional details after a space following the handle.
`;

export type AddVouchResult =
  | { result: "added"; text: string }
  | { result: "already-vouched" }
  | { result: "denounced" };

/**
 * Adds a vouch for `login` to a list's text (`null`: no list yet), the way Vouch's
 * `vouch add` writes it: the bare lowercased login on its own line, entries sorted
 * case-insensitively by username, a trailing newline.
 *
 * Unlike Vouch, which rewrites the whole file (comments to the top, every entry lowercased
 * and re-sorted), only the one line is inserted, so the diff is a single line. On a file
 * Vouch wrote, the result is the same. If the existing entries are not sorted, the line is
 * appended after the last entry instead. If every existing entry has the `github:` prefix,
 * the new one gets it too. A denounced login is never changed.
 */
export function addVouch(text: string | null, login: string): AddVouchResult {
  if (!isLogin(login)) throw new Error(`not a GitHub username: ${JSON.stringify(login)}`);
  const key = login.toLowerCase();
  if (text === null) return { result: "added", text: `${NEW_VOUCH_FILE_HEADER}${key}\n` };

  const list = parseVouchFile(text);
  if (list.denounced.has(key)) return { result: "denounced" };
  if (list.vouched.has(key)) return { result: "already-vouched" };

  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop(); // the trailing newline

  // Every entry line and its username, whatever its platform, as Vouch sorts them.
  const entries: { index: number; username: string }[] = [];
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const handle = line.replace(/^[-+]/, "").trim().split(/\s+/, 1)[0] ?? "";
    entries.push({ index, username: handle.slice(handle.indexOf(":") + 1).toLowerCase() });
  });

  let at: number;
  const sorted = entries.every((e, i) => i === 0 || entries[i - 1]!.username <= e.username);
  const after = entries.find((e) => e.username > key);
  if (entries.length === 0) at = lines.length;
  else if (sorted && after) at = after.index;
  else at = entries.at(-1)!.index + 1;

  lines.splice(at, 0, vouchEntry(text, login));
  return { result: "added", text: lines.join(eol) + eol };
}

/**
 * The line `addVouch` writes for `login` into a list's text (`null`: no list yet): the
 * lowercased login, with the `github:` prefix when every existing entry is written that way.
 */
export function vouchEntry(text: string | null, login: string): string {
  const key = login.toLowerCase();
  if (text === null) return key;
  const handles = text
    .split(/\r?\n/)
    .map((raw) => raw.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => (line.replace(/^[-+]/, "").trim().split(/\s+/, 1)[0] ?? "").toLowerCase());
  return handles.length > 0 && handles.every((h) => h.startsWith("github:")) ? `github:${key}` : key;
}
