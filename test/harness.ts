// Runs the real ModuleInstance inside a fake Companion host: records definitions, variables and status, and
// lets tests run action callbacks and evaluate feedbacks the way Companion would (with parsed option values).
import ModuleInstance from '../src/main.js'
import type { ModuleConfig, ModuleSecrets } from '../src/config.js'
import { DEFAULT_CONFIG } from '../src/config.js'

type AnyDef = {
	callback: (...args: unknown[]) => unknown
	learn?: (...args: unknown[]) => unknown
	[key: string]: unknown
}

const logs: string[] = []
;(globalThis as { COMPANION_LOGGER?: unknown }).COMPANION_LOGGER = (
	_source: string,
	level: string,
	message: string,
) => {
	logs.push(`[${level}] ${message}`)
	if (process.env.HARNESS_VERBOSE) console.log(`[${level}] ${message}`)
}

export class Harness {
	statuses: { status: string; message: string | null }[] = []
	actions: Record<string, AnyDef | undefined> = {}
	feedbacks: Record<string, AnyDef | undefined> = {}
	presets: Record<string, unknown> = {}
	presetStructure: unknown[] = []
	compositeElements: Record<string, unknown> = {}
	variableDefs: Record<string, { name: string }> = {}
	variables: Record<string, unknown> = {}
	readonly instance: ModuleInstance
	readonly logs = logs

	constructor(label = 'cc') {
		const context = {
			_isInstanceContext: true,
			id: 'test-connection',
			label,
			upgradeScripts: [],
			saveConfig: () => undefined,
			updateStatus: (status: string, message: string | null) => this.statuses.push({ status, message }),
			oscSend: () => undefined,
			recordAction: () => undefined,
			setActionDefinitions: (a: Record<string, AnyDef>) => (this.actions = a),
			subscribeActions: () => undefined,
			unsubscribeActions: () => undefined,
			setFeedbackDefinitions: (f: Record<string, AnyDef>) => (this.feedbacks = f),
			unsubscribeFeedbacks: () => undefined,
			checkFeedbacks: () => undefined,
			checkAllFeedbacks: () => undefined,
			checkFeedbacksById: () => undefined,
			setPresetDefinitions: (structure: unknown[], presets: Record<string, unknown>) => {
				this.presetStructure = structure
				this.presets = presets
			},
			setCompositeElementDefinitions: (c: Record<string, unknown>) => (this.compositeElements = c),
			setVariableDefinitions: (d: Record<string, { name: string }>) => (this.variableDefs = d),
			setVariableValues: (v: Record<string, unknown>) => Object.assign(this.variables, v),
			getVariableValue: (id: string) => this.variables[id],
			sharedUdpSocketHandlers: new Map(),
			sharedUdpSocketJoin: async () => '',
			sharedUdpSocketLeave: async () => undefined,
			sharedUdpSocketSend: async () => undefined,
		}
		this.instance = new ModuleInstance(context)
	}

	get status(): { status: string; message: string | null } | undefined {
		return this.statuses.at(-1)
	}

	async init(config: Partial<ModuleConfig>, secrets: ModuleSecrets = {}): Promise<void> {
		await this.instance.init({ ...DEFAULT_CONFIG, ...config }, true, secrets)
	}

	async update(config: Partial<ModuleConfig>, secrets: ModuleSecrets = {}): Promise<void> {
		await this.instance.configUpdated({ ...DEFAULT_CONFIG, ...config }, secrets)
	}

	async action(id: string, options: Record<string, unknown>, surfaceId?: string): Promise<void> {
		const def = this.actions[id]
		if (!def) throw new Error(`No action ${id}`)
		await def.callback(
			{ id: 'action-1', actionId: id, controlId: 'bank:1', options, previousOptions: null, surfaceId },
			{},
		)
	}

	async learn(id: string, options: Record<string, unknown>): Promise<unknown> {
		const def = this.actions[id]
		if (!def?.learn) throw new Error(`No learn for ${id}`)
		return def.learn({ id: 'action-1', actionId: id, controlId: 'bank:1', options, previousOptions: null }, {})
	}

	feedback(id: string, options: Record<string, unknown> = {}): unknown {
		const def = this.feedbacks[id]
		if (!def) throw new Error(`No feedback ${id}`)
		return def.callback(
			{ id: 'fb-1', feedbackId: id, controlId: 'bank:1', type: 'boolean', options, previousOptions: null },
			{},
		)
	}

	async destroy(): Promise<void> {
		await this.instance.destroy()
	}
}

/** Poll until fn returns a truthy value (or stops throwing). */
export async function waitFor<T>(fn: () => T, what: string, timeoutMs = 5000): Promise<T> {
	const until = Date.now() + timeoutMs
	let last: unknown
	for (;;) {
		try {
			const v = fn()
			if (v) return v
			last = v
		} catch (err) {
			last = err
		}
		if (Date.now() > until) throw new Error(`Timed out waiting for ${what} (last: ${String(last)})`)
		await new Promise((r) => setTimeout(r, 25))
	}
}

export const sleep = async (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
