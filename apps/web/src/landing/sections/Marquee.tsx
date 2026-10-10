import { LiveDot } from "@/components/blueprint/marks";
import { useOffscreenPause } from "@/motion";

const KEYS = [
  ["one-tap-checkout", true], ["route-optimizer-v2", true], ["carrier-rate-cache", true], ["instant-payouts", false],
  ["bulk-label-print", false], ["eta-dark-launch", false], ["strict-address-check", false], ["depot-heatmap", true],
  ["driver-chat-beta", false], ["returns-portal", true], ["sms-eta-updates", true], ["cold-chain-alerts", false],
] as const;

/**
 * A slow band of flag keys. Pure CSS: one transform animation on one element, so it runs on the
 * compositor and costs no JavaScript per frame. It pauses on hover, when it is off screen and when
 * the tab is hidden. With reduced motion it does not move at all and can be scrolled sideways.
 */
export default function Marquee() {
  const ref = useOffscreenPause<HTMLDivElement>();
  return (
    <div ref={ref} aria-label="Example flag keys" role="group" className="group overflow-hidden border-y border-hairline py-5 motion-reduce:overflow-x-auto">
      <div data-marquee className="flex w-max animate-marquee group-hover:[animation-play-state:paused] motion-reduce:animate-none">
        {[0, 1].map((copy) => (
          <ul key={copy} aria-hidden={copy === 1} className="flex shrink-0">
            {KEYS.map(([key, on]) => (
              <li key={key} className="flex items-center gap-3 px-7 font-mono text-sm text-muted">
                <LiveDot on={on} emphasis={false} />
                {key}
              </li>
            ))}
          </ul>
        ))}
      </div>
    </div>
  );
}
