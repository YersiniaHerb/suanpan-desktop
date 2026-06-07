# Design

## Source of Truth
- Status: Active
- Last refreshed: 2026-06-03
- Primary product surfaces: macOS Electron desktop app, market view, watchlist, formula editor, screener, research plans, shared AI dock, data/AI status modal.
- Evidence reviewed: `SPEC.md`, `prototype/index.html`, `prototype/css/styles.css`, `prototype/js/app.js`, `prototype/js/chart.js`, `electron/main.cjs`, `electron/ai-app-server.cjs`, `electron/ai-settings.cjs`, `scripts/smoke-electron-runtime.cjs`, `scripts/smoke-electron-persistence.cjs`, `scripts/doctor-runtime.cjs`.
- Prototype source: the repository-local `prototype/` implementation is the canonical product/visual prototype for the desktop app.
- Current implementation note: the repository is a plain Electron/static HTML/CSS/JS app. `SPEC.md` now reflects the current MVP boundary; do not migrate stack or add new product surfaces unless explicitly requested.

## Brand
- Personality: quiet, dense, professional A-share research terminal.
- Trust signals: explicit data source/state, local user-state persistence, Codex availability, AI-readable data status, no hidden trading capability.
- Avoid: marketing hero layouts, decorative gradients/orbs, simulated-trading surfaces, unclear terms such as "App Server" or "local fallback" in visible UI.

## Product Goals
- Goals: provide a usable desktop research terminal for market browsing, watchlists, formula work, screening, research plans, and Codex-assisted read-only analysis.
- Non-goals: paper/simulated trading, live order placement, broker integration, automatic trading, new business modules not requested by the user.
- Success signals: user can inspect real/delayed market data, manage local watchlists/formulas/strategies/plans, ask Codex with app data injected, and verify state from the status modal.

## Personas and Jobs
- Primary personas: individual A-share researcher using a macOS desktop app.
- User jobs: scan market movers, inspect K-line/indicator state, manage watchlists, test formulas, run screeners, generate and revisit research plans, ask AI questions grounded in local app data.
- Key contexts of use: repeated daily research sessions, dense information scanning, local-only personal state.

## Information Architecture
- Primary navigation: bottom tab bar with five panels only: market, watchlist, formula, screener, research plans.
- Core screens: quote list plus detail chart, watchlist groups, formula library/editor, condition/formula screener, plan list/detail, global AI dock.
- Content hierarchy: market data and selected-stock chart dominate; sidebars are scan/navigation surfaces; AI dock is secondary and shared.

## Design Principles
- Principle 1: data provenance is visible. Use "真实/延迟数据", "本地/缓存数据", "Codex可用/不可用", "已接入当前数据", and "已接入应用数据" terminology.
- Principle 2: research-only boundaries stay visible. Plans are observation/review artifacts, not orders.
- Principle 3: Codex data access is described as read-only current application data; do not expose auth tokens, internal server jargon, local addresses, sandbox details, or trading endpoint capability in user-facing status UI.
- Tradeoffs: prefer compact operational density over decorative whitespace; keep controls familiar and deterministic.

## Visual Language
- Color: restrained light macOS palette; red for A-share up, green for down, blue for selection/actions, orange only for small brand/accent cues.
- Typography: system UI fonts with tabular numerals for prices, percentages, volume, and timestamps.
- Spacing/layout rhythm: compact rows, stable sidebars, fixed top/bottom bars, no nested page-section cards.
- Shape/radius/elevation: small radius for controls and repeated cards; modals may use existing elevated style.
- Motion: minimal hover/focus feedback; no decorative animation except small status/typing states.
- Imagery/iconography: no stock imagery; use concise symbols/icons already present in the app.

## Components
- Existing components to reuse: topbar status controls, sidebars, quote rows, chart toolbar, stock card, modal, toast, AI runtime chips, bottom tab bar.
- New/changed components: application-owned prompt/confirm modal for names and destructive confirmations; use it instead of native `prompt()`/`confirm()`.
- Variants and states: loading/refreshing, connected/cache data, active tab/list row, empty list, modal open/closed, Codex available/unavailable, AI data connected/not connected.
- Token/component ownership: CSS variables in `prototype/css/styles.css`; JS-rendered components in `prototype/js/app.js`.

## Accessibility
- Target standard: practical keyboard and readable desktop accessibility for prototype stage.
- Keyboard/focus behavior: bottom tabs support number keys 1-5 when focus is not inside an input; modals should focus the primary field and support Enter/Escape where applicable.
- Contrast/readability: keep numeric data legible on light background; do not encode state only with hidden tooltips.
- Screen-reader semantics: modals should use dialog roles when added.
- Reduced motion and sensory considerations: avoid unnecessary motion.

## Responsive Behavior
- Supported breakpoints/devices: desktop-first, minimum Electron window 1280x840.
- Layout adaptations: macOS traffic-light safe zone must keep top-left window buttons from overlapping content; topbar metadata may truncate/hide on narrower widths.
- Touch/hover differences: desktop pointer interaction is primary; chart hover/crosshair must work with pointer events.

## Interaction States
- Loading: topbar buttons and data badge can show refresh state; must return to a stable state after completion/failure.
- Empty: watchlist, formula search, screener results, and plan list use inline empty states.
- Error: use toast or inline status text; do not throw browser alerts for normal user flows.
- Success: use toast for saves/imports/generated plans.
- Disabled: unavailable buttons should be visibly disabled.
- Offline/slow network: keep current cache/local data and label it as local/cache data.

## Content Voice
- Tone: direct, compact, research-terminal wording.
- Terminology: prefer "Codex可用", "Codex不可用", "已接入当前数据", "已接入应用数据", "真实/延迟数据", "本地/缓存数据".
- Microcopy rules: avoid "App Server", "本地后备", and claims of real-time/trading-grade data unless explicitly proven.
- Research-plan copy: use observation/review language such as "研究计划", "观察复盘", and "失效线"; avoid operation-oriented suggestions such as "轻仓", "分批操作", or visible trading-interface labels.

## Implementation Constraints
- Framework/styling system: plain Electron main/preload plus static HTML/CSS/JS.
- Design-token constraints: use existing CSS variables and component classes before adding new styles.
- Performance constraints: market and chart views should remain responsive with loaded all-A quotes; startup should load all-A delayed quotes without blocking interaction, and fetch single-stock daily K data on demand instead of preloading every K-line series. Codex prompt should use compact embedded summary plus local full snapshot file; API Key and Base URL settings must not enter the snapshot.
- Compatibility constraints: current machine has global Electron, not project-local dependencies; no new dependencies without explicit request.
- Test/screenshot expectations: run `npm run check`, `npm run doctor:runtime`, and `npm run test:electron-smoke` for meaningful UI/runtime changes. Run `npm run test:electron-persistence` when user-state, AI consensus, or Codex data-injection persistence changes.

## Open Questions
- [x] Prototype source confirmed: use the repository-local `prototype/` app as the source of truth, not an external group-chat asset.
