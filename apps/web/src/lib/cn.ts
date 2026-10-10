import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// tailwind-merge removes conflicting classes ("px-2 px-4" -> "px-4"). It only knows Tailwind's
// built-in names, so our custom font size has to be registered or it would be treated as a colour.
const twMerge = extendTailwindMerge({
  extend: { classGroups: { "font-size": [{ text: ["2xs"] }] } },
});

/** Joins class names, drops falsy ones, and lets later classes win over earlier conflicting ones. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
