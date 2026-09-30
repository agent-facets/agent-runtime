# Third-party notices

The code and documentation in this repository are licensed under the
[MIT License](./LICENSE), except for third-party material identified below.
Third-party packages, tools, and images keep their own licenses.

This file covers the source repository. It does not clear the redistribution of
Docker images built from the spike harnesses. Those images download additional
third-party software, including Debian packages, and some of it has separate
terms (see [Obsidian](#obsidian)).

## Material included in this repository

### OpenCode prompt text

`spikes/anthropic-parity/fixtures/cases.json` includes OpenCode-branded
system-prompt text used as synthetic test input. OpenCode is available under the
following license:

```text
MIT License

Copyright (c) 2025 opencode

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Source: <https://github.com/anomalyco/opencode>

## Dependencies installed separately

Nothing in this section is included in this repository. Each item is
downloaded during installation or a Docker build and remains under its own
license.

| Component | Used by | License |
|---|---|---|
| npm dependencies in `bun.lock` and each spike's `package-lock.json` | Root project and spikes | Their own licenses, as declared by each package |
| `@ex-machina/opencode-anthropic-auth@1.8.1` | `spikes/anthropic-parity` (reference oracle) | MIT, Copyright (c) 2026 Ex Machina; see the [source at the pinned commit](https://github.com/ex-machina-co/opencode-anthropic-auth/tree/f9947c0c97f28b91036e2fd27f552578d888dfbc). The npm metadata has no `license` field. |
| `@openai/codex@0.151.0` | `spikes/openai-device-auth` (reference oracle) | Apache-2.0; <https://github.com/openai/codex> |
| MCP Connector for Obsidian 2.4.0 | `spikes/obsidian` | MIT, Copyright (c) 2026 Stefano Ferri; <https://github.com/istefox/obsidian-mcp-connector> |
| Node and Debian base images | Spike Dockerfiles | Their own licenses |

### Obsidian

`spikes/obsidian` downloads the Obsidian desktop application while it builds the
image. Obsidian is proprietary software under the
[Obsidian Terms of Service](https://obsidian.md/terms), which restrict its
redistribution. The MIT License in this repository does not cover Obsidian.
Do not publish or redistribute images containing Obsidian unless you are
permitted to do so.

### Agent facets

`facets.json` and `facets.lock` reference optional agent tooling from the Agent
Facets registry. These packages are not included in this repository and are not
needed to install or run the project. Their availability and license terms have
not been verified for public use.
