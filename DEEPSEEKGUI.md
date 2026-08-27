# DeepSeekGUI

**DeepSeekGUI is an unofficial community product for DeepSeek Harness. It is not affiliated with or endorsed by DeepSeek.**（DeepSeekGUI 是 DeepSeek Harness 的非官方社区产品，与 DeepSeek 无隶属关系，未获其背书。）The official Web UI and upstream Harness packages are DeepSeek's work.

> **Use it like Codex. Inspect it like a lab. Extend it like Harness.**

## Product direction

DeepSeekGUI is a DeepSeek-native, Harness-first, observable, and programmable Agent Workbench. DeepSeek Harness is the single runtime and durable event source. DeepSeekGUI Workbench is the product interface. The official DSH Web UI is a Compatibility View and upstream regression baseline, not the product ceiling.

DeepSeekGUI preserves native Harness composition. Users can select arbitrary DSH profiles and run their Cordis plugins; DeepSeekGUI additions remain visible, removable, and attributable. The product does not duplicate model, session, tool, credential, permission, memory, compaction, or hook state in a second runtime.

DeepSeekGUI consists of three product layers:

- **DeepSeekGUI Core** provides Harness profiles, bundles, plugins, DeepSeek optimization recipes, context and memory capabilities, lifecycle hooks, observation, replay, and benchmark infrastructure.
- **DeepSeekGUI Workbench** provides the primary browser-capable interface for agent work, runtime inspection, configuration, and experiments.
- **DeepSeekGUI Desktop** distributes the Workbench and Compatibility View with installation, application data isolation, native windows, updates, diagnostics, and system integration.

The current Windows host and official Web parity suite remain useful foundations. The host evolves into DeepSeekGUI Desktop; parity becomes an upstream compatibility requirement rather than the product roadmap.

## Product commitments

- Deliver a desktop experience that matches every relevant DSH Desktop capability and surpasses it with DeepSeekGUI Workbench and Lab capabilities.
- Make DeepSeek the first-class optimized model family while keeping other providers available through Harness adapters.
- Expose arbitrary DSH profiles, real user Cordis plugin execution, and native memory, compaction, and hook composition.
- Make every model-visible input reconstructable from Harness session events and show its source in Runtime Lens.
- Publish reproducible DeepSeek benchmarks for recipes, tools, context, compaction, memory, and agent strategies.
- Provide context ledger, memory provenance, compaction editor, hook graph, replay, forks, and A/B experiments without hiding product-owned state.


## Engineering rules

- Use DeepSeek Harness services, session events, profiles, bundles, and Cordis plugin extension points as the runtime.
- Keep one observable production path and one source of runtime truth.
- Add DeepSeekGUI capabilities as explicit, inspectable composition layers; never silently replace the selected profile.
- Prefer small changes that produce an observable improvement over broad rewrites.
- Add focused tests for changed behavior and run the narrowest relevant repository checks.
- Keep each change reviewable and leave the working tree understandable before the next improvement.
- Preserve the DeepSeekGUI name and `appId` `io.github.see-sol-lab.deepseekgui`. Official Harness package names, the official Web UI, and upstream dependency names retain their identities.

## Completion signal

A new user can install DeepSeekGUI Desktop, configure DeepSeek, choose a workspace, run and resume an agent without a browser address bar or development toolchain, and progressively open Studio and Lab controls. An expert can select an arbitrary DSH profile, execute its Cordis plugins, inspect every model-visible input and lifecycle action, change one policy, replay the same task, and export a reproducible comparison.

## GitHub metadata (pending owner authorization)

Suggested values for the remote repository metadata; applying them is a manual owner action and must wait for explicit authorization. Nothing here blocks the code stage.

- **Description**: `DeepSeek-native, Harness-first programmable Agent Workbench and desktop client.`
- **Topics**: `deepseek`, `ai-agent`, `agent-workbench`, `desktop-app`, `electron`, `deepseek-harness`, `cordis`, `developer-tools`, `llm`

Metadata is deliberately not modified from this repository's code; if the authorization is unavailable, record the manual action and continue. The upstream MIT text stays untouched in `LICENSE-MIT-UPSTREAM` (the root `LICENSE` is a layered-licensing notice, not a license text), and the layered licensing explanation remains in the README files (DeepSeekGUI product layer under PolyForm Perimeter 1.0.1; the Harness runtime under upstream MIT).
