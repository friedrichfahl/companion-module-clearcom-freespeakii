import { combineRgb, type CompanionFeedbackDefinitions } from '@companion-module/base'
import type ModuleInstance from './main.js'
import {
	connectionChoices,
	firstId,
	gpioChoices,
	KEY_CHOICES,
	portChoices,
	roleChoices,
	targetChoices,
	targetFields,
} from './choices.js'
import {
	batteryLevel,
	channelCallers,
	channelTalkers,
	gpioActive,
	isCalling,
	isOnline,
	isTalking,
	linkQuality,
	lowBatteryPacks,
	missingRoles,
	packs,
	portInChannel,
	resolveTargets,
	type KeySelector,
} from './resolve.js'

type Targets = { targets: string[]; names: string }

export type FeedbacksSchema = {
	role_talking: { type: 'boolean'; options: Targets & { key: string | number } }
	role_online: { type: 'boolean'; options: Targets }
	role_calling: { type: 'boolean'; options: Targets }
	role_battery_below: { type: 'boolean'; options: Targets & { threshold: number } }
	role_signal_below: { type: 'boolean'; options: Targets & { threshold: number } }
	channel_talking: { type: 'boolean'; options: { connection: number } }
	channel_calling: { type: 'boolean'; options: { connection: number } }
	port_in_channel: { type: 'boolean'; options: { port: number; connection: number } }
	any_battery_below: { type: 'boolean'; options: { threshold: number } }
	any_role_missing: { type: 'boolean'; options: { roles: number[] } }
	any_calling: { type: 'boolean'; options: Record<string, never> }
	gpi_state: { type: 'boolean'; options: { gpi: number } }
	gpo_state: { type: 'boolean'; options: { gpo: number } }
	base_connected: { type: 'boolean'; options: Record<string, never> }
}

export const COLORS = {
	white: combineRgb(255, 255, 255),
	black: combineRgb(0, 0, 0),
	red: combineRgb(200, 0, 0),
	green: combineRgb(0, 150, 0),
	amber: combineRgb(255, 170, 0),
	orange: combineRgb(230, 90, 0),
	grey: combineRgb(60, 60, 60),
	dimText: combineRgb(140, 140, 140),
	darkRed: combineRgb(90, 0, 0),
	darkGreen: combineRgb(0, 60, 0),
}

export function toKeySelector(key: unknown): KeySelector {
	if (key === 'any' || key === 'reply') return key
	const n = Number(key)
	return Number.isInteger(n) ? n : 'any'
}

export function UpdateFeedbacks(self: ModuleInstance): void {
	const state = self.state
	const targets = targetChoices(state)
	const roles = roleChoices(state)
	const connections = connectionChoices(state)
	const ports = portChoices(state)
	const gpis = gpioChoices(state.gpis.values())
	const gpos = gpioChoices(state.gpos.values())

	const targetOptions = targetFields(targets)
	const thresholdOption = (label: string, def: number) =>
		({ id: 'threshold', type: 'number', label, default: def, min: 0, max: 100 }) as const
	const connectionOption = {
		id: 'connection',
		type: 'dropdown',
		label: 'Channel',
		choices: connections,
		default: firstId(connections, 1),
	} as const

	/** Devices for a feedback, or [] while the state is still loading so buttons show "unknown", not stale data. */
	const packsFor = (o: Targets) => (state.ready ? resolveTargets(state, o.targets, o.names) : [])

	const feedbacks: CompanionFeedbackDefinitions<FeedbacksSchema> = {
		role_talking: {
			type: 'boolean',
			name: 'Role / device is talking',
			defaultStyle: { bgcolor: COLORS.red, color: COLORS.white },
			options: [...targetOptions, { id: 'key', type: 'dropdown', label: 'Key', choices: KEY_CHOICES, default: 'any' }],
			callback: ({ options }) => {
				const key = toKeySelector(options.key)
				return packsFor(options).some((e) => isTalking(state, e, key))
			},
		},
		role_online: {
			type: 'boolean',
			name: 'Role / device is online',
			defaultStyle: { bgcolor: COLORS.green, color: COLORS.white },
			options: [...targetOptions],
			callback: ({ options }) => packsFor(options).some(isOnline),
		},
		role_calling: {
			type: 'boolean',
			name: 'Role / device has a call signal active',
			defaultStyle: { bgcolor: COLORS.amber, color: COLORS.black },
			options: [...targetOptions],
			callback: ({ options }) => packsFor(options).some(isCalling),
		},
		role_battery_below: {
			type: 'boolean',
			name: 'Role / device battery below threshold',
			defaultStyle: { bgcolor: COLORS.orange, color: COLORS.white },
			options: [...targetOptions, thresholdOption('Battery below (%)', 20)],
			callback: ({ options }) =>
				packsFor(options).some((e) => {
					const b = batteryLevel(e)
					return b !== undefined && b < options.threshold
				}),
		},
		role_signal_below: {
			type: 'boolean',
			name: 'Role / device link quality below threshold',
			defaultStyle: { bgcolor: COLORS.orange, color: COLORS.white },
			options: [...targetOptions, thresholdOption('Link quality below', 30)],
			callback: ({ options }) =>
				packsFor(options).some((e) => {
					const q = linkQuality(e)
					return q !== undefined && q < options.threshold
				}),
		},
		channel_talking: {
			type: 'boolean',
			name: 'Channel: someone is talking',
			defaultStyle: { bgcolor: COLORS.red, color: COLORS.white },
			options: [connectionOption],
			callback: ({ options }) => state.ready && channelTalkers(state, options.connection).length > 0,
		},
		channel_calling: {
			type: 'boolean',
			name: 'Channel: someone is calling',
			description: 'A member device or port has a call signal active',
			defaultStyle: { bgcolor: COLORS.amber, color: COLORS.black },
			options: [connectionOption],
			callback: ({ options }) => state.ready && channelCallers(state, options.connection).length > 0,
		},
		port_in_channel: {
			type: 'boolean',
			name: 'Port is routed to channel',
			defaultStyle: { bgcolor: COLORS.green, color: COLORS.white },
			options: [
				{ id: 'port', type: 'dropdown', label: 'Port', choices: ports, default: firstId(ports, 0) },
				connectionOption,
			],
			callback: ({ options }) => state.ready && portInChannel(state, options.port, options.connection),
		},
		any_battery_below: {
			type: 'boolean',
			name: 'Any online device battery below threshold',
			defaultStyle: { bgcolor: COLORS.orange, color: COLORS.white },
			options: [thresholdOption('Battery below (%)', 20)],
			callback: ({ options }) => state.ready && lowBatteryPacks(state, options.threshold).length > 0,
		},
		any_role_missing: {
			type: 'boolean',
			name: 'Any expected role has no device online',
			defaultStyle: { bgcolor: COLORS.red, color: COLORS.white },
			options: [
				{
					id: 'roles',
					type: 'multidropdown',
					label: 'Expected roles',
					choices: roles,
					default: [],
					minChoicesForSearch: 8,
				},
			],
			callback: ({ options }) => state.ready && missingRoles(state, options.roles ?? []).length > 0,
		},
		any_calling: {
			type: 'boolean',
			name: 'Any device has a call signal active',
			defaultStyle: { bgcolor: COLORS.amber, color: COLORS.black },
			options: [],
			callback: () => state.ready && packs(state).some(isCalling),
		},
		gpi_state: {
			type: 'boolean',
			name: 'GPI is active',
			defaultStyle: { bgcolor: COLORS.green, color: COLORS.white },
			options: [{ id: 'gpi', type: 'dropdown', label: 'GPI', choices: gpis, default: firstId(gpis, 0) }],
			callback: ({ options }) => gpioActive(state, 'gpi', state.gpis.get(options.gpi)),
		},
		gpo_state: {
			type: 'boolean',
			name: 'GPO is active',
			defaultStyle: { bgcolor: COLORS.green, color: COLORS.white },
			options: [{ id: 'gpo', type: 'dropdown', label: 'GPO', choices: gpos, default: firstId(gpos, 0) }],
			callback: ({ options }) => gpioActive(state, 'gpo', state.gpos.get(options.gpo)),
		},
		base_connected: {
			type: 'boolean',
			name: 'Connected to the device',
			defaultStyle: { bgcolor: COLORS.green, color: COLORS.white },
			options: [],
			callback: () => self.socketConnected && state.ready,
		},
	}

	self.setFeedbackDefinitions(feedbacks)
}
