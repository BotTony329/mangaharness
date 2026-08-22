# Contributing

1. Fork, branch, change, test: `npm test && npm run typecheck && npm run lint && npm run build` must all pass.
2. UI and agent share one service layer (`manga-studio/src/services/*`) — never hand-roll a second path to an API route.
3. Bug fixes ship with a regression test.
4. Keep the BotTony329 attribution (`NOTICE.md`, in-app credit) intact.
