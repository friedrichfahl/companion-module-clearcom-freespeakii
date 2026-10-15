/* eslint-disable n/no-unpublished-import, n/no-missing-import -- the simulator is a local dev tool */
// Presets are checked against the module's own definitions, in both device modes: every action, feedback,
// option value, variable, element and composite element a preset uses must exist, and every preset must be
// reachable from the structure.
import { afterEach, describe, expect, it } from 'vitest'
import { createSimulator, type Simulator } from '../tools/simulator/simulator.mjs'
import { Harness, waitFor } from './harness.js'

type Opt = { id: string; type: string; choices?: { id: unknown }[] }
type Def = { options?: Opt[]; type?: string }
type PresetAction = { actionId: string; options: Record<string, unknown> }
type Override = { elementId: string; elementProperty: string; override: unknown }
type PresetFeedback = {
	feedbackId: string
	options: Record<string, unknown>
	styleOverrides?: Override[]
	isInverted?: boolean
}
type Step = { down: PresetAction[]; up: PresetAction[]; [duration: string]: unknown }
type Element = { id: string; type: string; children?: Element[]; [prop: string]: unknown }
type Preset = {
	type: 'layered' | 'simple'
	name: string
	notes?: string
	elements: Element[]
	steps: Step[]
	feedbacks: PresetFeedback[]
	localVariables?: { variableName: string; startupValue: unknown }[]
}
type Group =
	| { id: string; type: 'simple'; presets: string[] }
	| {
			id: string
			type: 'template'
			presetId: string
			templateVariableName: string
			templateValues: { value: unknown; name?: string }[]
	  }
type Section = { id: string; definitions: Group[] }
type Composite = { options: Opt[]; elements: Element[] }

const isExpr = (v: unknown): v is { isExpression: true; value: string } =>
	!!v && typeof v === 'object' && (v as { isExpression?: unknown }).isExpression === true

/** Every string and expression in a property value (nested in composite options and gauge stops too). */
const strings = (raw: unknown): string[] =>
	isExpr(raw)
		? [raw.value]
		: typeof raw === 'string'
			? [raw]
			: raw && typeof raw === 'object'
				? Object.values(raw).flatMap(strings)
				: []

/** All elements of a preset, including the children of groups. */
const flatten = (elements: Element[]): Element[] => elements.flatMap((e) => [e, ...flatten(e.children ?? [])])
const element = (p: Preset, id: string) => flatten(p.elements).find((e) => e.id === id)
const preset = (h: Harness, id: string) => h.presets[id] as Preset

let sim: Simulator | undefined
let h: Harness | undefined
afterEach(async () => {
	await h?.destroy()
	await sim?.close()
	h = sim = undefined
})

async function connect(mode: 'arcadia' | 'fsii', extra: Record<string, unknown> = {}): Promise<Harness> {
	sim = await createSimulator({ mode, password: 'pw' })
	h = new Harness('cc')
	await h.init({ deviceType: mode, host: sim.host, ...extra }, { password: 'pw' })
	await waitFor(() => h!.status?.status === 'ok', 'connected')
	return h
}

/** Every problem found in the preset definitions, as readable strings. */
function lint(h: Harness): string[] {
	const problems: string[] = []
	const presets = h.presets as Record<string, Preset>
	const sections = h.presetStructure as Section[]
	const composites = h.compositeElements as Record<string, Composite>

	const checkOptions = (where: string, def: Def | undefined, options: Record<string, unknown>) => {
		if (!def) return problems.push(`${where}: not defined`)
		const ids = new Set((def.options ?? []).map((o) => o.id))
		for (const key of Object.keys(options)) if (!ids.has(key)) problems.push(`${where}: unknown option ${key}`)
		for (const opt of def.options ?? []) {
			if (!(opt.id in options)) problems.push(`${where}: option ${opt.id} missing`)
			const value = options[opt.id]
			if (isExpr(value)) continue // evaluated by Companion; its variables are checked below
			const valid = new Set((opt.choices ?? []).map((c) => c.id))
			if (opt.type === 'dropdown' && opt.choices && !valid.has(value))
				problems.push(`${where}: ${opt.id}=${JSON.stringify(value)} is not a choice`)
			if (opt.type === 'multidropdown' && opt.choices)
				for (const x of value as unknown[])
					if (!valid.has(x)) problems.push(`${where}: ${opt.id} has ${JSON.stringify(x)}`)
		}
		return undefined
	}

	// templates: the values a preset's local variables take
	const localValues = new Map<string, Record<string, unknown>[]>()
	const referenced = new Map<string, number>()
	for (const section of sections) {
		if (!section.definitions.length) problems.push(`section ${section.id} is empty`)
		for (const group of section.definitions) {
			const ids = group.type === 'template' ? [group.presetId] : group.presets
			if (!ids.length) problems.push(`group ${group.id} is empty`)
			for (const id of ids) referenced.set(id, (referenced.get(id) ?? 0) + 1)
			if (group.type === 'template') {
				const p = presets[group.presetId]
				if (!p?.localVariables?.some((l) => l.variableName === group.templateVariableName))
					problems.push(`template ${group.id}: ${group.presetId} has no local variable ${group.templateVariableName}`)
				if (!group.templateValues.length) problems.push(`template ${group.id} has no values`)
				localValues.set(
					group.presetId,
					group.templateValues.map((t) => ({ [group.templateVariableName]: t.value })),
				)
			}
		}
	}
	for (const [id, count] of referenced) {
		if (!presets[id]) problems.push(`structure references missing preset ${id}`)
		if (count > 1) problems.push(`preset ${id} is listed ${count} times`)
	}

	/** Check the variables in a string or expression, with the local variables of each template value filled in. */
	const checkVariables = (where: string, text: string, locals: Record<string, unknown>[], allowOptions = false) => {
		for (const local of locals) {
			const filled = text.replace(/\$\(local:(\w+)\)/g, (m, name: string) => {
				if (!(name in local)) problems.push(`${where}: unknown local variable ${m}`)
				return String(local[name])
			})
			for (const m of filled.matchAll(/\$\(([^:)$]+):([^)$]+)\)/g)) {
				if (m[1] === 'options' && allowOptions) continue
				if (m[1] !== 'cc') problems.push(`${where}: variable from another connection ${m[0]}`)
				else if (!h.variableDefs[m[2]]) problems.push(`${where}: unknown variable ${m[0]}`)
			}
		}
	}
	const checkElements = (
		where: string,
		elements: Element[],
		locals: Record<string, unknown>[],
		inComposite: boolean,
	) => {
		const all = flatten(elements)
		if (new Set(all.map((e) => e.id)).size !== all.length) problems.push(`${where}: duplicate element ids`)
		for (const el of all) {
			for (const [prop, raw] of Object.entries(el)) {
				if (prop === 'children') continue
				for (const t of strings(raw)) checkVariables(`${where} ${el.id}.${prop}`, t, locals, inComposite)
				if (!inComposite && isExpr(raw) && raw.value.includes('$(options:'))
					problems.push(`${where}: ${el.id}.${prop} uses composite options outside a composite`)
			}
			if (el.type === 'text' && el.color === undefined)
				problems.push(`${where}: text ${el.id} has no colour (defaults to black)`)
			if (el.type === 'composite') {
				const def = composites[el.elementId as string]
				if (!def) problems.push(`${where}: unknown composite element ${String(el.elementId)}`)
				else
					for (const key of Object.keys(el.options as object))
						if (!def.options.some((o) => o.id === key)) problems.push(`${where}: ${el.id} has unknown option ${key}`)
			}
			if (!inComposite && (el.type === 'gauge' || el.type === 'composite') && el.id !== 'battery' && !el.enabled)
				problems.push(`${where}: meter ${el.id} is always shown, even without a level`)
		}
		return all
	}

	for (const [id, def] of Object.entries(composites)) checkElements(`composite ${id}`, def.elements, [{}], true)

	for (const [id, p] of Object.entries(presets)) {
		const where = `${id} (${p.type})`
		if (!referenced.has(id)) problems.push(`preset ${id} is not in the structure`)
		if (p.type !== 'layered') problems.push(`${where}: not a layered preset`)
		const locals = localValues.get(id) ?? [
			Object.fromEntries((p.localVariables ?? []).map((l) => [l.variableName, l.startupValue])),
		]
		const all = checkElements(where, p.elements, locals, false)
		const byId = new Map(all.map((e) => [e.id, e]))
		if (p.elements[0]?.id !== 'bg') problems.push(`${where}: does not start with the background`)

		for (const step of p.steps) {
			const groups: [string, PresetAction[]][] = [
				['down', step.down],
				['up', step.up],
			]
			for (const [key, val] of Object.entries(step)) {
				if (/^\d+$/.test(key)) groups.push([`hold ${key}`, (val as { actions: PresetAction[] }).actions])
			}
			for (const [when, actions] of groups) {
				for (const a of actions) {
					checkOptions(`${where} ${when} ${a.actionId}`, h.actions[a.actionId] as Def | undefined, a.options)
					if (a.actionId === 'rmk_all' && !when.startsWith('hold')) problems.push(`${where}: RMK all on a plain press`)
				}
			}
		}
		for (const f of p.feedbacks) {
			for (const o of f.styleOverrides ?? []) {
				const el = byId.get(o.elementId)
				const composite = el?.type === 'composite' && o.elementProperty.startsWith('opt:')
				if (!el) problems.push(`${where}: feedback ${f.feedbackId} overrides missing element ${o.elementId}`)
				else if (
					!composite &&
					!['color', 'enabled', 'opacity', 'text', 'value', 'x', 'borderColor'].includes(o.elementProperty)
				)
					problems.push(`${where}: unexpected override ${o.elementId}.${o.elementProperty}`)
				if (isExpr(o.override)) checkVariables(`${where} override ${o.elementId}`, o.override.value, locals)
			}
			if (!f.styleOverrides?.length) problems.push(`${where}: feedback ${f.feedbackId} has no style`)
			if (f.feedbackId.startsWith('internal:')) continue
			checkOptions(`${where} feedback ${f.feedbackId}`, h.feedbacks[f.feedbackId] as Def | undefined, f.options)
			for (const value of Object.values(f.options))
				if (isExpr(value)) checkVariables(`${where} feedback ${f.feedbackId}`, value.value, locals)
		}
	}
	return problems
}

const presetIds = (h: Harness) => Object.keys(h.presets)
const sectionIds = (h: Harness) => (h.presetStructure as Section[]).map((s) => s.id)
const groupPresets = (h: Harness, section: string, group: string): string[] => {
	const g = (h.presetStructure as Section[]).find((s) => s.id === section)?.definitions.find((d) => d.id === group)
	return g?.type === 'simple' ? g.presets : []
}

describe('presets', () => {
	it('are consistent with the definitions (Arcadia)', async () => {
		const h = await connect('arcadia', { rmkAllEnabled: true })
		expect(lint(h)).toEqual([])
		expect(sectionIds(h)).toEqual([
			'crew',
			'detail',
			'battery',
			'keys',
			'channels',
			'micKill',
			'routing',
			'portCall',
			'gpio',
			'status',
		])
	})

	it('are consistent with the definitions (FreeSpeak II)', async () => {
		const h = await connect('fsii', { rmkAllEnabled: true })
		expect(lint(h)).toEqual([])
		// FSII has no GPI trigger
		expect(presetIds(h).some((id) => id.startsWith('gpitrigger_'))).toBe(false)
	})

	it('group roles in use apart from unused ones, and label buttons through variables', async () => {
		const h = await connect('fsii')
		expect(groupPresets(h, 'crew', 'crew_in_use')).toHaveLength(18)
		expect(groupPresets(h, 'crew', 'crew_other')).toHaveLength(27)
		const tile = preset(h, 'crew_r35')
		expect(element(tile, 'name')?.text).toBe('$(cc:r35_label)')
		expect(element(tile, 'state')?.text).toBe('$(cc:r35_state)')
		expect(h.variables.r35_status).toMatch(/^\d+%/)
		expect(h.variables.r35_state).toBe('ONLINE')
	})

	it('open a role on a short press and send RMK on a long press, without calling', async () => {
		const h = await connect('arcadia')
		const [step] = preset(h, 'crew_r1').steps
		expect(step.down).toEqual([])
		expect(step.up).toEqual([{ actionId: 'select_role', options: { role: 1, open: true } }])
		expect(step['800']).toEqual({
			options: { runWhileHeld: true },
			actions: [{ actionId: 'rmk_role', options: { targets: ['r:1'], names: '' } }],
		})
		expect(JSON.stringify(preset(h, 'crew_r1').steps)).not.toContain('call_role')
		// while the button is held it says what the hold does
		const hint = preset(h, 'crew_r1').feedbacks.find((f) => f.feedbackId === 'internal:buttonPushed')
		expect(hint?.styleOverrides?.map((o) => o.elementId)).toEqual(['holdBg', 'holdText'])
	})

	it('offer RMK ALL only when enabled, and only as a 1 second hold', async () => {
		const off = await connect('arcadia')
		expect(off.presets.rmk_all).toBeUndefined()
		await h!.destroy()
		await sim!.close()
		const on = await connect('arcadia', { rmkAllEnabled: true })
		const step = preset(on, 'rmk_all').steps[0]
		expect(step.down).toEqual([])
		expect(step['1000']).toEqual({ options: { runWhileHeld: true }, actions: [{ actionId: 'rmk_all', options: {} }] })
	})

	it('route every port to the channels it can actually use', async () => {
		const h = await connect('arcadia')
		const routing = (h.presetStructure as Section[]).find((s) => s.id === 'routing')!
		expect(routing.definitions.map((g) => g.id)).toEqual(['route_port1', 'route_port2', 'route_port3', 'route_port4'])
		// port 1 is on Production; the switches cover the channels with members
		expect(groupPresets(h, 'routing', 'route_port1')).toEqual([
			'route_port1_info',
			'route_port1_ch1',
			'route_port1_ch2',
			'route_port1_ch3',
			'route_port1_ch4',
			'route_port1_ch5',
		])
		const toggle = preset(h, 'route_port3_ch2')
		expect(toggle.steps[0].down[0].options).toEqual({ port: 3, connection: 2, mode: 'toggle' })
		// the switch knob moves right and turns green while routed
		const on = toggle.feedbacks[0].styleOverrides!
		expect(on).toContainEqual({ elementId: 'switchTrack', elementProperty: 'color', override: 0x2ec36a })
		expect(on.find((o) => o.elementProperty === 'x')?.elementId).toBe('switchKnob')
		expect(h.variables.port1_channels).toBe('Production')
		expect(h.variables.port3_channels).toBe('Camera')
		expect(h.variables.port2_channels).toBe('none')
	})

	it('list roles by name in every section', async () => {
		const h = await connect('arcadia')
		// Audio, Camera 1, Camera 2, Director, Stage Manager; then Lighting, Spare
		expect(groupPresets(h, 'crew', 'crew_in_use')).toEqual(['crew_r6', 'crew_r2', 'crew_r3', 'crew_r1', 'crew_r4'])
		expect(groupPresets(h, 'crew', 'crew_other')).toEqual(['crew_r5', 'crew_r7'])
		expect((h.presetStructure as Section[]).find((s) => s.id === 'keys')!.definitions.map((g) => g.id)).toEqual([
			'keys_r6',
			'keys_r2',
			'keys_r3',
			'keys_r1',
			'keys_r4',
		])
	})

	it('label key tally buttons with what each key talks to, and skip unassigned keys', async () => {
		const h = await connect('arcadia')
		const labels = (group: string) =>
			groupPresets(h, 'keys', group).map((id) => [
				element(preset(h, id), 'keyText')?.text,
				element(preset(h, id), 'target')?.text,
				element(preset(h, id), 'kind')?.text,
			])
		// FreeSpeak II pack: keys A-D on channels, then the reply key
		expect(labels('keys_r1')).toEqual([
			['A', '$(cc:ch1_label)', 'CHANNEL'],
			['B', '$(cc:ch2_label)', 'CHANNEL'],
			['C', '$(cc:ch3_label)', 'CHANNEL'],
			['D', '$(cc:ch4_label)', 'CHANNEL'],
			['R', 'Reply', 'REPLY'],
		])
		// FreeSpeak Edge pack: 9 keys, only 2 assigned, plus reply
		expect(labels('keys_r2')).toEqual([
			['1', '$(cc:ch2_label)', 'CHANNEL'],
			['2', '$(cc:ch1_label)', 'CHANNEL'],
			['R', 'Reply', 'REPLY'],
		])
		// HelixNet station: a direct key to the Director role
		expect(labels('keys_r6').at(-1)).toEqual(['5', '$(cc:r1_label)', 'DIRECT'])
		const reply = preset(h, groupPresets(h, 'keys', 'keys_r1')[4])
		const talking = reply.feedbacks.find((f) => f.feedbackId === 'role_talking')!
		expect(talking.options.key).toBe('reply')
		// the reply tile lights up when the reply key talks, and shows the listen bar while it listens
		expect(h.feedback('role_listening', reply.feedbacks[1].options)).toBe(true)
		sim!.setTalk(2001, 4, true)
		await waitFor(() => h.feedback('role_talking', talking.options), 'reply key tally')
	})

	it('expect only the roles that are online in the crew check', async () => {
		const h = await connect('fsii')
		const check = preset(h, 'status_crew').feedbacks[0]
		expect(check.options.roles).toHaveLength(11) // 18 roles in use, 11 of them online
		expect(h.feedback('any_role_missing', check.options)).toBe(false)
	})

	it('draw battery and signal meters only for roles that report them', async () => {
		const h = await connect('arcadia', { lowBattery: 25, rssiGood: 50, rssiPoor: 30 })
		expect(groupPresets(h, 'battery', 'battery_roles')).toEqual(['battery_r2', 'battery_r3', 'battery_r1'])

		const tile = preset(h, 'crew_r1')
		expect(element(tile, 'battery')).toMatchObject({
			type: 'composite',
			elementId: 'battery',
			enabled: { isExpression: true, value: '$(cc:r1_battery_known)' },
			options: { level: { isExpression: true, value: '$(cc:r1_battery)' }, low: 25, mid: 50 },
		})
		expect(element(tile, 'signal')).toMatchObject({
			type: 'composite',
			elementId: 'signal',
			enabled: { isExpression: true, value: '$(cc:r1_rssi_known)' },
			options: { bars: { isExpression: true, value: '$(cc:r1_signal)' } },
		})
		const ring = element(preset(h, 'battery_r2'), 'ring')!
		expect(ring).toMatchObject({ type: 'gauge', orientation: 'ring', startAngle: 225, endAngle: 135 })
		// red below the configured low battery threshold, amber below 50 %, green above
		expect(ring.stops).toEqual([
			{ value: 0, color: 0xe8453c, gradient: false },
			{ value: 25, color: 0xffb000, gradient: false },
			{ value: 50, color: 0x2ec36a, gradient: false },
		])

		expect(h.variables).toMatchObject({
			r1_battery: 82,
			r1_battery_known: true,
			r1_battery_text: '82%',
			r1_rssi: 60,
			r1_rssi_known: true,
			r1_signal: 4, // 60 >= 50 + 10
			r3_signal: 3, // 55 >= 50
			r2_signal: 2, // 40 >= 30
			r4_battery_known: false, // wired HelixNet beltpack: no meters
			r4_rssi_known: false,
			r4_signal: 0,
			r4_battery_text: '',
		})
		sim!.setOnline(2001, false)
		await waitFor(() => h.variables.r1_battery_known === false && h.variables.r1_rssi_known === false, 'meters hidden')
	})

	it('only offer port call where the device supports it', async () => {
		const a = await connect('arcadia')
		expect(presetIds(a).filter((id) => id.startsWith('portcall_'))).toEqual(['portcall_port4']) // the 4WG port
		await h!.destroy()
		await sim!.close()
		const f = await connect('fsii')
		expect(presetIds(f).filter((id) => id.startsWith('portcall_'))).toHaveLength(8) // 2W and 4W ports, not PGM/SA/HS
	})

	it('show live state on the crew tile', async () => {
		const h = await connect('arcadia')
		const tile = preset(h, 'crew_r1')
		// the feedbacks that currently apply to the button (Companion inverts the result when isInverted is set)
		const active = () =>
			tile.feedbacks
				.filter((f) => !f.feedbackId.startsWith('internal:'))
				.filter((f) => (h.feedback(f.feedbackId, f.options) === true) !== !!f.isInverted)
				.map((f) => f.feedbackId)
		expect(active()).toEqual([])
		expect(h.variables.r1_status).toBe('82%')
		expect(h.variables.r1_state).toBe('ONLINE')
		await h.action('select_role', { role: 1, open: false })
		await waitFor(() => active().includes('role_selected'), 'selection ring')
		sim!.setTalk(2001, 1, true)
		await waitFor(() => h.variables.r1_status === '82%  TALK 2', 'status shows talk')
		expect(h.variables.r1_state).toBe('TALK 2')
		expect(active()).toEqual(['role_talking', 'role_selected'])
		sim!.setOnline(2001, false)
		await waitFor(() => h.variables.r1_status === 'OFFLINE', 'status offline')
		expect(active()).toEqual(['role_online', 'role_selected'])
		expect(h.variables.r7_status).toBe('no device')
		expect(h.variables.r7_state).toBe('NO DEVICE')
	})

	it('build the role detail page around the selected role', async () => {
		const h = await connect('arcadia')
		expect(groupPresets(h, 'detail', 'detail_page')).toEqual([
			'detail_back',
			'detail_header',
			'detail_battery',
			'detail_signal',
			'detail_link',
			'detail_antenna',
			'detail_device',
			'detail_prev',
			'detail_next',
			'detail_call',
			'detail_rmk',
			'detail_assign_prev',
			'detail_assign',
			'detail_assign_next',
		])
		// one key template, a button per key up to the most keys a role in use has (FreeSpeak Edge: 9)
		const keys = (h.presetStructure as Section[]).find((s) => s.id === 'detail')!.definitions[1]
		expect(keys).toMatchObject({ type: 'template', presetId: 'detail_key', templateVariableName: 'key' })
		expect(keys.type === 'template' && keys.templateValues.map((t) => t.value)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
		expect(element(preset(h, 'detail_key'), 'target')?.text).toBe('$(cc:sel_key$(local:key)_label)')

		// the detail buttons act on whoever holds the selected role
		const call = preset(h, 'detail_call').steps[0]
		expect(call.down[0]).toEqual({
			actionId: 'call_role',
			options: { targets: ['sel'], names: '', mode: 'on', pulseMs: 2000, text: '' },
		})
		expect(call.up[0].options.mode).toBe('off')
		expect(preset(h, 'detail_rmk').steps[0].down[0]).toEqual({
			actionId: 'rmk_role',
			options: { targets: ['sel'], names: '' },
		})
		// applying a new role needs a deliberate hold
		expect(preset(h, 'detail_assign').steps[0]['1000']).toEqual({
			options: { runWhileHeld: true },
			actions: [{ actionId: 'assign_apply', options: {} }],
		})
	})
})
