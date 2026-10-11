# Publishing the SDK to npm

Two packages are published together: `@flagforge/core` (the evaluation logic) and
`@flagforge/sdk` (which depends on it). Both are built from TypeScript to JavaScript with type
declarations; `publishConfig` in each `package.json` points the published entry at `dist/`.

This has been checked by packing both, installing the tarballs into an empty project outside this
repository, running them with plain Node and typechecking against their declarations. It has not
been published.

## Before the first publish (your decisions)

1. **The name.** `@flagforge/...` needs an npm organisation called `flagforge` that you own. If it
   is taken, rename both packages (for example `@your-username/flagforge-sdk`) and update the
   imports.
2. **A licence.** Neither package declares one yet. Add a `LICENSE` file at the repository root and
   a `"license"` field to both `package.json` files. Without it, nobody is formally allowed to use them.
3. **Remove `"private": true`** from both `package.json` files. It is there so nothing can be
   published by accident.

## Publish

```bash
npm login

cd packages/core && npx tsc -p tsconfig.build.json && pnpm publish --no-git-checks
cd ../sdk        && npx tsc -p tsconfig.build.json && pnpm publish --no-git-checks
```

Core first: the SDK depends on that exact version. Use `pnpm publish`, not `npm publish`: pnpm
rewrites the `workspace:*` dependency to the real version and applies `publishConfig`.

To see exactly what would be uploaded without publishing:

```bash
pnpm pack --pack-destination /tmp/ff-pack && tar tzf /tmp/ff-pack/flagforge-sdk-*.tgz
```

## Later versions

Bump `version` in both packages together, rebuild, publish core then sdk. Changing the hash in
`core` would move every user to a different rollout bucket, so treat that as a breaking change.
