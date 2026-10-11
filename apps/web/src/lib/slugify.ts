/** Turns "Checkout V2!" into "checkout-v2": a starting point for a key or slug, which the person can still edit. */
export const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
