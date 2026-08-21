# DeepCode

English | [中文](README.zh.md)

> **Use it like Codex. Inspect it like a lab. Extend it like Harness.**

> **License:** DeepCode uses layered licensing. Original DeepCode product work is source-available under PolyForm Perimeter 1.0.1 where stated; upstream DeepSeek Harness remains MIT-licensed. See [DeepCode licensing](DEEPCODE-LICENSE.md).

DeepCode is a DeepSeek-native, Harness-first, observable, and programmable Agent Workbench. [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) is the runtime; DeepCode Workbench is the product; the official DSH Web UI remains available as a Compatibility View and upstream regression baseline.

DeepCode keeps Harness profiles, Cordis plugins, session events, tools, credentials, permissions, memory, compaction, and hooks in their native composition. The Workbench adds a progressive interface for everyday agent work, runtime inspection, and reproducible experiments without creating a second agent runtime or hidden state store.

The product has two competitive commitments:

- Be the best DeepSeek desktop GUI there is: every capability a DeepSeek desktop client should have, delivered as a polished Windows distribution.
- Be the best DeepSeek Workbench there is: arbitrary DSH profiles, execution of user Cordis plugins, native memory/compaction/hooks, public reproducible DeepSeek benchmarks, and Runtime Lens tooling for context, provenance, compaction, hooks, replay, and A/B experiments.

Both are goals being worked towards, not descriptions of what already ships.

The complete product contract lives in [DEEPCODE.md](DEEPCODE.md).

DeepCode is an unofficial community project. It is not affiliated with or endorsed by DeepSeek. The official Web UI and upstream Harness packages are DeepSeek's work.

## Developer preview

DeepCode and DeepSeek Harness are under active development. Compatibility-breaking changes are expected before the first stable release.

## Run

### Run DeepSeek Harness from `npm`

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the official Web UI at `http://127.0.0.1:3080` by default. See the [Web UI guide](docs/user/guide/index.md).

### Run DeepCode Desktop from source on Windows

From a repository checkout:

```sh
pnpm install
pnpm run build
pnpm run dev:desktop
```

`dev:desktop` starts the local DSH Web service and opens the current DeepCode Desktop host; closing the window stops the service. This host currently presents the Compatibility View while the independent Workbench is built. See [apps/desktop](apps/desktop/README.md).

### Run DeepSeek Harness from source

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

## Community and support

- Submit DeepCode feedback and bug reports through this repository.
- Use [DeepSeek Harness Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) for upstream Harness questions.
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to Harness plugin repositories for discoverability.
- Join the <a href="https://discord.gg/Ycq5dCaS4">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and the [architecture documentation](docs/architecture.md).

For agents, follow [AGENTS.md](AGENTS.md).

## License

DeepCode uses **layered licensing** because this repository combines upstream DeepSeek Harness with original See-Sol-Lab product work.

- Upstream DeepSeek Harness code and upstream-derived material remain under DeepSeek's [MIT License](LICENSE-MIT-UPSTREAM).
- The original DeepCode desktop/product layer under [`apps/desktop/`](apps/desktop/) is licensed under the [PolyForm Perimeter License 1.0.1](apps/desktop/LICENSE). Personal, educational, research, hobby, internal business, and other permitted uses are allowed; providing to others a product that competes with DeepCode is not permitted without a separate written license from See-Sol-Lab.
- Future See-Sol-Lab-owned components outside `apps/desktop/` use the PolyForm Perimeter License only when they explicitly reference that license or the repository licensing notice.

The repository-root [`LICENSE`](LICENSE) is a scope notice rather than a single repository-wide license grant. See [DeepCode licensing](DEEPCODE-LICENSE.md) for the exact scope. Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). No trademark or branding rights are granted by these software licenses.

---

This repository is DeepCode's public release repository. It is a fork of the official DeepSeek Harness, and day-to-day product development happens in a separate private repository; what is published here is the released product tree itself rather than that repository's history.
