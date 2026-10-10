const SEEN_KEY = "ff.booted";

/** The boot sequence plays once per browser session (sessionStorage is cleared when the tab closes). */
export function shouldBoot(): boolean {
  try {
    return window.sessionStorage.getItem(SEEN_KEY) !== "1";
  } catch {
    return false; // storage blocked: skip the intro instead of showing it on every visit
  }
}

export function markBooted() {
  try {
    window.sessionStorage.setItem(SEEN_KEY, "1");
  } catch {
    // Nothing to do: the intro will simply play again next time.
  }
}

