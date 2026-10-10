import { useReducedMotion } from "motion/react";
import { useMemo } from "react";
import { Crosshairs } from "@/components/blueprint/Frame";
import { FigCaption } from "@/components/blueprint/marks";
import { Reveal } from "@/motion";
import { useActive, useTyped } from "../hooks";

/** Real usage of packages/sdk: the same shape as its README. */
const CODE = `import { FlagForgeClient, FileStorage } from "@flagforge/sdk";

const flags = new FlagForgeClient({
  apiKey: process.env.FLAGFORGE_API_KEY!,
  baseUrl: "https://flags.example.com",
  storage: new FileStorage("./flags.cache.json"),
});

await flags.init();

if (flags.isEnabled("one-tap-checkout", { key: user.id })) {
  return renderOneTapCheckout(order);
}`;

const POINTS = [
  ["Local", "A flag check reads memory. There is no network call per check."],
  ["Live", "Changes arrive over a stream. Polling stays on as a safety net."],
  ["Safe", "It never throws. With nothing to go on, you get the default you passed."],
] as const;

/** `start` is where the token begins in the snippet, so "how much of it is typed" is a subtraction. */
type Token = { text: string; start: number; tone: "plain" | "string" | "keyword" };

/** A tiny highlighter: strings and a handful of keywords. Enough for one snippet, no library needed. */
function tokenize(code: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /("[^"]*")|\b(import|from|const|new|await|if|return)\b/g;
  let last = 0;
  for (const match of code.matchAll(pattern)) {
    if (match.index > last) tokens.push({ text: code.slice(last, match.index), start: last, tone: "plain" });
    tokens.push({ text: match[0], start: match.index, tone: match[1] ? "string" : "keyword" });
    last = match.index + match[0].length;
  }
  if (last < code.length) tokens.push({ text: code.slice(last), start: last, tone: "plain" });
  return tokens;
}

const TONE = { plain: "text-muted", string: "text-ink", keyword: "text-faint" } as const;

export default function Sdk() {
  const reduced = useReducedMotion() ?? false;
  const [ref, active] = useActive<HTMLDivElement>("-15% 0px");
  const typed = useTyped(CODE, active, { cps: 95, instant: reduced });
  const tokens = useMemo(() => tokenize(CODE), []);
  const lines = CODE.split("\n").length;

  return (
    <section aria-labelledby="sdk-title" className="mx-auto grid max-w-6xl items-start gap-12 px-4 py-24 md:px-6 md:py-32 lg:grid-cols-[minmax(0,4fr)_minmax(0,6fr)]">
      <Reveal whenInView>
        <FigCaption index="0.5" label="Server SDK" />
        <h2 id="sdk-title" className="mt-5 text-4xl font-semibold leading-none tracking-[-0.035em] text-ink md:text-6xl">
          One import. One <span className="accent text-[1.06em] font-normal">if</span>.
        </h2>
        <dl className="mt-8 divide-y divide-hairline border-y border-hairline">
          {POINTS.map(([term, text]) => (
            <div key={term} className="grid grid-cols-[4.5rem_1fr] py-3.5">
              <dt className="caption pt-0.5 text-faint">{term}</dt>
              <dd className="text-sm leading-relaxed text-muted">{text}</dd>
            </div>
          ))}
        </dl>
      </Reveal>

      <div ref={ref} className="relative border border-hairline bg-sunken">
        <Crosshairs />
        <p className="caption flex justify-between border-b border-hairline px-4 py-2 text-faint">
          <span>server.ts</span>
          <span>{lines} lines</span>
        </p>
        <div className="grid grid-cols-[auto_minmax(0,1fr)] overflow-x-auto py-4 font-mono text-[12.5px] leading-6">
          <div aria-hidden className="select-none px-4 text-right text-faint">
            {Array.from({ length: lines }, (_, i) => (
              <div key={i}>{i + 1}</div>
            ))}
          </div>
          <div className="relative pr-4">
            {/* The whole snippet, invisible, gives the block its final size before a single character is typed. */}
            <pre className="invisible" aria-hidden>
              {CODE}
            </pre>
            <pre aria-label={CODE} className="absolute inset-0">
              <code aria-hidden>
                {tokens.map((token, i) => {
                  const shown = token.text.slice(0, Math.max(0, typed - token.start));
                  return shown ? (
                    <span key={i} className={TONE[token.tone]}>
                      {shown}
                    </span>
                  ) : null;
                })}
                <span className="ml-px inline-block h-[1.15em] w-[0.55em] translate-y-[0.2em] animate-blink bg-ink" data-caret />
              </code>
            </pre>
          </div>
        </div>
      </div>
    </section>
  );
}
