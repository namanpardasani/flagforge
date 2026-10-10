const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"] as const;

/** Small counts read better as words in a sentence ("six flags"); larger ones stay as digits. */
export const countWord = (n: number): string => WORDS[n] ?? String(n);

export const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** "1 flag" / "2 flags". */
export const plural = (n: number, singular: string, pluralForm = `${singular}s`): string => (n === 1 ? singular : pluralForm);

const stamp = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "UTC" });

/** "10 Oct, 11:42". Always UTC, so the same data renders the same everywhere. */
export const formatStamp = (iso: string): string => stamp.format(new Date(iso));
