# Desktop React rules

- Before editing or reviewing the renderer, read [Vercel React Best Practices](.agents/skills/vercel-react-best-practices/SKILL.md). Apply the relevant rules for Effects, data loading, and re-renders.
- For component APIs and state ownership, read [Component Design](.agents/skills/component-design/SKILL.md).
- For sync, typing, lists, or layout changes, read [Performance](.agents/skills/performance/SKILL.md). Check commits and DOM continuity with synthetic mail when the change affects rendering.
- Use the [desktop React audit](docs/desktop-react-audit.md) for the baseline and regression budgets.

## Renderer size guideline

Review handwritten files around 300 lines and components around 150 lines. Split when responsibilities, state ownership, or update rates differ. Keep cohesive behavior together.

## Desktop React PR checklist

- [ ] Name the source of truth and owner for new state.
- [ ] Check no-op sync, changed-row, or typing budgets when the diff touches those paths.
- [ ] Check keys, selection, focus, scroll, and DOM continuity across refresh and retry.
- [ ] Exercise slow, failed, and out-of-order responses when changing reads or writes. Show empty state after an accepted result.
- [ ] Verify draft durability, reviewed revisions, and send/undo when changing composer or delivery.
- [ ] Run `pnpm check` and `pnpm build`. Use synthetic mail for shared traces and screenshots.

## Desktop feedback

The owner can open a feedback thread from AMC with **⌘⇧F**. Use the [AMC feedback skill](.agents/skills/amc-feedback/SKILL.md) when a thread starts with “AMC feedback”.
