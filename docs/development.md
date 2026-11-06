# Development and runtime reference

[中文首页](<../README.md>) · [English README](<../README.en.md>) · [Installation](<getting-started.en.md>)

This page keeps contributor and runtime details out of the product overview. Most linked design documents are in Chinese and identify their applicable versions.

## Build and verify

From the repository root, with Node.js 24 and pnpm available:

```sh
pnpm install
pnpm run build
node web-client/build.mjs
pnpm run verify
```

The server is TypeScript ESM. The runtime loads compiled JavaScript, not source TypeScript inside `node_modules`. The client is plain JavaScript and needs its own build; the root TypeScript build does not compile it.

| Command | Purpose |
| --- | --- |
| `pnpm run build` | Compile the server |
| `node web-client/build.mjs` | Build the Web client |
| `pnpm run pack:release` | Build both, generate the isolated bundle and pack a local candidate tgz (no publish/deploy) |
| `pnpm run verify` | Typecheck, full suite and both controlled smokes |
| `pnpm test` | Run tests with the standard node:test isolation |
| `pnpm run test:suite` | Run the full suite with process isolation disabled |
| `pnpm run test:smoke` | Run the controlled T3 and E2E scenarios in isolated temporary homes |
| `pnpm run test:real-host` | Run the separate real-host integration checks |

The suite command uses Node's `--test-isolation=none` spelling; use Node.js 24 for the commands above. Controlled smokes, real-host tests with scripted model responses, and real external-model behavior are different kinds of evidence. See the [test policy](<testing/runtime-refact-test-migration.md>) and the versioned [runtime acceptance ledger](<testing/node-execution-runtime-acceptance.md>); historical test counts are not current release guarantees.

For browser interaction checks, see the [client guide](<../web-client/README.md>) and [editor UI smoke guide](<../scripts/editor-ui-smoke/README.md>).

## Generate an isolated bundle

After building both server and client:

```sh
node scripts/deploy-web.mjs --out ../dsh-workflow-bundle-check
```

Use a dedicated output directory, never the source checkout or profile root. This generates artifacts without changing a live DSH profile. Omitting `--out` writes to the default development deployment location and is a separate, explicitly authorized action. Every rebuild needs a new bundle generation before deployment; restart DSH and refresh the browser after updating the installed plugin.

Runtime dependencies are `yaml` and `zod`. Host API packages remain development dependencies; at runtime they resolve from the DSH installation rather than bundling another host instance.

## Pack a local release candidate

```sh
pnpm run pack:release
```

This single entry runs the server build, client build, existing [bundle generator](<../scripts/deploy-web.mjs>) with `--out .scratch/release`, then `npm pack ./.scratch/release --pack-destination .scratch`. The current candidate is `.scratch/dsh-agent-team-workflow-0.2.1-rc.2.tgz`; both staging and archives are Git-ignored. Output is outside staging, and a strict package `files` allowlist excludes old archives, scripts, source and unrelated staging files. No dependencies are added; nothing is published or deployed and no DSH configuration is changed.

The root [development manifest](<../package.json>) owns version, description, engines, repository, homepage, bugs, author, keywords and runtime dependencies. The generator selects these fields without copying development dependencies or scripts into the bundle manifest. It copies README / LICENSE plus the existing server, client, patch and init resources. The single installed template comes from `WORKFLOW_IDS`; the four advanced examples stay in the source repository.

The root package and generated bundle are both installable after both builds, but use different existing init layouts:

| Package | Template location | Build behavior |
| --- | --- | --- |
| Root `npm pack` | `docs/example/development-workflow.yaml` plus `resources/preset-manager.patch.yml` | Uses existing artifacts; does **not** build |
| Recommended `pnpm run pack:release` | `resources/workflows/development-workflow.yaml` plus the same preset | Always builds server and client before staging |

The package is published on npm; ordinary users should follow the [installation guide](<getting-started.en.md>) without building source. The commands above are for development and future release candidates, not for overwriting the already-published `0.2.1-rc.1`. Do not directly install a Git checkout or interpret a successful build / pack as publication approval. Before each new release, inspect the actual tgz and install that exact file in an isolated DSH home/profile with no fallback to the source checkout; verify plugin load, client discovery, `init --dry-run`, `init`, `list` and `check development-workflow`. Keep this separate from controlled smoke and real-model evidence. See [Updating and publishing releases](<releasing.md>) (Chinese) for versioning, clean-source packing, local tgz installation, publication and registry re-verification.

Focused packaging regression (uses `npm pack --dry-run`, creates no tgz, never touches a real profile):

```sh
node --test --test-isolation=none test/tooling.test.ts
```

## Code map

| Area | Responsibility |
| --- | --- |
| [Entry point](<../src/index.ts>) | Register commands/tools and connect host services |
| [Catalog](<../src/catalog/>) | Parse, validate and normalize workflow YAML |
| [Engine](<../src/engine/>) | Dispatch, result routing, pauses and recovery |
| [State](<../src/state/>) | SQLite work orders and key events |
| [Roles](<../src/roles/>) / [Judge](<../src/judge/>) | Role setup and independent result verification |
| [Tools](<../src/tools/>) / [Programs](<../src/programs/>) | Authorized control tools and fixed built-in programs |
| [Host adapter](<../src/plugin/>) | Connect the engine to DSH agent and session services |
| [Initializer](<../src/init/>) | Shared template/preset installation semantics |
| [Web client](<../web-client/README.md>) | Visual editor, launch dialog and optional run monitor |

## Runtime details and historical references

- [Domain terminology](<../CONTEXT.md>): Manager, Role Actor, Judge, Run, Node and handoff vocabulary.
- [Runtime design](<design/node-execution-runtime.md>) and [specification](<specs/node-execution-runtime.md>): work orders, dispatch and recovery contracts.
- [User guide](<user-guide.md>): commands, model routes, BLOCK handling, state maintenance and troubleshooting.
- [Template reference](<example/README.md>): current `agent-workflow/v3` configuration. Older v1/v2 templates are not runtime-compatible.
- [Long-tail discussion](<pending-discussions/runtime-refact-long-tail.md>): recorded tradeoffs and deferred questions.
- [Runtime work plan](<work-plans/runtime-refact.md>), [original design](<design/configurable-agent-workflow-graph.md>) and [original acceptance report](<testing/acceptance-report.md>): historical material, not current operating instructions.

SQLite work orders and events are the authoritative workflow history. Trace files are best-effort diagnostics under `<catalogDir>/<workflowId>/`, not a recovery log or an exactly-once guarantee for external actions. For explicit-path, read-only state diagnostics:

```sh
node scripts/check-state-rows.mjs <state.sqlite3-path>
```

The tool diagnoses a snapshot copy rather than modifying the target database. Recovery and reset must still account for external side effects; stopping a Run does not undo a push, merge or file write.
