import {
	ButtonGraphicsDecorationType,
	type ButtonGraphicsGaugeElement,
	type CompanionButtonStepActions,
	type CompanionPresetDefinitions,
	type CompanionPresetGroup,
	type CompanionPresetSection,
	type CompanionLayeredButtonPresetDefinition,
	type SomePresetLayeredFeedbackEntry,
} from '@companion-module/base'
import type { ModuleSchema } from './main.js'
import type ModuleInstance from './main.js'
import { portLabel } from './choices.js'
import {
	background,
	box,
	chip,
	expr,
	micIcon,
	PALETTE,
	ring,
	text,
	toggle,
	toggleOn,
	type Element,
	type Override,
} from './graphics.js'
import {
	channelParticipants,
	isOnline,
	packRoles,
	packsForRole,
	portChannels,
	roleKeySlots,
	SELECTED_TARGET,
	type KeySelector,
	type KeySlot,
} from './resolve.js'
import type { Endpoint, Port, Role } from './types.js'
import { DETAIL_KEYS } from './variables.js'

// Preset conventions:
// - Every preset is a layered button (Companion 5.1). Labels come from variables, so renaming a role, channel or
//   port in CCM updates the buttons; placed as linked presets (the 5.1 default) they also pick up module updates.
// - Colours mean the same everywhere (see graphics.ts): red = talking, amber = call signal, green = routed /
//   active / listening, blue ring = shown on the role detail page, dim grey = offline.
// - Role buttons: a short press opens the role on the detail page, a long press is remote mic kill.
// - Anything that affects more than one person (RMK all) needs a deliberate long press.

type Preset = CompanionLayeredButtonPresetDefinition<ModuleSchema>
type Group = CompanionPresetGroup<ModuleSchema>
type Feedback = SomePresetLayeredFeedbackEntry<ModuleSchema>
type Steps = CompanionButtonStepActions<ModuleSchema>[]

/** How long to hold a role button for remote mic kill. */
export const RMK_HOLD_MS = 800
/** How long to hold the RMK ALL and assign buttons. */
export const CONFIRM_HOLD_MS = 1000

const FULL = { x: 0, y: 0, width: 100, height: 100 }

/** Recolour several elements at once. */
const paint = (color: number, ids: string[], prop = 'color'): Override[] =>
	ids.map((elementId) => ({ elementId, elementProperty: prop, override: color }))
const show = (ids: string[], enabled = true): Override[] =>
	ids.map((elementId) => ({ elementId, elementProperty: 'enabled', override: enabled }))
const set = (elementId: string, elementProperty: string, override: Override['override']): Override => ({
	elementId,
	elementProperty,
	override,
})

/** A full-size overlay that breathes while a call signal is active (oscillate() is new in Companion 5.1). */
const pulse = (id = 'pulse'): Element => box(id, FULL, PALETTE.white, { enabled: false, opacity: 0 })
const pulseOn = (id = 'pulse'): Override[] => [
	set(id, 'enabled', true),
	set(id, 'opacity', expr('oscillate(1200) * 35')),
]

export function UpdatePresets(self: ModuleInstance): void {
	const state = self.state
	const driver = self.driver
	const low = self.config.lowBattery
	const mid = Math.min(100, Math.max(50, low + 10))
	const v = (name: string) => `$(${self.label}:${name})`
	const presets: CompanionPresetDefinitions<ModuleSchema> = {}
	const add = (id: string, preset: Omit<Preset, 'type' | 'canvas'>): string => {
		presets[id] = {
			type: 'layered',
			canvas: { decoration: ButtonGraphicsDecorationType.Border },
			...preset,
		}
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
	const selected = { targets: [SELECTED_TARGET], names: '' }
	// devices that run on a battery: they report a level, or they are wireless beltpacks (FreeSpeak II/Edge/Icon)
	const onBattery = (e: Endpoint) => typeof e.liveStatus?.batteryLevel === 'number' || /^(FS|E-BP)/.test(e.type)
	const rolesOnBattery = rolesInUse.filter((r) => packsForRole(state, r.id).some(onBattery))

	// --- shared pieces --------------------------------------------------------------------------------

	/** Battery meter (composite) driven by a role's battery variables; hidden while no level is reported. */
	const batteryMeter = (prefix: string, b: { x: number; y: number; width: number; height: number }): Element => ({
		id: 'battery',
		type: 'composite',
		elementId: 'battery',
		...b,
		enabled: expr(v(`${prefix}_battery_known`)),
		options: { level: expr(v(`${prefix}_battery`)), low, mid },
	})
	/** Signal bars (composite) from a role's RSSI; hidden while no RSSI is reported. */
	const signalMeter = (prefix: string, b: { x: number; y: number; width: number; height: number }): Element => ({
		id: 'signal',
		type: 'composite',
		elementId: 'signal',
		...b,
		enabled: expr(v(`${prefix}_rssi_known`)),
		options: { bars: expr(v(`${prefix}_signal`)) },
	})
	/** A 270° ring gauge, open at the bottom. */
	const ringGauge = (
		id: string,
		value: string,
		enabled: string,
		stops: ButtonGraphicsGaugeElement['stops'],
		max = 100,
	): Element => ({
		id,
		type: 'gauge',
		enabled: expr(enabled),
		x: 5,
		y: 5,
		width: 90,
		height: 90,
		orientation: 'ring',
		startAngle: 225,
		endAngle: 135,
		ringWidth: 12,
		roundedEnds: true,
		value: expr(value),
		min: 0,
		max,
		fillEnabled: true,
		multiColour: false,
		fillWidth: 100,
		trackWidth: 100,
		trackStyle: 'dimmed',
		trackAmount: 22,
		markerEnabled: false,
		stops,
	})
	const batteryStops: ButtonGraphicsGaugeElement['stops'] = [
		{ value: 0, color: PALETTE.bad, gradient: false },
		{ value: low, color: PALETTE.call, gradient: false },
		{ value: mid, color: PALETTE.ok, gradient: false },
	]

	/**
	 * The live state of a role on its button, in increasing priority: offline (grey), calling (amber, breathing),
	 * talking (red), then the blue ring while the role is shown on the detail page.
	 */
	const roleStateFeedbacks = (
		options: { targets: string[]; names: string },
		texts: string[],
		extra: { offline?: Override[]; selectedRole?: number } = {},
	): Feedback[] => [
		{
			feedbackId: 'role_online',
			options,
			isInverted: true,
			styleOverrides: [set('bg', 'color', PALETTE.offBg), ...paint(PALETTE.offText, texts), ...(extra.offline ?? [])],
		},
		{
			feedbackId: 'role_calling',
			options,
			styleOverrides: [set('bg', 'color', PALETTE.call), ...paint(PALETTE.callText, texts), ...pulseOn()],
		},
		{
			feedbackId: 'role_talking',
			options: { ...options, key: 'any' },
			styleOverrides: [set('bg', 'color', PALETTE.talk), ...paint(PALETTE.white, texts)],
		},
		...(extra.selectedRole === undefined
			? []
			: [
					{
						feedbackId: 'role_selected' as const,
						options: { role: extra.selectedRole },
						styleOverrides: show(['selected']),
					},
				]),
	]

	/** Short press: show the role on the detail page (and switch there). */
	const openDetail = (role: Role) => ({ actionId: 'select_role' as const, options: { role: role.id, open: true } })

	// --- crew: one tile per role --------------------------------------------------------------------

	const crewTile = (role: Role): string => {
		const r = `r${role.id}`
		const texts = ['name', 'state']
		return add(`crew_r${role.id}`, {
			name: `${role.label}: status, battery and signal (press: details, hold: RMK)`,
			keywords: ['role', 'crew', 'tally', 'battery', 'rssi', 'signal', 'rmk', role.label],
			notes:
				`${role.label}. Press: show this role on the role detail page. Hold ${RMK_HOLD_MS / 1000} s: remote mic kill. ` +
				`Red = talking, amber = call signal, grey = offline, blue ring = shown on the detail page. ` +
				`Battery: red below ${low} %, amber below ${mid} %. Signal: 4-3 bars good, 2 amber, 1 red.`,
			elements: [
				background(),
				pulse(),
				text('name', v(`${r}_label`), { x: 5, y: 6, width: 90, height: 32 }, { size: 74, bold: true }),
				text('state', v(`${r}_state`), { x: 5, y: 39, width: 90, height: 20 }, { size: 78, color: PALETTE.ok }),
				batteryMeter(r, { x: 7, y: 70, width: 46, height: 18 }),
				signalMeter(r, { x: 68, y: 66, width: 25, height: 22 }),
				// wired stations and beltpacks report no battery or RF: show which device holds the role instead
				{
					...text('device', v(`${r}_pack`), { x: 5, y: 70, width: 90, height: 16 }, { size: 85, color: PALETTE.muted }),
					enabled: expr(`${v(`${r}_online`)} && !${v(`${r}_battery_known`)} && !${v(`${r}_rssi_known`)}`),
				},
				ring('selected', PALETTE.info),
				box('holdBg', { x: 0, y: 64, width: 100, height: 36 }, PALETTE.rmkHot, { enabled: false }),
				{
					...text('holdText', 'HOLD: RMK', { x: 4, y: 68, width: 92, height: 26 }, { size: 70, bold: true }),
					enabled: false,
				},
			],
			steps: [
				{
					down: [],
					up: [openDetail(role)],
					[RMK_HOLD_MS]: {
						options: { runWhileHeld: true },
						actions: [{ actionId: 'rmk_role', options: target(role) }],
					},
				},
			],
			feedbacks: [
				...roleStateFeedbacks(target(role), texts, { selectedRole: role.id }),
				{
					feedbackId: 'internal:buttonPushed',
					options: {},
					styleOverrides: show(['holdBg', 'holdText']),
				},
			],
		})
	}

	// --- battery: ring gauge per role whose device runs on a battery --------------------------------

	const batteryTile = (role: Role): string => {
		const r = `r${role.id}`
		return add(`battery_r${role.id}`, {
			name: `${role.label}: battery meter (press: details)`,
			keywords: ['battery', 'meter', 'gauge', role.label],
			notes: `Battery of the device holding ${role.label}: red below ${low} %, amber below ${mid} %. Grey while offline.`,
			elements: [
				background(),
				ringGauge('ring', v(`${r}_battery`), v(`${r}_battery_known`), batteryStops),
				text('pct', v(`${r}_battery_text`), { x: 20, y: 28, width: 60, height: 30 }, { size: 90, bold: true }),
				text('time', v(`${r}_time_left`), { x: 22, y: 57, width: 56, height: 15 }, { size: 85, color: PALETTE.dim }),
				text('name', v(`${r}_label`), { x: 18, y: 79, width: 64, height: 17 }, { size: 85, bold: true }),
				ring('selected', PALETTE.info),
			],
			steps: [{ down: [], up: [openDetail(role)] }],
			feedbacks: [
				{
					feedbackId: 'role_online',
					options: target(role),
					isInverted: true,
					styleOverrides: [
						...paint(PALETTE.offText, ['pct', 'time', 'name']),
						set('pct', 'text', 'OFFLINE'),
						set('bg', 'color', PALETTE.offBg),
					],
				},
				{
					feedbackId: 'role_battery_below',
					options: { ...target(role), threshold: low },
					styleOverrides: paint(PALETTE.bad, ['pct']),
				},
				{ feedbackId: 'role_selected', options: { role: role.id }, styleOverrides: show(['selected']) },
			],
		})
	}

	// --- key tally: one tile per assigned key of each role in use -------------------------------------

	const KIND: Record<string, string> = { channel: 'CHANNEL', role: 'DIRECT', port: 'PORT' }
	/** A key's target as button text (through a variable, so renames carry through). */
	const keyText = (k: KeySlot): { label: string; kind: string } => {
		if (k.isReply) return { label: 'Reply', kind: 'REPLY' }
		const t = k.target
		if (!t) return { label: `Key ${k.name}`, kind: 'KEY' }
		const label = t.kind === 'channel' ? `ch${t.id}_label` : t.kind === 'role' ? `r${t.id}_label` : `port${t.id}_label`
		return { label: v(label), kind: KIND[t.kind] }
	}

	const keyTile = (role: Role, k: KeySlot, position: number): string => {
		const key: KeySelector = k.isReply ? 'reply' : k.index
		const { label, kind } = keyText(k)
		const texts = ['target', 'role', 'kind']
		return add(`key_r${role.id}_${position}`, {
			name: `${role.label}: key ${k.name} (${k.isReply ? 'reply' : (k.target?.label ?? 'unassigned')})`,
			keywords: ['key', 'talk', 'listen', 'tally', role.label],
			notes: `Key ${k.name} of ${role.label}. Red = talking, green bar = listening. Press: show the role on the detail page.`,
			elements: [
				background(),
				...chip('key', k.name, { x: 6, y: 6, width: 22, height: 22 }, PALETTE.panel, PALETTE.dim),
				text(
					'role',
					v(`r${role.id}_label`),
					{ x: 31, y: 6, width: 64, height: 22 },
					{
						size: 70,
						color: PALETTE.dim,
						halign: 'right',
					},
				),
				text('target', label, { x: 5, y: 33, width: 90, height: 34 }, { size: 74, bold: true }),
				text('kind', kind, { x: 5, y: 70, width: 90, height: 14 }, { size: 85, color: PALETTE.muted }),
				box('listen', { x: 0, y: 90, width: 100, height: 10 }, PALETTE.ok, { enabled: false }),
			],
			steps: [{ down: [], up: [openDetail(role)] }],
			feedbacks: [
				{
					feedbackId: 'role_online',
					options: target(role),
					isInverted: true,
					styleOverrides: [set('bg', 'color', PALETTE.offBg), ...paint(PALETTE.offText, texts)],
				},
				{ feedbackId: 'role_listening', options: { ...target(role), key }, styleOverrides: show(['listen']) },
				{
					feedbackId: 'role_talking',
					options: { ...target(role), key },
					styleOverrides: [
						set('bg', 'color', PALETTE.talk),
						set('keyBg', 'color', PALETTE.talkDeep),
						...paint(PALETTE.white, [...texts, 'keyText']),
					],
				},
			],
		})
	}

	// --- mic kill -------------------------------------------------------------------------------------

	const rmkTile = (role: Role): string =>
		add(`rmk_r${role.id}`, {
			name: `${role.label}: remote mic kill`,
			keywords: ['rmk', 'mic', 'kill', 'mute', role.label],
			notes: `Turns off the talk keys of whoever holds ${role.label}. Bright red while they talk.`,
			elements: [
				background(PALETTE.rmk),
				micIcon('mic', { x: 30, y: 7, width: 40, height: 44 }, PALETTE.white, true, PALETTE.rmk),
				text('name', v(`r${role.id}_label`), { x: 5, y: 55, width: 90, height: 24 }, { size: 78, bold: true }),
				text('caption', 'MIC KILL', { x: 5, y: 80, width: 90, height: 13 }, { size: 85, color: 0xf2a7ad }),
				ring('alert', PALETTE.white, 4),
			],
			steps: [{ down: [{ actionId: 'rmk_role', options: target(role) }], up: [] }],
			feedbacks: [
				{
					feedbackId: 'role_online',
					options: target(role),
					isInverted: true,
					styleOverrides: [
						set('bg', 'color', PALETTE.offBg),
						set('mic', 'opacity', 35),
						set('micSlashBg', 'borderColor', PALETTE.offBg),
						...paint(PALETTE.offText, ['name', 'caption']),
					],
				},
				{
					feedbackId: 'role_talking',
					options: { ...target(role), key: 'any' },
					styleOverrides: [
						set('bg', 'color', PALETTE.rmkHot),
						set('micSlashBg', 'borderColor', PALETTE.rmkHot),
						set('caption', 'text', 'TALKING NOW'),
						set('caption', 'color', PALETTE.white),
						...show(['alert']),
						set('alert', 'opacity', expr('40 + oscillate(800) * 60')),
					],
				},
			],
		})

	const rmkAll = self.config.rmkAllEnabled
		? [
				add('rmk_all', {
					name: `Remote mic kill: all devices (hold ${CONFIRM_HOLD_MS / 1000} s)`,
					keywords: ['rmk', 'mic', 'kill', 'mute', 'all'],
					notes: `Turns off the talk keys of every device. Needs a ${CONFIRM_HOLD_MS / 1000} second hold.`,
					elements: [
						background(PALETTE.rmk),
						micIcon('mic', { x: 28, y: 5, width: 44, height: 46 }, PALETTE.white, true, PALETTE.rmk),
						text('name', 'RMK ALL', { x: 5, y: 54, width: 90, height: 26 }, { size: 80, bold: true }),
						text(
							'caption',
							`HOLD ${CONFIRM_HOLD_MS / 1000} S`,
							{ x: 5, y: 80, width: 90, height: 13 },
							{
								size: 85,
								color: 0xf2a7ad,
							},
						),
					],
					steps: [
						{
							down: [],
							up: [],
							[CONFIRM_HOLD_MS]: { options: { runWhileHeld: true }, actions: [{ actionId: 'rmk_all', options: {} }] },
						},
					],
					feedbacks: [
						{
							feedbackId: 'internal:buttonPushed',
							options: {},
							styleOverrides: [
								set('bg', 'color', PALETTE.rmkHot),
								set('micSlashBg', 'borderColor', PALETTE.rmkHot),
								set('caption', 'text', 'KEEP HOLDING'),
								set('caption', 'color', PALETTE.white),
							],
						},
					],
				}),
			]
		: []

	// --- channels -------------------------------------------------------------------------------------

	const channelTile = (id: number, label: string): string => {
		const texts = ['name', 'status', 'membersText']
		return add(`ch_${id}`, {
			name: `${label}: who is talking (hold: call the channel)`,
			keywords: ['channel', 'partyline', 'tally', 'call', label],
			notes: `${label}. Red while someone talks, amber while someone calls. Hold to call everyone on the channel.`,
			elements: [
				background(),
				pulse(),
				...chip('members', v(`ch${id}_members`), { x: 66, y: 6, width: 28, height: 20 }, PALETTE.panel, PALETTE.dim),
				...chip('type', 'PL', { x: 6, y: 6, width: 24, height: 20 }, PALETTE.panel, PALETTE.dim),
				text('name', v(`ch${id}_label`), { x: 5, y: 32, width: 90, height: 32 }, { size: 74, bold: true }),
				text('status', v(`ch${id}_status`), { x: 5, y: 68, width: 90, height: 22 }, { size: 74, color: PALETTE.dim }),
			],
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
					styleOverrides: [
						set('bg', 'color', PALETTE.call),
						...paint(PALETTE.callText, ['name', 'status']),
						...pulseOn(),
					],
				},
				{
					feedbackId: 'channel_talking',
					options: { connection: id },
					styleOverrides: [
						set('bg', 'color', PALETTE.talk),
						...paint(PALETTE.talkDeep, ['membersBg', 'typeBg']),
						...paint(PALETTE.white, [...texts, 'typeText']),
					],
				},
			],
		})
	}

	// --- ports: routing per port, call signal --------------------------------------------------------

	const portKind = (port: Port) => String(port.port_config_type ?? port.audioInterfaceType_shortName ?? 'PORT')
	const SWITCH = { x: 28, y: 70, width: 44, height: 20 }

	const portGroups: Group[] = []
	for (const port of ports) {
		const p = `port${port.port_id}`
		const ids = [
			add(`route_${p}_info`, {
				name: `${portLabel(port)}: current routing`,
				keywords: ['port', 'route', port.port_label],
				elements: [
					background(),
					...chip('kind', portKind(port), { x: 6, y: 6, width: 34, height: 20 }, PALETTE.panel, PALETTE.dim),
					text('name', v(`${p}_label`), { x: 5, y: 30, width: 90, height: 30 }, { size: 74, bold: true }),
					text('arrow', 'ROUTED TO', { x: 5, y: 62, width: 90, height: 12 }, { size: 85, color: PALETTE.muted }),
					text('channels', v(`${p}_channels`), { x: 5, y: 75, width: 90, height: 20 }, { size: 78, color: PALETTE.ok }),
				],
				steps: [],
				feedbacks: [],
			}),
		]
		// channels with members, plus wherever the port is routed now
		const current = new Set(portChannels(state, port.port_id))
		for (const c of channels.filter((c) => current.has(c.id) || channelsInUse.includes(c))) {
			ids.push(
				add(`route_${p}_ch${c.id}`, {
					name: `${port.port_label} to ${c.label}: toggle`,
					keywords: ['port', 'route', 'join', 'leave', port.port_label, c.label],
					notes: `Joins ${port.port_label} to ${c.label}, or takes it off. Green = routed.`,
					elements: [
						background(),
						text('port', v(`${p}_label`), { x: 5, y: 6, width: 90, height: 18 }, { size: 80, color: PALETTE.dim }),
						text('channel', v(`ch${c.id}_label`), { x: 5, y: 28, width: 90, height: 32 }, { size: 74, bold: true }),
						...toggle('switch', SWITCH),
					],
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
							styleOverrides: [...toggleOn('switch', SWITCH), set('bg', 'color', PALETTE.okDeep)],
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
				name: `${portLabel(port)}: hold to call`,
				keywords: ['port', 'call', port.port_label],
				elements: [
					background(),
					text('icon', '☎', { x: 0, y: -12, width: 100, height: 80 }, { size: 100, color: PALETTE.call }),
					text(
						'name',
						v(`port${port.port_id}_label`),
						{ x: 5, y: 52, width: 90, height: 26 },
						{
							size: 76,
							bold: true,
						},
					),
					text('caption', 'HOLD TO CALL', { x: 5, y: 80, width: 90, height: 13 }, { size: 85, color: PALETTE.muted }),
				],
				steps: [
					{
						down: [{ actionId: 'port_call', options: { port: port.port_id, mode: 'on', pulseMs: 2000 } }],
						up: [{ actionId: 'port_call', options: { port: port.port_id, mode: 'off', pulseMs: 2000 } }],
					},
				],
				feedbacks: [
					{
						feedbackId: 'internal:buttonPushed',
						options: {},
						styleOverrides: [
							set('bg', 'color', PALETTE.call),
							...paint(PALETTE.callText, ['icon', 'name', 'caption']),
							set('caption', 'text', 'CALLING'),
						],
					},
				],
			}),
		)

	// --- GPIO -----------------------------------------------------------------------------------------

	const gpioName = (g: { id: number; label?: string }, kind: string) => g.label || `${kind} ${g.id}`
	const led = (id: string): Element => ({
		id,
		type: 'circle',
		x: 36,
		y: 10,
		width: 28,
		height: 28,
		color: PALETTE.track,
		borderWidth: 3,
		borderColor: PALETTE.panel,
	})
	const ledOn = (id: string): Override[] => [set(id, 'color', PALETTE.ok), set(id, 'borderColor', 0x7be3a6)]

	const gpoIds = [...state.gpos.values()].map((g) =>
		add(`gpo_${g.id}`, {
			name: `${gpioName(g, 'GPO')}: toggle`,
			keywords: ['gpo', 'gpio', 'output', 'relay'],
			elements: [
				background(),
				text('kind', 'GPO', { x: 5, y: 6, width: 90, height: 16 }, { size: 85, color: PALETTE.muted }),
				text('name', gpioName(g, 'GPO'), { x: 5, y: 26, width: 90, height: 32 }, { size: 74, bold: true }),
				...toggle('switch', SWITCH),
			],
			steps: [{ down: [{ actionId: 'gpo_set', options: { gpo: g.id, mode: 'toggle' } }], up: [] }],
			feedbacks: [
				{
					feedbackId: 'gpo_state',
					options: { gpo: g.id },
					styleOverrides: [...toggleOn('switch', SWITCH), set('bg', 'color', PALETTE.okDeep)],
				},
			],
		}),
	)
	const gpiIds = [...state.gpis.values()].map((g) =>
		add(`gpi_${g.id}`, {
			name: `${gpioName(g, 'GPI')}: state`,
			keywords: ['gpi', 'gpio', 'input'],
			elements: [
				background(),
				led('led'),
				text('name', gpioName(g, 'GPI'), { x: 5, y: 46, width: 90, height: 28 }, { size: 74, bold: true }),
				text('caption', 'INPUT', { x: 5, y: 78, width: 90, height: 14 }, { size: 85, color: PALETTE.muted }),
			],
			steps: [],
			feedbacks: [
				{
					feedbackId: 'gpi_state',
					options: { gpi: g.id },
					styleOverrides: [...ledOn('led'), set('caption', 'text', 'ACTIVE'), set('caption', 'color', PALETTE.ok)],
				},
			],
		}),
	)
	const gpiTriggerIds = driver?.supportsGpiTrigger
		? [...state.gpis.values()].map((g) =>
				add(`gpitrigger_${g.id}`, {
					name: `${gpioName(g, 'GPI')}: trigger (toggle)`,
					keywords: ['gpi', 'gpio', 'trigger'],
					elements: [
						background(),
						led('led'),
						text('name', gpioName(g, 'GPI'), { x: 5, y: 46, width: 90, height: 28 }, { size: 74, bold: true }),
						text('caption', 'TRIGGER', { x: 5, y: 78, width: 90, height: 14 }, { size: 85, color: PALETTE.info }),
					],
					steps: [{ down: [{ actionId: 'gpi_trigger', options: { gpi: g.id, mode: 'toggle' } }], up: [] }],
					feedbacks: [{ feedbackId: 'gpi_state', options: { gpi: g.id }, styleOverrides: ledOn('led') }],
				}),
			)
		: []

	// --- status & alerts ------------------------------------------------------------------------------

	const statusIds = [
		add('status_device', {
			name: 'Device: connection and devices online',
			keywords: ['status', 'connected', 'base', 'online'],
			elements: [
				background(PALETTE.talkDeep),
				{ id: 'dot', type: 'circle', x: 8, y: 9, width: 12, height: 12, color: PALETTE.bad },
				text(
					'name',
					v('base_label'),
					{ x: 24, y: 6, width: 71, height: 18 },
					{
						size: 80,
						color: PALETTE.dim,
						halign: 'left',
					},
				),
				text(
					'count',
					`${v('packs_online')}/${v('packs_total')}`,
					{ x: 5, y: 30, width: 90, height: 38 },
					{
						size: 85,
						bold: true,
					},
				),
				text('caption', 'NO CONNECTION', { x: 5, y: 74, width: 90, height: 14 }, { size: 85, color: 0xf2a7ad }),
			],
			steps: [],
			feedbacks: [
				{
					feedbackId: 'base_connected',
					options: {},
					styleOverrides: [
						set('bg', 'color', PALETTE.bg),
						set('dot', 'color', PALETTE.ok),
						set('caption', 'text', 'DEVICES ONLINE'),
						set('caption', 'color', PALETTE.muted),
					],
				},
			],
		}),
		add('status_battery', {
			name: 'Low battery list',
			keywords: ['battery', 'alert', 'low'],
			elements: [
				background(),
				{
					id: 'battery',
					type: 'composite',
					elementId: 'battery',
					x: 26,
					y: 8,
					width: 48,
					height: 22,
					options: { level: 100, low, mid },
				},
				text('title', 'BATTERIES OK', { x: 5, y: 38, width: 90, height: 16 }, { size: 85, color: PALETTE.muted }),
				text('list', v('low_battery_list'), { x: 5, y: 56, width: 90, height: 38 }, { size: 46, bold: true }),
			],
			steps: [],
			feedbacks: [
				{
					feedbackId: 'any_battery_below',
					options: { threshold: low },
					styleOverrides: [
						set('bg', 'color', 0x3d1f08),
						set('battery', 'opt:level', 12),
						set('title', 'text', 'LOW BATTERY'),
						set('title', 'color', PALETTE.warn),
					],
				},
			],
		}),
		add('status_crew', {
			name: 'Crew check: a role in use has no device online',
			keywords: ['crew', 'missing', 'offline', 'alert'],
			notes:
				'Expects the roles that were online when the button was created. Edit the feedback to change who is expected.',
			elements: [
				background(),
				text('icon', '✓', { x: 0, y: -10, width: 100, height: 62 }, { size: 100, color: PALETTE.ok }),
				text('title', 'CREW OK', { x: 5, y: 44, width: 90, height: 16 }, { size: 85, color: PALETTE.muted }),
				{
					...text('list', v('offline_list'), { x: 5, y: 60, width: 90, height: 34 }, { size: 46, bold: true }),
					enabled: false,
				},
			],
			steps: [],
			feedbacks: [
				{
					// the roles online when the button is created; edit the feedback to change who is expected
					feedbackId: 'any_role_missing',
					options: { roles: rolesOnline.map((r) => r.id) },
					styleOverrides: [
						set('bg', 'color', PALETTE.talk),
						set('icon', 'text', '⚠'),
						set('icon', 'color', PALETTE.white),
						set('title', 'text', 'OFFLINE'),
						set('title', 'color', PALETTE.white),
						set('list', 'enabled', true),
					],
				},
			],
		}),
		add('status_lastcall', {
			name: 'Last call signal (amber while a call is active)',
			keywords: ['call', 'caller', 'last'],
			elements: [
				background(),
				pulse(),
				text('icon', '☎', { x: 3, y: -6, width: 40, height: 46 }, { size: 100, color: PALETTE.call, halign: 'left' }),
				text(
					'time',
					v('last_call_time'),
					{ x: 40, y: 8, width: 55, height: 22 },
					{
						size: 70,
						color: PALETTE.dim,
						halign: 'right',
						mono: true,
					},
				),
				text('title', 'LAST CALL', { x: 5, y: 40, width: 90, height: 16 }, { size: 85, color: PALETTE.muted }),
				text('caller', v('last_caller'), { x: 5, y: 58, width: 90, height: 34 }, { size: 74, bold: true }),
			],
			steps: [],
			feedbacks: [
				{
					feedbackId: 'any_calling',
					options: {},
					styleOverrides: [
						set('bg', 'color', PALETTE.call),
						...paint(PALETTE.callText, ['icon', 'time', 'title', 'caller']),
						set('title', 'text', 'CALLING'),
						...pulseOn(),
					],
				},
			],
		}),
	]

	// --- role detail page: everything about the selected role ------------------------------------------

	const sel = (field: string) => v(`sel_${field}`)
	const selTexts = ['name', 'state', 'device', 'type']
	const navTile = (
		id: string,
		name: string,
		glyph: string,
		caption: string,
		steps: Steps,
		notes: string,
		subline = sel('index'),
	) =>
		add(id, {
			name,
			keywords: ['detail', 'role', 'navigate'],
			notes,
			elements: [
				background(PALETTE.panel),
				text('icon', glyph, { x: 5, y: 6, width: 90, height: 52 }, { size: 100, color: PALETTE.info }),
				text('caption', caption, { x: 5, y: 60, width: 90, height: 18 }, { size: 85, bold: true }),
				text('index', subline, { x: 5, y: 80, width: 90, height: 12 }, { size: 85, color: PALETTE.muted }),
			],
			steps,
			feedbacks: [],
		})

	const detailIds = [
		navTile(
			'detail_back',
			'Role detail: back',
			'◀',
			'BACK',
			[{ down: [], up: [{ actionId: 'detail_back', options: {} }] }],
			'Switches this surface back to the page it came from (through the page trigger, see the module help).',
			'',
		),
		add('detail_header', {
			name: 'Role detail: role and device',
			keywords: ['detail', 'role', 'selected'],
			notes: 'The role shown on this page, its state and the device holding it.',
			elements: [
				background(),
				pulse(),
				text('name', sel('label'), { x: 5, y: 6, width: 90, height: 32 }, { size: 74, bold: true }),
				text('state', sel('state'), { x: 5, y: 40, width: 90, height: 20 }, { size: 78, color: PALETTE.ok }),
				text('device', sel('device'), { x: 5, y: 66, width: 90, height: 14 }, { size: 85, color: PALETTE.dim }),
				text('type', sel('type'), { x: 5, y: 81, width: 90, height: 12 }, { size: 85, color: PALETTE.muted }),
				{ ...ring('selected', PALETTE.info), enabled: true },
			],
			steps: [],
			feedbacks: roleStateFeedbacks(selected, selTexts),
		}),
		add('detail_battery', {
			name: 'Role detail: battery',
			keywords: ['detail', 'battery'],
			elements: [
				background(),
				ringGauge('ring', sel('battery'), sel('battery_known'), batteryStops),
				text('pct', sel('battery_text'), { x: 20, y: 28, width: 60, height: 30 }, { size: 90, bold: true }),
				text('time', sel('time_left'), { x: 22, y: 57, width: 56, height: 15 }, { size: 85, color: PALETTE.dim }),
				text('caption', 'BATTERY', { x: 18, y: 80, width: 64, height: 14 }, { size: 85, color: PALETTE.muted }),
			],
			steps: [],
			feedbacks: [
				{
					feedbackId: 'role_online',
					options: selected,
					isInverted: true,
					styleOverrides: [set('pct', 'text', '—'), ...paint(PALETTE.offText, ['pct', 'time', 'caption'])],
				},
				{
					feedbackId: 'role_battery_below',
					options: { ...selected, threshold: low },
					styleOverrides: paint(PALETTE.bad, ['pct']),
				},
			],
		}),
		add('detail_signal', {
			name: 'Role detail: RF signal (RSSI)',
			keywords: ['detail', 'rssi', 'signal', 'rf'],
			notes: `Signal bars from the RSSI: 3 bars from ${self.config.rssiGood}, 1 red bar below ${self.config.rssiPoor}.`,
			elements: [
				background(),
				signalMeter('sel', { x: 26, y: 10, width: 48, height: 40 }),
				text('value', sel('rssi'), { x: 5, y: 54, width: 90, height: 26 }, { size: 85, bold: true }),
				text('caption', 'RSSI', { x: 5, y: 81, width: 90, height: 13 }, { size: 85, color: PALETTE.muted }),
			],
			steps: [],
			feedbacks: [
				{
					feedbackId: 'role_online',
					options: selected,
					isInverted: true,
					styleOverrides: [set('value', 'text', 'NO RF'), ...paint(PALETTE.offText, ['value', 'caption'])],
				},
			],
		}),
		add('detail_link', {
			name: 'Role detail: link quality',
			keywords: ['detail', 'link', 'quality', 'rf'],
			elements: [
				background(),
				ringGauge('ring', sel('link'), sel('online'), [
					{ value: 0, color: PALETTE.bad, gradient: false },
					{ value: 30, color: PALETTE.call, gradient: false },
					{ value: 50, color: PALETTE.ok, gradient: false },
				]),
				text('pct', sel('link_text'), { x: 20, y: 28, width: 60, height: 30 }, { size: 90, bold: true }),
				text('fer', `FER ${sel('fer')}`, { x: 22, y: 57, width: 56, height: 15 }, { size: 85, color: PALETTE.dim }),
				text('caption', 'LINK', { x: 18, y: 80, width: 64, height: 14 }, { size: 85, color: PALETTE.muted }),
			],
			steps: [],
			feedbacks: [
				{
					feedbackId: 'role_online',
					options: selected,
					isInverted: true,
					styleOverrides: [
						set('pct', 'text', '—'),
						set('fer', 'text', ''),
						...paint(PALETTE.offText, ['pct', 'caption']),
					],
				},
			],
		}),
		add('detail_antenna', {
			name: 'Role detail: antenna and slot',
			keywords: ['detail', 'antenna', 'transceiver', 'slot'],
			elements: [
				background(),
				text('caption', 'ANTENNA', { x: 5, y: 8, width: 90, height: 14 }, { size: 85, color: PALETTE.muted }),
				text('name', sel('antenna_name'), { x: 5, y: 28, width: 90, height: 32 }, { size: 74, bold: true }),
				text('slot', `SLOT ${sel('slot')}`, { x: 5, y: 66, width: 90, height: 16 }, { size: 85, color: PALETTE.dim }),
			],
			steps: [],
			feedbacks: [
				{
					feedbackId: 'role_online',
					options: selected,
					isInverted: true,
					styleOverrides: [set('name', 'text', '—'), set('slot', 'text', ''), ...paint(PALETTE.offText, ['name'])],
				},
			],
		}),
		add('detail_device', {
			name: 'Role detail: device and firmware',
			keywords: ['detail', 'device', 'firmware', 'beltpack'],
			elements: [
				background(),
				text('caption', 'DEVICE', { x: 5, y: 8, width: 90, height: 14 }, { size: 85, color: PALETTE.muted }),
				text('name', sel('device'), { x: 5, y: 26, width: 90, height: 28 }, { size: 74, bold: true }),
				text('type', sel('type'), { x: 5, y: 58, width: 90, height: 16 }, { size: 85, color: PALETTE.dim }),
				text(
					'fw',
					sel('firmware'),
					{ x: 5, y: 77, width: 90, height: 13 },
					{
						size: 85,
						color: PALETTE.muted,
						mono: true,
					},
				),
			],
			steps: [],
			feedbacks: [],
		}),
		navTile(
			'detail_prev',
			'Role detail: previous role',
			'◀',
			'ROLE',
			[{ down: [], up: [{ actionId: 'select_step', options: { direction: 'prev' } }] }],
			'Shows the previous role in use on this page.',
		),
		navTile(
			'detail_next',
			'Role detail: next role',
			'▶',
			'ROLE',
			[{ down: [], up: [{ actionId: 'select_step', options: { direction: 'next' } }] }],
			'Shows the next role in use on this page.',
		),
		add('detail_call', {
			name: 'Role detail: hold to call',
			keywords: ['detail', 'call'],
			elements: [
				background(),
				pulse(),
				text('icon', '☎', { x: 0, y: -12, width: 100, height: 80 }, { size: 100, color: PALETTE.call }),
				text('name', sel('label'), { x: 5, y: 52, width: 90, height: 26 }, { size: 76, bold: true }),
				text('caption', 'HOLD TO CALL', { x: 5, y: 80, width: 90, height: 13 }, { size: 85, color: PALETTE.muted }),
			],
			steps: [
				{
					down: [{ actionId: 'call_role', options: { ...selected, mode: 'on', pulseMs: 2000, text: '' } }],
					up: [{ actionId: 'call_role', options: { ...selected, mode: 'off', pulseMs: 2000, text: '' } }],
				},
			],
			feedbacks: [
				{
					feedbackId: 'role_calling',
					options: selected,
					styleOverrides: [
						set('bg', 'color', PALETTE.call),
						...paint(PALETTE.callText, ['icon', 'name', 'caption']),
						set('caption', 'text', 'CALLING'),
						...pulseOn(),
					],
				},
			],
		}),
		add('detail_rmk', {
			name: 'Role detail: remote mic kill',
			keywords: ['detail', 'rmk', 'mic', 'kill'],
			elements: [
				background(PALETTE.rmk),
				micIcon('mic', { x: 30, y: 7, width: 40, height: 44 }, PALETTE.white, true, PALETTE.rmk),
				text('name', sel('label'), { x: 5, y: 55, width: 90, height: 24 }, { size: 78, bold: true }),
				text('caption', 'MIC KILL', { x: 5, y: 80, width: 90, height: 13 }, { size: 85, color: 0xf2a7ad }),
				ring('alert', PALETTE.white, 4),
			],
			steps: [{ down: [{ actionId: 'rmk_role', options: selected }], up: [] }],
			feedbacks: [
				{
					feedbackId: 'role_talking',
					options: { ...selected, key: 'any' },
					styleOverrides: [
						set('bg', 'color', PALETTE.rmkHot),
						set('micSlashBg', 'borderColor', PALETTE.rmkHot),
						set('caption', 'text', 'TALKING NOW'),
						set('caption', 'color', PALETTE.white),
						...show(['alert']),
						set('alert', 'opacity', expr('40 + oscillate(800) * 60')),
					],
				},
			],
		}),
		navTile(
			'detail_assign_prev',
			'Role detail: pick the previous role to assign',
			'◀',
			'PICK',
			[{ down: [], up: [{ actionId: 'assign_step', options: { direction: 'prev' } }] }],
			'Picks the previous role the device can take. Apply it with the "assign" button.',
			'',
		),
		add('detail_assign', {
			name: `Role detail: assign the picked role to the device (hold ${CONFIRM_HOLD_MS / 1000} s)`,
			keywords: ['detail', 'assign', 'change', 'role', 'edit'],
			notes:
				`Moves the device of the selected role to the role picked with ◀ / ▶. ` +
				`Hold ${CONFIRM_HOLD_MS / 1000} s to apply; the page then follows the device to its new role.`,
			elements: [
				background(),
				text('caption', 'ASSIGN ROLE', { x: 5, y: 8, width: 90, height: 14 }, { size: 85, color: PALETTE.muted }),
				text('name', sel('assign'), { x: 5, y: 28, width: 90, height: 32 }, { size: 74, bold: true }),
				text('hint', 'CURRENT', { x: 5, y: 70, width: 90, height: 14 }, { size: 85, color: PALETTE.muted }),
			],
			steps: [
				{
					down: [],
					up: [],
					[CONFIRM_HOLD_MS]: {
						options: { runWhileHeld: true },
						actions: [{ actionId: 'assign_apply', options: {} }],
					},
				},
			],
			feedbacks: [
				{
					feedbackId: 'assign_pending',
					options: {},
					styleOverrides: [
						set('bg', 'color', PALETTE.infoDeep),
						set('hint', 'text', `HOLD ${CONFIRM_HOLD_MS / 1000} S TO APPLY`),
						set('hint', 'color', PALETTE.info),
					],
				},
				{
					feedbackId: 'internal:buttonPushed',
					options: {},
					styleOverrides: [set('hint', 'text', 'KEEP HOLDING'), set('hint', 'color', PALETTE.white)],
				},
			],
		}),
		navTile(
			'detail_assign_next',
			'Role detail: pick the next role to assign',
			'▶',
			'PICK',
			[{ down: [], up: [{ actionId: 'assign_step', options: { direction: 'next' } }] }],
			'Picks the next role the device can take. Apply it with the "assign" button.',
			'',
		),
	]

	// one key template: Companion 5.1 generates a button per key number, and the number stays editable on
	// linked buttons
	const keyVar = (field: string) => v(`sel_key$(local:key)_${field}`)
	add('detail_key', {
		name: 'Role detail: key',
		keywords: ['detail', 'key', 'talk', 'listen'],
		notes: 'A key of the selected role: red = talking, green bar = listening. Change "key" to show another key.',
		localVariables: [{ variableType: 'simple', variableName: 'key', startupValue: 1 }],
		elements: [
			background(),
			...chip('key', keyVar('name'), { x: 6, y: 6, width: 22, height: 22 }, PALETTE.panel, PALETTE.dim),
			text('target', keyVar('label'), { x: 5, y: 33, width: 90, height: 34 }, { size: 74, bold: true }),
			text('role', sel('label'), { x: 5, y: 70, width: 90, height: 14 }, { size: 85, color: PALETTE.muted }),
			box('listen', { x: 0, y: 90, width: 100, height: 10 }, PALETTE.ok, { enabled: false }),
		],
		steps: [],
		feedbacks: [
			{
				feedbackId: 'selected_key_exists',
				options: { key: expr('$(local:key)') },
				isInverted: true,
				styleOverrides: [...show(['keyBg', 'keyText', 'role'], false), set('bg', 'color', PALETTE.offBg)],
			},
			{
				feedbackId: 'role_listening',
				options: { ...selected, key: expr('$(local:key) - 1') },
				styleOverrides: show(['listen']),
			},
			{
				feedbackId: 'role_talking',
				options: { ...selected, key: expr('$(local:key) - 1') },
				styleOverrides: [
					set('bg', 'color', PALETTE.talk),
					set('keyBg', 'color', PALETTE.talkDeep),
					...paint(PALETTE.white, ['target', 'role', 'keyText']),
				],
			},
		],
	})
	const maxKeys = Math.max(5, ...rolesInUse.map((r) => roleKeySlots(state, r, packsForRole(state, r.id)[0]).length))
	const detailKeys: Group = {
		id: 'detail_keys',
		type: 'template',
		name: 'Keys of the selected role',
		description: 'One button per key. On a linked button, change the "key" value to show another key.',
		presetId: 'detail_key',
		templateVariableName: 'key',
		templateValues: Array.from({ length: Math.min(DETAIL_KEYS, maxKeys) }, (_, i) => ({
			name: `Key ${i + 1}`,
			value: i + 1,
		})),
	}

	// --- structure ------------------------------------------------------------------------------------

	const keyTiles = (role: Role): string[] =>
		roleKeySlots(state, role, packsForRole(state, role.id)[0])
			// a key with nothing assigned cannot talk to anyone: no tile
			.filter((k) => k.isReply || k.target || !roleHasLayout(role))
			.map((k, i) => keyTile(role, k, i))
	const roleHasLayout = (role: Role) => Object.keys(role.keys).length > 0

	const sections: CompanionPresetSection<ModuleSchema>[] = [
		{
			id: 'crew',
			name: 'Crew',
			description:
				'One button per role: name, state, battery and signal meters. Press to open the role on the detail ' +
				`page, hold ${RMK_HOLD_MS / 1000} s for remote mic kill. Red = talking, amber = call, grey = offline.`,
			definitions: [
				...group('crew_in_use', 'Roles in use', rolesInUse.map(crewTile)),
				...group('crew_other', 'Other roles', otherRoles.map(crewTile), 'Roles no device holds at the moment'),
			],
		},
		{
			id: 'detail',
			name: 'Role detail',
			description:
				'A page about one role: press a role button to show it here. Place these on their own page, set that ' +
				'page in the connection settings and add the page trigger (see the module help) to switch automatically.',
			definitions: [
				...group('detail_page', 'Role, device, RF and actions', detailIds),
				...(detailKeys.templateValues.length ? [detailKeys] : []),
			],
		},
		{
			id: 'battery',
			name: 'Battery',
			description: `Battery ring per role on a wireless pack: red below ${low} %, amber below ${mid} %.`,
			definitions: group('battery_roles', 'Roles in use', rolesOnBattery.map(batteryTile)),
		},
		{
			id: 'keys',
			name: 'Key tally',
			description: 'Red while a role talks on that key, green bar while it listens. Keys show what they talk to.',
			definitions: rolesInUse.flatMap((role) => group(`keys_r${role.id}`, role.label, keyTiles(role))),
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
				? `Turn off the talk keys of one role (bright red while it talks). RMK ALL needs a ${CONFIRM_HOLD_MS / 1000} s hold.`
				: 'Turn off the talk keys of one role (bright red while it talks). To get an RMK ALL button, enable ' +
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
				'Per port: its current routing, then a switch for each channel with members (green = routed). ' +
				'For another channel, change it in the action and feedback of a switch.',
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
