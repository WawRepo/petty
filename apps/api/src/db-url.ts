/**
 * A database password that is not URL-safe breaks its postgres:// address: `openssl rand -base64 32`
 * gives a "/" about half the time, and the driver then stops deep inside with "Invalid URL" (PETTY-289).
 * Say which variable and what to do instead — never its value, which holds the password.
 */
export function checkDbUrl(name: string, url: string): void {
  // A socket path or another form the driver knows: leave it to the driver.
  if (!/^postgres(ql)?:\/\//i.test(url)) return;
  try {
    new URL(url);
  } catch {
    throw new Error(`${name} is not a valid postgres:// address. Its password must be URL-safe: use letters and digits only, for example from: openssl rand -hex 32`);
  }
}
