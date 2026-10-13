# Auger state machine

`architecture/auger-state.mmd` is copied from upstream, and `src/harness-state.ts` is a TypeScript adaptation of the session state diagram in [bushshrub/auger](https://github.com/bushshrub/auger), pinned to commit `7e126e04d3cf7f223bd31824a9b95b1531cade64`.

Source: `auger-core/auger-statemachine.mmd`. The upstream Rust implementation was also reviewed in `auger-core/src/harness/states.rs` and `auger-core/src/harness/session.rs`.

Auger is licensed under GNU Affero General Public License version 3. The adapted module carries the corresponding SPDX notice. The upstream license is included in `licenses/auger-AGPL-3.0.txt`.

# highlight.js

`web/highlight.min.js` is highlight.js 11.10.0 (core and 20 common languages), built from the npm package `@highlightjs/cdn-assets@11.10.0`. It is served to the Slopbot console for syntax highlighting in code blocks.

Highlight.js is licensed under the BSD 3-Clause License. The upstream license is included in `licenses/highlightjs-BSD-3-Clause.txt`.
