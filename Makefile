check:
	test build typecheck 
test:
	bun test

build:
	bun run build

typecheck:
	bun type-check

lint: bun run lint
dist: bun run dist