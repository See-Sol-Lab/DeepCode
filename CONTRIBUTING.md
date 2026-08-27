# Contributing

English | [中文](CONTRIBUTING.zh.md)

Thanks for considering a contribution to DeepSeekGUI! This is the shared development guide for the project, and we ask every contributor — human or agent — to give it a read first.

DeepSeekGUI packages DeepSeek Harness into a Windows desktop product. There are plenty of ways to help: use it, report what breaks, improve the docs, or dive into the code.

## Reporting issues and suggesting features

- **Report a bug**: open a [DeepSeekGUI issue](https://github.com/See-Sol-Lab/DeepSeekGUI/issues) with your Windows version, DeepSeekGUI version, and steps to reproduce. Screenshots or logs are very welcome.
- **Suggest a feature or share feedback**: use Issues as well. Tell us what problem you want solved and how you expect it to work.
- **Ask about upstream Harness behavior**: [DeepSeek Harness Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) is the better place for that.

## Development setup

**Prerequisites**

- Windows 10/11 x64
- Node.js `^22.19.0` or `>=24.0.0`
- pnpm 11 (run `corepack enable` to get it)

**Clone and install**

```sh
git clone https://github.com/See-Sol-Lab/DeepSeekGUI.git
cd DeepSeekGUI
pnpm install
```

**Common commands**

| Command | What it does |
| --- | --- |
| `pnpm run build` | Build everything |
| `pnpm run dev:desktop` | Start the desktop app in development mode |
| `pnpm run build:desktop-dist` | Build the Windows distribution |
| `pnpm run typecheck` | Run type checking |
| `pnpm run lint` | Check code style (`lint:fix` applies fixes) |
| `pnpm test` | Run the test suite |

See [apps/desktop/README.md](apps/desktop/README.md) for engineering details and packaging verification.

## Repository boundaries

If DeepSeekGUI's vision is a car, DeepSeek Harness is the engine inside it. Upstream Harness core files track the official repository and stay as they are here — please keep this principle in mind before opening a PR.

In practice:

- **DeepSeekGUI's own desktop code lives in `apps/desktop/`.** Improvements here are welcome.
- **Upstream Harness code** (`packages/`, `apps/cli`, `apps/web`, and friends) follows the official repository. Send changes for those to [upstream](https://github.com/deepseek-ai/deepseek-harness).

## Sending a pull request

- Keep each PR to a single logical change. Focused diffs are easier to read and to merge.
- Use [Conventional Commits](https://www.conventionalcommits.org/) for commit messages, such as `fix(desktop): ...` or `docs: ...`.
- In the PR description, cover three things: what changed, why, and how you verified it.
- Keep UI copy and documentation in sync across English and Chinese.

**Before you submit**

- [ ] Changes stay within `apps/desktop/` or another DeepSeekGUI-owned area
- [ ] `pnpm run build` passes
- [ ] `pnpm run typecheck` and `pnpm run lint` pass
- [ ] UI and documentation changes are synced in both languages
- [ ] The PR description covers what changed, why, and how it was verified

## Code of conduct

Please be kind and respectful, and keep discussions focused on the work. We want this to be a welcoming place for newcomers.

## Contact

- DeepSeekGUI bugs and product feedback: [DeepSeekGUI Issues](https://github.com/See-Sol-Lab/DeepSeekGUI/issues)
- Questions about upstream Harness behavior: [DeepSeek Harness Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions)

Thanks again for spending your time on DeepSeekGUI.
