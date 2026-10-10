/** True on Apple platforms, where the shortcut modifier is Command instead of Control. */
export const isApple = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Label for the platform's shortcut modifier key. */
export const modKey = isApple ? "Cmd" : "Ctrl";
