/* eslint-disable n/no-unpublished-import */
import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		include: ['test/**/*.spec.ts'],
		testTimeout: 20000,
		hookTimeout: 20000,
		fileParallelism: false,
	},
})
