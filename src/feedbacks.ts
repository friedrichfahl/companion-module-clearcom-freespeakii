import type { CompanionFeedbackDefinitions } from '@companion-module/base'
import { PALETTE } from './graphics.js'
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
	isListening,
	isOnline,
	isTalking,
	linkQuality,
	lowBatteryPacks,
	missingRoles,
	packs,
	packsForRole,
	portInChannel,
	resolveTargets,
	roleKeySlots,
	type KeySelector,
} from './resolve.js'
import { DETAIL_KEYS } from './variables.js'

type Targets = { targets: string[]; names: string }

export type FeedbacksSchema = {
	role_talking: { type: 'boolean'; options: Targets & { key: string | number } }
	role_listening: { type: 'boolean'; options: Targets & { key: string | number } }
	role_selected: { type: 'boolean'; options: { role: number } }
	assign_pending: { type: 'boolean'; options: Record<string, never> }
	selected_key_exists: { type: 'boolean'; options: { key: number } }
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

/** Default feedback styles, in the presets' palette. */
const STYLE = {
	talk: { bgcolor: PALETTE.talk, color: PALETTE.white },
	call: { bgcolor: PALETTE.call, color: PALETTE.callText },
	ok: { bgcolor: PALETTE.ok, color: PALETTE.white },
	warn: { bgcolor: PALETTE.warn, color: PALETTE.white },
	info: { bgcolor: PALETTE.info, color: PALETTE.white },
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
			defaultStyle: STYLE.talk,
			options: [...targetOptions, { id: 'key', type: 'dropdown', label: 'Key', choices: KEY_CHOICES, default: 'any' }],
			callback: ({ options }) => {
				const key = toKeySelector(options.key)
				return packsFor(options).some((e) => isTalking(state, e, key))
			},
		},
		role_listening: {
			type: 'boolean',
			name: 'Role / device key is listening',
			description: 'The key is in listen (or talk + listen) state',
			defaultStyle: STYLE.ok,
			options: [...targetOptions, { id: 'key', type: 'dropdown', label: 'Key', choices: KEY_CHOICES, default: 'any' }],
			callback: ({ options }) => {
				const key = toKeySelector(options.key)
				return packsFor(options).some((e) => isListening(state, e, key))
			},
		},
		role_selected: {
			type: 'boolean',
			name: 'Role is shown on the role detail page',
			defaultStyle: STYLE.info,
			options: [{ id: 'role', type: 'dropdown', label: 'Role', choices: roles, default: firstId(roles, 0) }],
			callback: ({ options }) => state.selectedRole === options.role,
		},
		selected_key_exists: {
			type: 'boolean',
			name: 'Role detail: the selected role has this key',
			defaultStyle: STYLE.ok,
			options: [{ id: 'key', type: 'number', label: 'Key number (1 = first)', default: 1, min: 1, max: DETAIL_KEYS }],
			callback: ({ options }) => {
				const role = state.selectedRole === undefined ? undefined : state.roles.get(state.selectedRole)
				if (!role) return false
				return roleKeySlots(state, role, packsForRole(state, role.id)[0]).length >= options.key
			},
		},
		assign_pending: {
			type: 'boolean',
			name: 'Role detail: another role is picked to assign',
			defaultStyle: STYLE.call,
			options: [],
			callback: () => state.assignRole !== undefined && state.assignRole !== state.selectedRole,
		},
		role_online: {
			type: 'boolean',
			name: 'Role / device is online',
			defaultStyle: STYLE.ok,
			options: [...targetOptions],
			callback: ({ options }) => packsFor(options).some(isOnline),
		},
		role_calling: {
			type: 'boolean',
			name: 'Role / device has a call signal active',
			defaultStyle: STYLE.call,
			options: [...targetOptions],
			callback: ({ options }) => packsFor(options).some(isCalling),
		},
		role_battery_below: {
			type: 'boolean',
			name: 'Role / device battery below threshold',
			defaultStyle: STYLE.warn,
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
			defaultStyle: STYLE.warn,
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
			defaultStyle: STYLE.talk,
			options: [connectionOption],
			callback: ({ options }) => state.ready && channelTalkers(state, options.connection).length > 0,
		},
		channel_calling: {
			type: 'boolean',
			name: 'Channel: someone is calling',
			description: 'A member device or port has a call signal active',
			defaultStyle: STYLE.call,
			options: [connectionOption],
			callback: ({ options }) => state.ready && channelCallers(state, options.connection).length > 0,
		},
		port_in_channel: {
			type: 'boolean',
			name: 'Port is routed to channel',
			defaultStyle: STYLE.ok,
			options: [
				{ id: 'port', type: 'dropdown', label: 'Port', choices: ports, default: firstId(ports, 0) },
				connectionOption,
			],
			callback: ({ options }) => state.ready && portInChannel(state, options.port, options.connection),
		},
		any_battery_below: {
			type: 'boolean',
			name: 'Any online device battery below threshold',
			defaultStyle: STYLE.warn,
			options: [thresholdOption('Battery below (%)', 20)],
			callback: ({ options }) => state.ready && lowBatteryPacks(state, options.threshold).length > 0,
		},
		any_role_missing: {
			type: 'boolean',
			name: 'Any expected role has no device online',
			defaultStyle: STYLE.talk,
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
			defaultStyle: STYLE.call,
			options: [],
			callback: () => state.ready && packs(state).some(isCalling),
		},
		gpi_state: {
			type: 'boolean',
			name: 'GPI is active',
			defaultStyle: STYLE.ok,
			options: [{ id: 'gpi', type: 'dropdown', label: 'GPI', choices: gpis, default: firstId(gpis, 0) }],
			callback: ({ options }) => gpioActive(state, 'gpi', state.gpis.get(options.gpi)),
		},
		gpo_state: {
			type: 'boolean',
			name: 'GPO is active',
			defaultStyle: STYLE.ok,
			options: [{ id: 'gpo', type: 'dropdown', label: 'GPO', choices: gpos, default: firstId(gpos, 0) }],
			callback: ({ options }) => gpioActive(state, 'gpo', state.gpos.get(options.gpo)),
		},
		base_connected: {
			type: 'boolean',
			name: 'Connected to the device',
			defaultStyle: STYLE.ok,
			options: [],
			callback: () => self.socketConnected && state.ready,
		},
	}

	self.setFeedbackDefinitions(feedbacks)
}
