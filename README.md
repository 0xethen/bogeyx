# Bogey plugins

First-party plugins for [Bogey](https://github.com/0xethen/bogey). Each folder in `plugins/` is one plugin
(`manifest.ts`, `runtime.tsx`, and optionally `migrations/`, `seed.sql` and `tests/`).

This repository is a Bogey _library_: `index.json` lists its plugins, which live in `plugins/<key>/`.
Install one into an instance of Bogey 2:

```sh
bogey plugins search
bogey plugins add <plugin>            # or <plugin>@<version>, or github:0xethen/bogeyx/<plugin>@<version>
```

That downloads the tagged release, shows the plugin's manifest and SQL, and asks before
anything is applied. Plugins are trusted code that runs with the app's privileges; read
what you install. See Bogey's `docs/plugins.md` and ADR 0012.

## Layout

```
plugins/<key>/          one plugin each; dot-folders (like .parked/) are skipped
scripts/
  manifests.ts          reads manifests as text, never importing plugin code
  index.ts              writes index.json
  release.ts            checks a <plugin>-v<version> tag and packs dist/<plugin>-<version>.tar.gz
  tests/
schema/                 JSON Schemas from `bogey plugins schema`
index.json              generated; checked in CI
vite.config.ts          Vite+: format, lint, type check, tests, tasks, git hooks
.vite-hooks/            pre-commit formats and lints staged files; pre-push checks release tags
```

## Developing

This is a [Vite+](https://viteplus.dev) package. Plugins import `@bogey/*`, React and the rest from
Bogey itself, so keep a Bogey checkout next to this one (`monorepo/` beside `plugins/`) and link
them:

```sh
cd monorepo && vp install && bogey plugins link ../plugins
cd ../plugins && vp install
```

`bogey plugins link` makes Bogey's `packages/plugins/installed` a symlink to `plugins/` here, and
adds links in `node_modules` to the plugins package's dependencies (and `@bogey/plugins` itself),
so the same React and `@bogey/ui` load in both places. It leaves what this package installs alone
(Vite+, TypeScript, `@types/node`). Link again after Bogey's dependencies change, or if
`node_modules` is deleted.

A folder in `plugins/` is picked up the next time Bogey builds or its dev server restarts.
`bogey plugins add` also writes into this folder when linked this way, so install other people's
plugins on an instance, not here.

| Command              | What it does                                               |
| -------------------- | ---------------------------------------------------------- |
| `vp check`           | Format (Oxfmt), lint (Oxlint) and type check everything    |
| `vp check --fix`     | The same, fixing what it can                               |
| `vp test`            | Unit tests (`plugins/*/tests/*.test.ts`, `scripts/tests/`) |
| `vp run index`       | Rewrite `index.json` after changing a manifest             |
| `vp run index:check` | Fail if `index.json` is out of date                        |
| `vp run ready`       | All of the above; what CI runs                             |

`vp run` caches tasks: `index` and `index:check` replay their last result until a manifest or
script changes. pgTAP tests (`tests/*.test.sql`) run in Bogey against a database, after the
plugin's migrations.

`vp install` runs `vp config`, which installs the git hooks in `.vite-hooks/`.

## Releasing a plugin

1. Change the plugin's `version` in its `manifest.ts`, then `vp run index`.
2. Tag the commit `<plugin>-v<version>`, for example `lockdown-v1.0.0`, and push the tag. The
   pre-push hook refuses a tag that doesn't match the manifest.
3. The release workflow runs `node scripts/release.ts <tag>`, attests the archive, and publishes it
   as a GitHub Release asset through a draft. Turn on _immutable releases_ for this repository
   (Settings → General, or `gh api -X PUT repos/0xethen/bogeyx/immutable-releases`) and GitHub
   also signs a release attestation, which `bogey plugins add` checks with `gh`.

`node scripts/release.ts <tag>` works locally too; `--check` only checks.

## CI

`.github/workflows/ci.yml` checks out this repository and Bogey's `main` side by side, sets up
Vite+ with [`setup-vp`](https://github.com/voidzero-dev/setup-vp) (Node.js, pnpm and the
dependency cache), links them as above, then runs `vp check`, `vp test` and `vp run index:check`.
Dependabot keeps the pinned actions current.

## Your own library

Copy this layout: plugins in `plugins/<key>/`, `scripts/`, the workflows, and tell people to run
`bogey plugins library add github:<you>/<repo>`. `schema/library.schema.json` describes
`index.json`, and `$schema`-aware editors can use `schema/libraries.schema.json` for an
instance's `bogey.libraries.json`.

## License

Apache-2.0.
