import {
	ButtonGraphicsDecorationType,
	type ButtonGraphicsBoxElement,
	type CompanionPresetDefinition,
	type CompanionPresetDefinitions,
	type CompanionPresetGroup,
	type CompanionPresetSection,
	type SomeButtonGraphicsElement,
} from '@companion-module/base'
import type { ModuleSchema } from './main.js'
import type ModuleInstance from './main.js'
import { portLabel } from './choices.js'
import { COLORS } from './feedbacks.js'
import {
	channelParticipants,
	isOnline,
	isReplyKey,
	keyStates,
	packRoles,
	packsForRole,
	portChannels,
	roleKeysFor,
	type KeySelector,
} from './resolve.js'
import type { Endpoint, Role } from './types.js'

// Preset conventions:
// - Every label on a button comes from a variable, so renaming a role, channel or port in CCM updates the button.
// - Text size is 'auto', so long names shrink instead of being cut off.
// - Colours mean the same everywhere: red = talking, amber = call signal, orange = low battery,
//   grey = offline, green = routed / active.
// - Anything that affects more than one person (RMK all) needs a deliberate long press.

type Preset = CompanionPresetDefinition<ModuleSchema>
type Group = CompanionPresetGroup<ModuleSchema>

/** The keys of a role as shown on key tally buttons: the channel a key talks to, or its position. */
interface KeyTile {
	key: KeySelector
	/** Button text for the key (may contain a variable). */
	text: string
	/** Plain text for the preset name. */
	name: string
}

const KEY_LETTERS = 'ABCD'

const CREW_NOTES = (low: number): string =>
	'Hold to call whoever has the role. Red = talking, amber = call signal, grey = offline. ' +
	`The bar shows the battery: red below ${low} %, amber below 50 %, green above.`
const BATTERY_NOTES = (low: number): string =>
	`Battery level of the device holding the role: red below ${low} %, amber below 50 %, green above. ` +
	'Grey while the device is offline.'

/** An element property driven by an expression (here: a single module variable). */
const expr = (value: string) => ({ isExpression: true as const, value })

/** A text element across the full width, with the text shrinking to fit. */
function text(
	id: string,
	value: string,
	x: number,
	y: number,
	height: number,
	opts: { fontsize: number; weight?: 'normal' | 'bold' },
): SomeButtonGraphicsElement<Record<string, never>> {
	return {
		id,
		type: 'text',
		text: value,
		x,
		y,
		width: 100 - 2 * x,
		height,
		fontsize: opts.fontsize,
		fontsizeAllowShrink: true,
		font: 'companion-sans',
		weight: opts.weight ?? 'normal',
		color: COLORS.white,
		halign: 'center',
		valign: 'center',
	}
}

function box(id: string, x: number, y: number, width: number, height: number, color: number): ButtonGraphicsBoxElement {
	return { id, type: 'box', x, y, width, height, color }
}

export function UpdatePresets(self: ModuleInstance): void {
	const state = self.state
	const driver = self.driver
	const v = (name: string) => `$(${self.label}:${name})`
	const presets: CompanionPresetDefinitions<ModuleSchema> = {}
	const add = (id: string, preset: Preset): string => {
		presets[id] = preset
		return id
	}
	/** A layered preset with a simple fallback, for hosts that cannot draw layered buttons. */
	const addAlternatives = (id: string, layered: Preset, simple: Preset): string => {
		presets[id] = { type: 'alternatives', variants: [layered, simple] }
		return id
	}
	const group = (id: string, name: string, ids: string[], description?: string): Group[] =>
		ids.length ? [{ id, type: 'simple', name, description, presets: ids }] : []

	const roles = packRoles(state)
	const rolesInUse = roles.filter((r) => packsForRole(state, r.id).length > 0)
	const otherRoles = roles.filter((r) => !rolesInUse.includes(r))
	// the crew check expects the roles that are online when the button is created
	const rolesOnline = rolesInUse.filter((r) => packsForRole(state, r.id).some(isOnline))
	const channels = [...state.connections.values()].sort((a, b) => a.id - b.id)
	const channelsInUse = channels.filter((c) => channelParticipants(state, c.id).length > 0)
	const ports = [...state.ports.values()].sort((a, b) => a.port_id - b.port_id)
	const target = (role: Role) => ({ targets: [`r:${role.id}`], names: '' })
	// devices that run on a battery: they report a level, or they are wireless beltpacks (FreeSpeak II/Edge/Icon)
	const onBattery = (e: Endpoint) => typeof e.liveStatus?.batteryLevel === 'number' || /^(FS|E-BP)/.test(e.type)
	const rolesOnBattery = rolesInUse.filter((r) => packsForRole(state, r.id).some(onBattery))
	const offlineStyle = { bgcolor: COLORS.grey, color: COLORS.dimText }

	// --- crew: one tile per role --------------------------------------------------------------------

	const callSteps = (role: Role) => [
		{
			down: [
				{ actionId: 'call_role' as const, options: { ...target(role), mode: 'on' as const, pulseMs: 2000, text: '' } },
			],
			up: [
				{ actionId: 'call_role' as const, options: { ...target(role), mode: 'off' as const, pulseMs: 2000, text: '' } },
			],
		},
	]
	/** Background / text colours of a role tile, as element overrides for layered presets. */
	const tileOverrides = (bg: number, fg: number, textIds: string[]) => [
		{ elementId: 'bg', elementProperty: 'color', override: bg },
		...textIds.map((elementId) => ({ elementId, elementProperty: 'color', override: fg })),
	]
	const roleStateFeedbacks = (role: Role, textIds: string[]) => [
		{
			feedbackId: 'role_online' as const,
			options: target(role),
			isInverted: true,
			styleOverrides: tileOverrides(COLORS.grey, COLORS.dimText, textIds),
		},
		{
			feedbackId: 'role_calling' as const,
			options: target(role),
			styleOverrides: tileOverrides(COLORS.amber, COLORS.black, textIds),
		},
		{
			feedbackId: 'role_talking' as const,
			options: { ...target(role), key: 'any' },
			styleOverrides: tileOverrides(COLORS.red, COLORS.white, textIds),
		},
	]

	const crewTile = (role: Role): string => {
		const r = `r${role.id}`
		const simple: Preset = {
			type: 'simple',
			name: `${role.label}: status, hold to call`,
			keywords: ['role', 'crew', 'call', 'tally', 'battery', role.label],
			style: {
				text: `${v(`${r}_label`)}\n${v(`${r}_status`)}`,
				size: 'auto',
				color: COLORS.white,
				bgcolor: COLORS.black,
			},
			steps: callSteps(role),
			feedbacks: [
				{ feedbackId: 'role_online', options: target(role), isInverted: true, style: offlineStyle },
				{
					feedbackId: 'role_battery_below',
					options: { ...target(role), threshold: self.config.lowBattery },
					style: { bgcolor: COLORS.orange, color: COLORS.white },
				},
				{ feedbackId: 'role_calling', options: target(role), style: { bgcolor: COLORS.amber, color: COLORS.black } },
				{
					feedbackId: 'role_talking',
					options: { ...target(role), key: 'any' },
					style: { bgcolor: COLORS.red, color: COLORS.white },
				},
			],
		}
		const layered: Preset = {
			type: 'layered',
			name: simple.name,
			keywords: simple.keywords,
			notes: CREW_NOTES(self.config.lowBattery),
			canvas: { decoration: ButtonGraphicsDecorationType.FollowDefault },
			elements: [
				box('bg', 0, 0, 100, 100, COLORS.black),
				text('name', v(`${r}_label`), 0, 0, 46, { fontsize: 46, weight: 'bold' }),
				text('status', v(`${r}_status`), 0, 46, 26, { fontsize: 62 }),
				...batteryBar(r, 75),
			],
			steps: callSteps(role),
			feedbacks: roleStateFeedbacks(role, ['name', 'status']),
		}
		return addAlternatives(`crew_r${role.id}`, layered, simple)
	}

	// --- battery: ring gauge per role whose device runs on a battery --------------------------------

	const batteryTile = (role: Role): string => {
		const r = `r${role.id}`
		const simple: Preset = {
			type: 'simple',
			name: `${role.label}: battery`,
			keywords: ['battery', 'meter', 'gauge', role.label],
			style: {
				text: `${v(`${r}_label`)}\n${v(`${r}_battery_text`)}\n${v(`${r}_time_left`)}`,
				size: 'auto',
				color: COLORS.white,
				bgcolor: COLORS.black,
			},
			steps: [],
			feedbacks: [
				{ feedbackId: 'role_online', options: target(role), isInverted: true, style: offlineStyle },
				{
					feedbackId: 'role_battery_below',
					options: { ...target(role), threshold: self.config.lowBattery },
					style: { bgcolor: COLORS.orange, color: COLORS.white },
				},
			],
		}
		const layered: Preset = {
			type: 'layered',
			name: simple.name,
			keywords: simple.keywords,
			notes: BATTERY_NOTES(self.config.lowBattery),
			canvas: { decoration: ButtonGraphicsDecorationType.FollowDefault },
			elements: [
				box('bg', 0, 0, 100, 100, COLORS.black),
				{
					id: 'ring',
					type: 'gauge',
					enabled: expr(v(`${r}_battery_known`)),
					x: 4,
					y: 4,
					width: 92,
					height: 92,
					orientation: 'ring',
					startAngle: 225,
					endAngle: 135,
					ringWidth: 13,
					roundedEnds: true,
					...gaugeLevel(r),
				},
				text('name', v(`${r}_label`), 23, 15, 20, { fontsize: 80, weight: 'bold' }),
				text('pct', v(`${r}_battery_text`), 18, 36, 30, { fontsize: 90, weight: 'bold' }),
				text('time', v(`${r}_time_left`), 18, 66, 18, { fontsize: 80 }),
			],
			steps: [],
			feedbacks: [
				{
					feedbackId: 'role_online',
					options: target(role),
					isInverted: true,
					styleOverrides: [
						...tileOverrides(COLORS.grey, COLORS.dimText, ['name', 'pct', 'time']),
						{ elementId: 'pct', elementProperty: 'text', override: 'OFFLINE' },
					],
				},
			],
		}
		return addAlternatives(`battery_r${role.id}`, layered, simple)
	}

	/** A horizontal battery bar with a dark backing, shown only while the role reports a battery level. */
	const batteryBar = (r: string, y: number) => {
		const known = expr(v(`${r}_battery_known`))
		return [
			{ ...box('barBack', 6, y, 88, 18, COLORS.black), enabled: known, cornerRadius: 50 },
			{
				id: 'bar',
				type: 'gauge' as const,
				enabled: known,
				x: 10,
				y: y + 4,
				width: 80,
				height: 10,
				orientation: 'horizontal' as const,
				...gaugeLevel(r),
			},
		]
	}

	/** Gauge value and colours: red below the low battery threshold, amber below 50 %, green above. */
	const gaugeLevel = (r: string) => {
		const low = self.config.lowBattery
		return {
			value: expr(v(`${r}_battery`)),
			min: 0,
			max: 100,
			fillEnabled: true,
			multiColour: false,
			fillWidth: 100,
			trackWidth: 100,
			trackStyle: 'dimmed' as const,
			trackAmount: 30,
			markerEnabled: false,
			stops: [
				{ value: 0, color: COLORS.red, gradient: false },
				{ value: low, color: COLORS.amber, gradient: false },
				{ value: Math.min(100, Math.max(50, low + 10)), color: COLORS.green, gradient: false },
			],
		}
	}

	// --- key tally: one tile per key of each role in use ---------------------------------------------

	/** What a key talks to (channel, role or port), as button text and as a plain name. */
	const keyTarget = (entities: string[]): { text: string; name: string } | undefined => {
		for (const res of entities) {
			const channelId = /\/connections\/(\d+)$/.exec(res)?.[1]
			const channel = channelId ? state.connections.get(Number(channelId)) : undefined
			if (channel) return { text: `on ${v(`ch${channel.id}_label`)}`, name: `on ${channel.label}` }
			const roleId = /\/(?:rolesets|roles)\/(\d+)$/.exec(res)?.[1]
			const targetRole = roleId ? state.roles.get(Number(roleId)) : undefined
			if (targetRole && roles.includes(targetRole))
				return { text: `to ${v(`r${targetRole.id}_label`)}`, name: `to ${targetRole.label}` }
			const port = [...state.ports.values()].find((p) => p.res === res)
			if (port) return { text: `to ${v(`port${port.port_id}_label`)}`, name: `to ${port.port_label}` }
		}
		return undefined
	}

	const keyTiles = (role: Role): KeyTile[] => {
		const holder = packsForRole(state, role.id)[0]
		const keys = roleKeysFor(role, holder?.type ?? '')
		if (keys?.length) {
			const tiles: KeyTile[] = []
			for (const k of keys) {
				if (k.isReply || (holder !== undefined && isReplyKey(state, holder, k.index))) {
					tiles.push({ key: 'reply', text: 'Reply', name: 'reply key' })
					continue
				}
				// a key with nothing assigned cannot talk to anyone: no tile
				const target = keyTarget(k.entities)
				if (target) tiles.push({ key: k.index, text: target.text, name: `key ${k.index + 1} (${target.name})` })
			}
			return tiles
		}
		// no key layout known: FreeSpeak II packs have keys A-D and a reply key
		if (holder?.type === 'FSII-BP') {
			return [
				...[0, 1, 2, 3].map((i) => ({ key: i, text: `Key ${KEY_LETTERS[i]}`, name: `key ${KEY_LETTERS[i]}` })),
				{ key: 'reply' as const, text: 'Reply', name: 'reply key' },
			]
		}
		const count = keyStates(holder).length || 4
		return Array.from({ length: count }, (_, i) => ({ key: i, text: `Key ${i + 1}`, name: `key ${i + 1}` }))
	}

	const keyTile = (role: Role, k: KeyTile, position: number): string =>
		add(`key_r${role.id}_${position}`, {
			type: 'simple',
			name: `${role.label}: ${k.name} talking`,
			keywords: ['key', 'talk', 'tally', role.label],
			style: { text: `${v(`r${role.id}_label`)}\n${k.text}`, size: 'auto', color: COLORS.white, bgcolor: COLORS.black },
			steps: [],
			feedbacks: [
				{ feedbackId: 'role_online', options: target(role), isInverted: true, style: offlineStyle },
				{
					feedbackId: 'role_talking',
					options: { ...target(role), key: k.key },
					style: { bgcolor: COLORS.red, color: COLORS.white },
				},
			],
		})

	// --- mic kill -------------------------------------------------------------------------------------

	const rmkTile = (role: Role): string =>
		add(`rmk_r${role.id}`, {
			type: 'simple',
			name: `${role.label}: remote mic kill`,
			keywords: ['rmk', 'mic', 'kill', 'mute', role.label],
			style: { text: `RMK\n${v(`r${role.id}_label`)}`, size: 'auto', color: COLORS.white, bgcolor: COLORS.darkRed },
			steps: [{ down: [{ actionId: 'rmk_role', options: target(role) }], up: [] }],
			feedbacks: [
				{ feedbackId: 'role_online', options: target(role), isInverted: true, style: offlineStyle },
				{
					feedbackId: 'role_talking',
					options: { ...target(role), key: 'any' },
					style: { bgcolor: COLORS.red, color: COLORS.white },
				},
			],
		})

	const rmkAll = self.config.rmkAllEnabled
		? [
				add('rmk_all', {
					type: 'simple',
					name: 'Remote mic kill: all devices (hold 1 s)',
					keywords: ['rmk', 'mic', 'kill', 'mute', 'all'],
					style: { text: 'RMK ALL\nhold 1 s', size: 'auto', color: COLORS.white, bgcolor: COLORS.darkRed },
					steps: [
						{
							down: [],
							up: [],
							1000: { options: { runWhileHeld: true }, actions: [{ actionId: 'rmk_all', options: {} }] },
						},
					],
					feedbacks: [],
				}),
			]
		: []

	// --- channels -------------------------------------------------------------------------------------

	const channelTile = (id: number, label: string): string =>
		add(`ch_${id}`, {
			type: 'simple',
			name: `${label}: talk tally, hold to call`,
			keywords: ['channel', 'partyline', 'tally', 'call', label],
			style: {
				text: `${v(`ch${id}_label`)}\n${v(`ch${id}_talkers`)}`,
				size: 'auto',
				color: COLORS.white,
				bgcolor: COLORS.black,
			},
			steps: [
				{
					down: [{ actionId: 'call_channel', options: { connection: id, mode: 'on', pulseMs: 2000, text: '' } }],
					up: [{ actionId: 'call_channel', options: { connection: id, mode: 'off', pulseMs: 2000, text: '' } }],
				},
			],
			feedbacks: [
				{
					feedbackId: 'channel_calling',
					options: { connection: id },
					style: { bgcolor: COLORS.amber, color: COLORS.black },
				},
				{
					feedbackId: 'channel_talking',
					options: { connection: id },
					style: { bgcolor: COLORS.red, color: COLORS.white },
				},
			],
		})

	// --- ports: routing per port, call signal --------------------------------------------------------

	const portGroups: Group[] = []
	for (const port of ports) {
		const p = `port${port.port_id}`
		const ids = [
			add(`route_${p}_info`, {
				type: 'simple',
				name: `${portLabel(port)}: current routing`,
				keywords: ['port', 'route', port.port_label],
				style: {
					text: `${v(`${p}_label`)} routed:\n${v(`${p}_channels`)}`,
					size: 'auto',
					color: COLORS.white,
					bgcolor: COLORS.black,
				},
				steps: [],
				feedbacks: [],
			}),
		]
		// channels with members, plus wherever the port is routed now
		const current = new Set(portChannels(state, port.port_id))
		for (const c of channels.filter((c) => current.has(c.id) || channelsInUse.includes(c))) {
			ids.push(
				add(`route_${p}_ch${c.id}`, {
					type: 'simple',
					name: `${port.port_label} to ${c.label}: toggle`,
					keywords: ['port', 'route', 'join', 'leave', port.port_label, c.label],
					style: {
						text: `${v(`${p}_label`)}\n${v(`ch${c.id}_label`)}`,
						size: 'auto',
						color: COLORS.white,
						bgcolor: COLORS.black,
					},
					steps: [
						{
							down: [{ actionId: 'port_route', options: { port: port.port_id, connection: c.id, mode: 'toggle' } }],
							up: [],
						},
					],
					feedbacks: [
						{
							feedbackId: 'port_in_channel',
							options: { port: port.port_id, connection: c.id },
							style: { bgcolor: COLORS.green, color: COLORS.white },
						},
					],
				}),
			)
		}
		portGroups.push(...group(`route_${p}`, portLabel(port), ids))
	}

	const portCallIds = ports
		.filter((port) => driver?.canCallPort(port))
		.map((port) =>
			add(`portcall_port${port.port_id}`, {
				type: 'simple',
				name: `${portLabel(port)}: hold to call`,
				keywords: ['port', 'call', port.port_label],
				style: {
					text: `CALL\n${v(`port${port.port_id}_label`)}`,
					size: 'auto',
					color: COLORS.white,
					bgcolor: COLORS.black,
				},
				steps: [
					{
						down: [{ actionId: 'port_call', options: { port: port.port_id, mode: 'on', pulseMs: 2000 } }],
						up: [{ actionId: 'port_call', options: { port: port.port_id, mode: 'off', pulseMs: 2000 } }],
					},
				],
				feedbacks: [],
			}),
		)

	// --- GPIO -----------------------------------------------------------------------------------------

	const gpoIds = [...state.gpos.values()].map((g) =>
		add(`gpo_${g.id}`, {
			type: 'simple',
			name: `${g.label || `GPO ${g.id}`}: toggle`,
			keywords: ['gpo', 'gpio', 'output', 'relay'],
			style: { text: g.label || `GPO ${g.id}`, size: 'auto', color: COLORS.white, bgcolor: COLORS.black },
			steps: [{ down: [{ actionId: 'gpo_set', options: { gpo: g.id, mode: 'toggle' } }], up: [] }],
			feedbacks: [
				{ feedbackId: 'gpo_state', options: { gpo: g.id }, style: { bgcolor: COLORS.green, color: COLORS.white } },
			],
		}),
	)
	const gpiIds = [...state.gpis.values()].map((g) =>
		add(`gpi_${g.id}`, {
			type: 'simple',
			name: `${g.label || `GPI ${g.id}`}: state`,
			keywords: ['gpi', 'gpio', 'input'],
			style: { text: g.label || `GPI ${g.id}`, size: 'auto', color: COLORS.white, bgcolor: COLORS.black },
			steps: [],
			feedbacks: [
				{ feedbackId: 'gpi_state', options: { gpi: g.id }, style: { bgcolor: COLORS.green, color: COLORS.white } },
			],
		}),
	)
	const gpiTriggerIds = driver?.supportsGpiTrigger
		? [...state.gpis.values()].map((g) =>
				add(`gpitrigger_${g.id}`, {
					type: 'simple',
					name: `${g.label || `GPI ${g.id}`}: trigger (toggle)`,
					keywords: ['gpi', 'gpio', 'trigger'],
					style: {
						text: `${g.label || `GPI ${g.id}`}\ntrigger`,
						size: 'auto',
						color: COLORS.white,
						bgcolor: COLORS.black,
					},
					steps: [{ down: [{ actionId: 'gpi_trigger', options: { gpi: g.id, mode: 'toggle' } }], up: [] }],
					feedbacks: [
						{ feedbackId: 'gpi_state', options: { gpi: g.id }, style: { bgcolor: COLORS.green, color: COLORS.white } },
					],
				}),
			)
		: []

	// --- status & alerts ------------------------------------------------------------------------------

	const statusIds = [
		add('status_device', {
			type: 'simple',
			name: 'Device: connection and devices online',
			keywords: ['status', 'connected', 'base', 'online'],
			style: {
				text: `${v('base_label')}\n${v('packs_online')}/${v('packs_total')} online`,
				size: 'auto',
				color: COLORS.white,
				bgcolor: COLORS.red,
			},
			steps: [],
			feedbacks: [
				{ feedbackId: 'base_connected', options: {}, style: { bgcolor: COLORS.darkGreen, color: COLORS.white } },
			],
		}),
		add('status_battery', {
			type: 'simple',
			name: 'Low battery list',
			keywords: ['battery', 'alert', 'low'],
			style: { text: `LOW BATT\n${v('low_battery_list')}`, size: 'auto', color: COLORS.white, bgcolor: COLORS.black },
			steps: [],
			feedbacks: [
				{
					feedbackId: 'any_battery_below',
					options: { threshold: self.config.lowBattery },
					style: { bgcolor: COLORS.orange, color: COLORS.white },
				},
			],
		}),
		add('status_crew', {
			type: 'simple',
			name: 'Crew check: a role in use has no device online',
			keywords: ['crew', 'missing', 'offline', 'alert'],
			style: { text: `OFFLINE\n${v('offline_list')}`, size: 'auto', color: COLORS.white, bgcolor: COLORS.black },
			steps: [],
			feedbacks: [
				{
					// the roles online when the button is created; edit the feedback to change who is expected
					feedbackId: 'any_role_missing',
					options: { roles: rolesOnline.map((r) => r.id) },
					style: { bgcolor: COLORS.red, color: COLORS.white },
				},
			],
		}),
		add('status_lastcall', {
			type: 'simple',
			name: 'Last call signal (amber while a call is active)',
			keywords: ['call', 'caller', 'last'],
			style: {
				text: `LAST CALL\n${v('last_caller')}\n${v('last_call_time')}`,
				size: 'auto',
				color: COLORS.white,
				bgcolor: COLORS.black,
			},
			steps: [],
			feedbacks: [{ feedbackId: 'any_calling', options: {}, style: { bgcolor: COLORS.amber, color: COLORS.black } }],
		}),
	]

	// --- structure ------------------------------------------------------------------------------------

	const sections: CompanionPresetSection<ModuleSchema>[] = [
		{
			id: 'crew',
			name: 'Crew',
			description:
				'One button per role: name, status and a battery bar. Hold to call whoever has the role. ' +
				'Red = talking, amber = call signal, grey = offline.',
			definitions: [
				...group('crew_in_use', 'Roles in use', rolesInUse.map(crewTile)),
				...group('crew_other', 'Other roles', otherRoles.map(crewTile), 'Roles no device holds at the moment'),
			],
		},
		{
			id: 'battery',
			name: 'Battery',
			description: 'Battery meter per role on a wireless pack: red below the low battery threshold, amber below 50 %.',
			definitions: group('battery_roles', 'Roles in use', rolesOnBattery.map(batteryTile)),
		},
		{
			id: 'keys',
			name: 'Key tally',
			description:
				'Red while a role talks on that key. Keys show the channel they talk to, where the device reports it.',
			definitions: rolesInUse.flatMap((role) =>
				group(
					`keys_r${role.id}`,
					role.label,
					keyTiles(role).map((k, i) => keyTile(role, k, i)),
				),
			),
		},
		{
			id: 'channels',
			name: 'Channels',
			description: 'Who is talking on each channel (red); amber while someone calls. Hold to call everyone on it.',
			definitions: [
				...group(
					'channels_in_use',
					'Channels with members',
					channelsInUse.map((c) => channelTile(c.id, c.label)),
				),
				...group(
					'channels_empty',
					'Empty channels',
					channels.filter((c) => !channelsInUse.includes(c)).map((c) => channelTile(c.id, c.label)),
				),
			],
		},
		{
			id: 'micKill',
			name: 'Mic kill',
			description: self.config.rmkAllEnabled
				? 'Turn off the talk keys of one role (red while it talks). RMK ALL needs a 1 second hold.'
				: 'Turn off the talk keys of one role (red while it talks). To get an RMK ALL button, enable ' +
					'"Remote mic kill: all devices" in the connection settings.',
			definitions: [
				...group('rmk_all', 'All devices', rmkAll),
				...group('rmk_roles', 'Roles', rolesInUse.map(rmkTile)),
			],
		},
		{
			id: 'routing',
			name: 'Port routing',
			description:
				'Per port: its current routing, then a toggle for each channel with members (green = routed). ' +
				'For another channel, change it in the action and feedback of a toggle.',
			definitions: portGroups,
		},
		{
			id: 'portCall',
			name: 'Port call',
			description: 'Hold to send a call signal out of the port.',
			definitions: group('port_call', 'Ports', portCallIds),
		},
		{
			id: 'gpio',
			name: 'GPIO',
			definitions: [
				...group('gpo', 'Outputs: toggle (green = on)', gpoIds),
				...group('gpi', 'Inputs: state (green = active)', gpiIds),
				...group('gpi_trigger', 'Inputs: trigger from Companion', gpiTriggerIds),
			],
		},
		{
			id: 'status',
			name: 'Status & alerts',
			definitions: group('status', 'Status', statusIds),
		},
	]

	self.setPresetDefinitions(
		sections.filter((s) => s.definitions.length > 0),
		presets,
	)
}
