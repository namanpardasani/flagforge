# @flagforge/core

The evaluation logic of FlagForge, with no dependencies: the hash that places a user in a
percentage rollout, the condition matcher for targeting rules, and `evaluateFlag`.

It is shared by the FlagForge server and every SDK, so they cannot disagree about who gets a flag.
You normally use it through [`@flagforge/sdk`](../sdk); use it directly only to evaluate flag
configurations yourself.

```ts
import { bucketFor, evaluateFlag } from "@flagforge/core";

bucketFor("new-checkout", "user-42"); // 0..9999, the same every time for this flag and user

evaluateFlag(
  { key: "new-checkout", enabled: true, rules: [], fallthroughBps: 2500 }, // on for 25%
  { key: "user-42", attributes: { plan: "pro" } },
); // { value: true | false, reason: "OFF" | "RULE_MATCH" | "FALLTHROUGH", ruleId? }
```

## Rules worth knowing

- **Order of evaluation:** flag off, then rules top to bottom (first match decides, each with its own
  rollout), then the fallthrough rollout.
- **Rollouts never flip users back.** A user's bucket is `murmur3("flagKey:userKey") mod 10000`;
  they are in when the bucket is below the rollout in basis points. Raising 10% to 20% only adds users.
- **A missing attribute never matches**, not even "is not". Unknown must not satisfy a negative rule.
- **No type coercion:** the number `5` does not equal the string `"5"`.
