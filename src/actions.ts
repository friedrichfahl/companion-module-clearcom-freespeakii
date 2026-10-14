import type { CompanionActionDefinitions } from '@companion-module/base'
import type ModuleInstance from './main.js'
import {
	connectionChoices,
	firstId,
	gpioChoices,
	packChoices,
	portChoices,
	roleChoices,
	targetChoices,
	targetFields,
} from './choices.js'
import {
	channelParticipants,
	endpointForParticipant,
	gpioActive,
	isCalling,
	isOnline,
	isPack,
	packName,
	packRoleId,
	packs,
	portChannels,
	portForParticipant,
	portInChannel,
	resolveTargets,
} from './resolve.js'
import type { DeviceDriver } from './drivers/driver.js'
import type { ActiveCall } from './main.js'
import type { Endpoint, Port } from './types.js'

type Targets = { targets: string[]; names: string }
type CallMode = 'on' | 'off' | 'toggle' | 'pulse'

export type ActionsSchema = {
	call_role: { options: Targets & { mode: CallMode; pulseMs: number; text: string } }
	rmk_role: { options: Targets }
	rmk_all: { options: Record<string, never> }
	change_role: { options: { pack: number; role: number } }
	call_channel: { options: { connection: number; mode: 'on' | 'off' | 'pulse'; pulseMs: number; text: string } }
	port_route: { options: { port: number; connection: number; mode: 'join' | 'leave' | 'toggle' } }
	port_call: { options: { port: number; mode: 'on' | 'off' | 'pulse'; pulseMs: number } }
	gpo_set: { options: { gpo: number; mode: 'on' | 'off' | 'toggle' | 'release' } }
	gpi_trigger: { options: { gpi: number; mode: 'on' | 'off' | 'toggle' } }
}

const PULSE_OPTION = {
	id: 'pulseMs',
	type: 'number',
	label: 'Pulse length (ms)',
	default: 2000,
	min: 100,
	max: 30000,
	isVisibleExpression: `$(options:mode) == 'pulse'`,
} as const

const TEXT_OPTION = {
	id: 'text',
	type: 'textinput',
	label: 'Call text (optional)',
	default: '',
	useVariables: true,
} as const

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const uniqueEndpoints = (list: Endpoint[]): Endpoint[] => [...new Map(list.map((e) => [e.id, e])).values()]
const uniquePorts = (list: Port[]): Port[] => [...new Map(list.map((p) => [p.port_id, p])).values()]

export function UpdateActions(self: ModuleInstance): void {
	const state = self.state
	const targets = targetChoices(state)
	const roles = roleChoices(state)
	const packList = packChoices(state)
	const connections = connectionChoices(state)
	const ports = portChoices(state)
	const gpos = gpioChoices(state.gpos.values())
	const gpis = gpioChoices(state.gpis.values())
	const targetOptions = targetFields(targets)

	/**
	 * The driver, or undefined (after logging) when there is none. Commands go over REST, so a socket hiccup must
	 * not block them - above all the "off" half of a call.
	 */
	const driverFor = (what: string): DeviceDriver | undefined => {
		const driver = self.driver
		if (!driver) {
			self.log('warn', `${what}: not connected to the device`)
			return undefined
		}
		if (!self.socketConnected) self.log('debug', `${what}: live connection is down, sending anyway`)
		return driver
	}

	/** Run fn for each resolved online device; log when nothing matched. */
	const forPacks = async (
		list: Endpoint[],
		what: string,
		fn: (driver: DeviceDriver, e: Endpoint) => Promise<unknown>,
	): Promise<void> => {
		const driver = driverFor(what)
		if (!driver) return
		const online = list.filter(isOnline)
		if (!online.length) return self.log('info', `${what}: no online device matches the selection`)
		await Promise.all(
			online.map(async (e) =>
				fn(driver, e).catch((err) => self.log('warn', `${what} ${packName(state, e)} failed: ${errMsg(err)}`)),
			),
		)
	}

	/** Send a call signal on/off to devices and ports, logging failures per target. */
	const sendCall = async (call: ActiveCall, active: boolean, text: string, what: string): Promise<void> => {
		await Promise.all([
			...call.endpoints.map(async (e) =>
				call.driver
					.call(e, active, active ? text : '')
					.catch((err) => self.log('warn', `${what} ${packName(state, e)} failed: ${errMsg(err)}`)),
			),
			...call.ports.map(async (p) =>
				call.driver
					.portCall(p, active)
					.catch((err) => self.log('warn', `${what} ${p.port_label} failed: ${errMsg(err)}`)),
			),
		])
	}

	/**
	 * Turn a call on and remember exactly what was called: a pulse turns those same targets off later (also if the
	 * module stops first), a held call (on / off) is turned off by the matching "off" or when the module stops.
	 */
	const callOn = async (key: string, call: ActiveCall, text: string, pulseMs: number | undefined, what: string) => {
		await sendCall(call, true, text, what)
		if (pulseMs !== undefined) {
			self.schedule(pulseMs, async () => sendCall(call, false, '', `${what} off`), true)
			return
		}
		const prev = self.activeCalls.get(key)
		self.activeCalls.set(key, {
			driver: call.driver,
			endpoints: uniqueEndpoints([...(prev?.endpoints ?? []), ...call.endpoints]),
			ports: uniquePorts([...(prev?.ports ?? []), ...call.ports]),
		})
	}

	/** Turn a call off: the given targets plus everything a matching "on" turned on, even if it moved or went offline. */
	const callOff = async (key: string, call: ActiveCall, what: string) => {
		const prev = self.activeCalls.get(key)
		self.activeCalls.delete(key)
		const all: ActiveCall = {
			driver: call.driver,
			endpoints: uniqueEndpoints([...call.endpoints, ...(prev?.endpoints ?? [])]),
			ports: uniquePorts([...call.ports, ...(prev?.ports ?? [])]),
		}
		if (!all.endpoints.length && !all.ports.length) return
		await sendCall(all, false, '', what)
	}

	const actions: CompanionActionDefinitions<ActionsSchema> = {
		call_role: {
			name: 'Call signal: role / device',
			description: 'Flash a call on every device holding the selected roles',
			options: [
				...targetOptions,
				{
					id: 'mode',
					type: 'dropdown',
					label: 'Mode',
					default: 'pulse',
					disableAutoExpression: true,
					choices: [
						{ id: 'pulse', label: 'Pulse' },
						{ id: 'on', label: 'On' },
						{ id: 'off', label: 'Off' },
						{ id: 'toggle', label: 'Toggle' },
					],
				},
				PULSE_OPTION,
				TEXT_OPTION,
			],
			callback: async ({ options }) => {
				const driver = driverFor('Call')
				if (!driver) return
				const key = `role:${JSON.stringify([options.targets ?? [], options.names ?? ''])}`
				const targets = resolveTargets(state, options.targets, options.names)
				const on =
					options.mode === 'toggle' ? !(targets.some(isCalling) || self.activeCalls.has(key)) : options.mode !== 'off'
				if (!on) return callOff(key, { driver, endpoints: targets.filter(isCalling), ports: [] }, 'Call off')
				const list = targets.filter(isOnline)
				if (!list.length) return self.log('info', 'Call: no online device matches the selection')
				// a call sent from Companion is credited to Companion in last_caller
				state.noteCallChannel(
					list.map((e) => e.id),
					'',
				)
				const pulseMs = options.mode === 'pulse' ? options.pulseMs : undefined
				await callOn(key, { driver, endpoints: list, ports: [] }, options.text, pulseMs, 'Call')
			},
		},

		rmk_role: {
			name: 'Remote mic kill: role / device',
			description: 'Turn off the talk keys on the selected devices',
			options: [...targetOptions],
			callback: async ({ options }) =>
				forPacks(resolveTargets(state, options.targets, options.names), 'RMK', async (d, e) => d.rmk(e)),
		},

		rmk_all: {
			name: 'Remote mic kill: all devices',
			description: 'Must be enabled in the connection settings',
			options: [],
			callback: async () => {
				if (!self.config.rmkAllEnabled) return self.log('warn', 'RMK all is disabled in the connection settings')
				await forPacks(packs(state), 'RMK all', async (d, e) => d.rmk(e))
			},
		},

		change_role: {
			name: 'Change device role',
			description: 'Assign a role to a beltpack, station or panel',
			options: [
				{ id: 'pack', type: 'dropdown', label: 'Device', choices: packList, default: firstId(packList, 0) },
				{ id: 'role', type: 'dropdown', label: 'New role', choices: roles, default: firstId(roles, 0) },
			],
			callback: async ({ options }) => {
				const e = state.endpoints.get(options.pack)
				if (!e) return self.log('warn', `Change role: device ${options.pack} not found`)
				const role = state.roles.get(options.role)
				if (!role) return self.log('warn', `Change role: role ${options.role} not found`)
				const driver = driverFor('Change role')
				if (!driver) return
				await driver
					.changeRole(e, role)
					.then(() => self.refresh('endpoints'))
					.catch((err) => self.log('warn', `Change role of ${e.label} failed: ${errMsg(err)}`))
			},
			learn: ({ options }) => {
				const e = state.endpoints.get(options.pack)
				const role = e && packRoleId(e, state)
				return role === undefined ? undefined : { role }
			},
		},

		call_channel: {
			name: 'Call signal: whole channel',
			description: 'Call every device and 2W/4W port that is a member of the channel',
			options: [
				{
					id: 'connection',
					type: 'dropdown',
					label: 'Channel',
					choices: connections,
					default: firstId(connections, 1),
				},
				{
					id: 'mode',
					type: 'dropdown',
					label: 'Mode',
					default: 'pulse',
					disableAutoExpression: true,
					choices: [
						{ id: 'pulse', label: 'Pulse' },
						{ id: 'on', label: 'On' },
						{ id: 'off', label: 'Off' },
					],
				},
				PULSE_OPTION,
				TEXT_OPTION,
			],
			callback: async ({ options }) => {
				const driver = driverFor('Channel call')
				if (!driver) return
				const key = `channel:${options.connection}`
				const members = channelParticipants(state, options.connection)
				const memberPacks = uniqueEndpoints(
					members.map((p) => endpointForParticipant(state, p)).filter((e): e is Endpoint => !!e && isPack(e)),
				)
				const memberPorts = uniquePorts(
					members
						.map((p) => portForParticipant(state, p))
						.filter((p): p is Port => p !== undefined && driver.canCallPort(p)),
				)
				if (options.mode === 'off') {
					return callOff(
						key,
						{ driver, endpoints: memberPacks.filter(isCalling), ports: memberPorts },
						'Channel call off',
					)
				}
				const online = memberPacks.filter(isOnline)
				if (!online.length && !memberPorts.length)
					return self.log('info', 'Channel call: the channel has no online members')
				state.noteCallChannel(
					online.map((e) => e.id),
					state.connections.get(options.connection)?.label ?? '',
				)
				const pulseMs = options.mode === 'pulse' ? options.pulseMs : undefined
				await callOn(key, { driver, endpoints: online, ports: memberPorts }, options.text, pulseMs, 'Channel call')
			},
		},

		port_route: {
			name: 'Route port to channel',
			description: 'Join or leave a partyline for a 2-wire, 4-wire, Dante/AES67 or program port',
			options: [
				{ id: 'port', type: 'dropdown', label: 'Port', choices: ports, default: firstId(ports, 0) },
				{
					id: 'connection',
					type: 'dropdown',
					label: 'Channel',
					choices: connections,
					default: firstId(connections, 1),
				},
				{
					id: 'mode',
					type: 'dropdown',
					label: 'Mode',
					default: 'toggle',
					choices: [
						{ id: 'join', label: 'Join' },
						{ id: 'leave', label: 'Leave' },
						{ id: 'toggle', label: 'Toggle' },
					],
				},
			],
			callback: async ({ options }) => {
				const port = state.ports.get(options.port)
				if (!port) return self.log('warn', `Port route: port ${options.port} not found`)
				const join =
					options.mode === 'toggle' ? !portInChannel(state, options.port, options.connection) : options.mode === 'join'
				// leaving a channel the port is not on is a no-op, not an error
				if (!join && !portInChannel(state, options.port, options.connection)) return
				const driver = driverFor('Port route')
				if (!driver) return
				await driver
					.portRoute(port, options.connection, join)
					.then(() => self.refresh('ports'))
					.catch((err) => self.log('warn', `Port route ${port.port_label} failed: ${errMsg(err)}`))
			},
			learn: ({ options }) => {
				const current = portChannels(state, options.port)
				return current.length ? { connection: current[0] } : undefined
			},
		},

		port_call: {
			name: 'Call signal: port',
			description: 'Call signal out of a 2W/4W port (on Arcadia only 4-wire + GPIO ports support this)',
			options: [
				{ id: 'port', type: 'dropdown', label: 'Port', choices: ports, default: firstId(ports, 0) },
				{
					id: 'mode',
					type: 'dropdown',
					label: 'Mode',
					default: 'pulse',
					disableAutoExpression: true,
					choices: [
						{ id: 'pulse', label: 'Pulse' },
						{ id: 'on', label: 'On' },
						{ id: 'off', label: 'Off' },
					],
				},
				PULSE_OPTION,
			],
			callback: async ({ options }) => {
				const port = state.ports.get(options.port)
				if (!port) return self.log('warn', `Port call: port ${options.port} not found`)
				const driver = driverFor('Port call')
				if (!driver) return
				const key = `port:${port.port_id}`
				if (options.mode === 'off') return callOff(key, { driver, endpoints: [], ports: [port] }, 'Port call off')
				const pulseMs = options.mode === 'pulse' ? options.pulseMs : undefined
				await callOn(key, { driver, endpoints: [], ports: [port] }, '', pulseMs, 'Port call')
			},
		},

		gpo_set: {
			name: 'Set GPO',
			options: [
				{ id: 'gpo', type: 'dropdown', label: 'GPO', choices: gpos, default: firstId(gpos, 0) },
				{
					id: 'mode',
					type: 'dropdown',
					label: 'Mode',
					default: 'toggle',
					choices: [
						{ id: 'on', label: 'Force on' },
						{ id: 'off', label: 'Force off' },
						{ id: 'toggle', label: 'Toggle' },
						{ id: 'release', label: 'Release (back to automatic)' },
					],
				},
			],
			callback: async ({ options }) => {
				const driver = driverFor('GPO')
				if (!driver) return
				const current = gpioActive(state, 'gpo', state.gpos.get(options.gpo))
				const enabled = options.mode === 'release' ? null : options.mode === 'toggle' ? !current : options.mode === 'on'
				await driver.setGpo(options.gpo, enabled).catch((err) => self.log('warn', `GPO failed: ${errMsg(err)}`))
			},
		},

		gpi_trigger: self.driver?.supportsGpiTrigger
			? {
					name: 'Trigger GPI (Arcadia)',
					description: 'Assert or release a GPI input, as if the physical input had changed',
					options: [
						{ id: 'gpi', type: 'dropdown', label: 'GPI', choices: gpis, default: firstId(gpis, 0) },
						{
							id: 'mode',
							type: 'dropdown',
							label: 'State',
							default: 'on',
							choices: [
								{ id: 'on', label: 'On' },
								{ id: 'off', label: 'Off' },
								{ id: 'toggle', label: 'Toggle' },
							],
						},
					],
					callback: async ({ options }) => {
						const driver = driverFor('Trigger GPI')
						if (!driver) return
						const current = gpioActive(state, 'gpi', state.gpis.get(options.gpi))
						const enabled = options.mode === 'toggle' ? !current : options.mode === 'on'
						await driver
							.setGpi(options.gpi, enabled)
							.catch((err) => self.log('warn', `Trigger GPI failed: ${errMsg(err)}`))
					},
				}
			: undefined,
	}

	self.setActionDefinitions(actions)
}
