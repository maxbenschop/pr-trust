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
