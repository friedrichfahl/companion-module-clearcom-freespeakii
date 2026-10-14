/* eslint-disable n/no-unpublished-import, n/no-missing-import -- the simulator is a local dev tool */
// Presets are checked against the module's own definitions, in both device modes: every action, feedback,
// option value and variable a preset uses must exist, and every preset must be reachable from the structure.
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
	style?: unknown
	styleOverrides?: Override[]
	isInverted?: boolean
}
type Step = { down: PresetAction[]; up: PresetAction[]; [duration: string]: unknown }
type Element = { id: string; type: string; [prop: string]: unknown }
type Preset = {
	type: 'simple' | 'layered'
	name: string
	notes?: string
	style: { text: string; size: unknown }
	elements: Element[]
	steps: Step[]
	feedbacks: PresetFeedback[]
}
type Entry = Preset | { type: 'alternatives'; variants: Preset[] }
type Group = { id: string; presets: string[] }
type Section = { id: string; definitions: Group[] }

/** The variants of a preset entry (an alternatives group, or the preset itself). */
const variantsOf = (e: Entry): Preset[] => (e.type === 'alternatives' ? e.variants : [e])
/** One variant of a preset, by type. */
const variant = (h: Harness, id: string, type: 'simple' | 'layered'): Preset => {
	const found = variantsOf(h.presets[id] as Entry).find((p) => p.type === type)
	if (!found) throw new Error(`${id} has no ${type} variant`)
	return found
}
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
	const presets = h.presets as Record<string, Entry>
	const sections = h.presetStructure as Section[]

	const checkOptions = (where: string, def: Def | undefined, options: Record<string, unknown>) => {
		if (!def) return problems.push(`${where}: not defined`)
		const ids = new Set((def.options ?? []).map((o) => o.id))
		for (const key of Object.keys(options)) if (!ids.has(key)) problems.push(`${where}: unknown option ${key}`)
		for (const opt of def.options ?? []) {
			if (!(opt.id in options)) problems.push(`${where}: option ${opt.id} missing`)
			const value = options[opt.id]
			const valid = new Set((opt.choices ?? []).map((c) => c.id))
			if (opt.type === 'dropdown' && opt.choices && !valid.has(value))
				problems.push(`${where}: ${opt.id}=${JSON.stringify(value)} is not a choice`)
			if (opt.type === 'multidropdown' && opt.choices)
				for (const x of value as unknown[])
					if (!valid.has(x)) problems.push(`${where}: ${opt.id} has ${JSON.stringify(x)}`)
		}
		return undefined
	}

	const referenced = new Map<string, number>()
	for (const section of sections) {
		if (!section.definitions.length) problems.push(`section ${section.id} is empty`)
		for (const group of section.definitions) {
			if (!group.presets.length) problems.push(`group ${group.id} is empty`)
			for (const id of group.presets) referenced.set(id, (referenced.get(id) ?? 0) + 1)
		}
	}
	for (const [id, count] of referenced) {
		if (!presets[id]) problems.push(`structure references missing preset ${id}`)
		if (count > 1) problems.push(`preset ${id} is listed ${count} times`)
	}

	const checkVariables = (where: string, text: string) => {
		for (const m of text.matchAll(/\$\(([^:)]+):([^)]+)\)/g)) {
			if (m[1] !== 'cc') problems.push(`${where}: variable from another connection ${m[0]}`)
			else if (!h.variableDefs[m[2]]) problems.push(`${where}: unknown variable ${m[0]}`)
		}
	}

	for (const [id, entry] of Object.entries(presets)) {
		if (!referenced.has(id)) problems.push(`preset ${id} is not in the structure`)
		const variants = variantsOf(entry)
		if (entry.type === 'alternatives' && variants.at(-1)?.type !== 'simple')
			problems.push(`${id}: alternatives must end with a simple fallback`)
		for (const p of variants) {
			const where = `${id} (${p.type})`
			if (p.type === 'simple') {
				checkVariables(where, p.style.text)
				if (p.style.size !== 'auto') problems.push(`${where}: fixed text size ${String(p.style.size)}`)
			} else {
				const elements = new Map(p.elements.map((e) => [e.id, e]))
				if (elements.size !== p.elements.length) problems.push(`${where}: duplicate element ids`)
				for (const el of p.elements) {
					for (const [prop, raw] of Object.entries(el)) {
						if (raw && typeof raw === 'object' && 'isExpression' in raw) {
							const { isExpression, value } = raw as { isExpression: boolean; value: unknown }
							// keep expressions to a single variable, so they evaluate the same everywhere
							if (isExpression && !/^\$\(cc:[^)]+\)$/.test(String(value)))
								problems.push(`${where}: ${el.id}.${prop} expression is not a single variable: ${String(value)}`)
							checkVariables(`${where} ${el.id}.${prop}`, String(value))
						} else if (typeof raw === 'string') checkVariables(`${where} ${el.id}.${prop}`, raw)
					}
					if (el.type === 'text' && el.color === undefined)
						problems.push(`${where}: text ${el.id} has no colour (defaults to black)`)
					if (el.type === 'gauge' && !el.enabled)
						problems.push(`${where}: gauge ${el.id} is always shown, even without a battery level`)
				}
				for (const f of p.feedbacks) {
					for (const o of f.styleOverrides ?? []) {
						const el = elements.get(o.elementId)
						if (!el) problems.push(`${where}: feedback ${f.feedbackId} overrides missing element ${o.elementId}`)
						else if (!['color', 'enabled', 'opacity', 'text', 'value'].includes(o.elementProperty))
							problems.push(`${where}: unexpected override ${o.elementId}.${o.elementProperty}`)
					}
				}
			}
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
						if (a.actionId === 'rmk_all' && !when.startsWith('hold'))
							problems.push(`${where}: RMK all on a plain press`)
					}
				}
			}
			for (const f of p.feedbacks) {
				const def = h.feedbacks[f.feedbackId] as Def | undefined
				checkOptions(`${where} feedback ${f.feedbackId}`, def, f.options)
				const styled = p.type === 'simple' ? !!f.style : !!f.styleOverrides?.length
				if (def?.type === 'boolean' && !styled) problems.push(`${where}: boolean feedback ${f.feedbackId} has no style`)
			}
		}
	}
	return problems
}

const presetIds = (h: Harness) => Object.keys(h.presets)
const sectionIds = (h: Harness) => (h.presetStructure as Section[]).map((s) => s.id)

describe('presets', () => {
	it('are consistent with the definitions (Arcadia)', async () => {
		const h = await connect('arcadia')
		expect(lint(h)).toEqual([])
		expect(sectionIds(h)).toEqual([
			'crew',
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
		const crew = (h.presetStructure as Section[]).find((s) => s.id === 'crew')!
		const inUse = crew.definitions.find((g) => g.id === 'crew_in_use')!.presets
		expect(inUse).toHaveLength(18)
		expect(crew.definitions.find((g) => g.id === 'crew_other')!.presets).toHaveLength(27)
		expect(variant(h, 'crew_r35', 'simple').style.text).toBe('$(cc:r35_label)\n$(cc:r35_status)')
		const layered = variant(h, 'crew_r35', 'layered')
		expect(layered.elements.find((e) => e.id === 'name')?.text).toBe('$(cc:r35_label)')
		expect(h.variables.r35_status).toMatch(/^\d+%/)
	})

	it('offer RMK ALL only when enabled, and only as a 1 second hold', async () => {
		const off = await connect('arcadia')
		expect(off.presets.rmk_all).toBeUndefined()
		await h!.destroy()
		await sim!.close()
		const on = await connect('arcadia', { rmkAllEnabled: true })
		const step = (on.presets.rmk_all as Preset).steps[0]
		expect(step.down).toEqual([])
		expect(step['1000']).toEqual({ options: { runWhileHeld: true }, actions: [{ actionId: 'rmk_all', options: {} }] })
	})

	it('route every port to the channels it can actually use', async () => {
		const h = await connect('arcadia')
		const routing = (h.presetStructure as Section[]).find((s) => s.id === 'routing')!
		expect(routing.definitions.map((g) => g.id)).toEqual(['route_port1', 'route_port2', 'route_port3', 'route_port4'])
		// port 1 is on Production; the toggles cover the channels with members
		const port1 = routing.definitions[0].presets
		expect(port1[0]).toBe('route_port1_info')
		expect(port1.slice(1)).toEqual([
			'route_port1_ch1',
			'route_port1_ch2',
			'route_port1_ch3',
			'route_port1_ch4',
			'route_port1_ch5',
		])
		const toggle = h.presets.route_port3_ch2 as Preset
		expect(toggle.steps[0].down[0].options).toEqual({ port: 3, connection: 2, mode: 'toggle' })
		expect(h.variables.port1_channels).toBe('Production')
		expect(h.variables.port3_channels).toBe('Camera')
		expect(h.variables.port2_channels).toBe('none')
	})

	it('list roles by name in every section', async () => {
		const h = await connect('arcadia')
		const sections = h.presetStructure as Section[]
		const crew = sections.find((s) => s.id === 'crew')!.definitions
		// Audio, Camera 1, Camera 2, Director, Stage Manager; then Lighting, Spare
		expect(crew.find((g) => g.id === 'crew_in_use')!.presets).toEqual([
			'crew_r6',
			'crew_r2',
			'crew_r3',
			'crew_r1',
			'crew_r4',
		])
		expect(crew.find((g) => g.id === 'crew_other')!.presets).toEqual(['crew_r5', 'crew_r7'])
		expect(sections.find((s) => s.id === 'keys')!.definitions.map((g) => g.id)).toEqual([
			'keys_r6',
			'keys_r2',
			'keys_r3',
			'keys_r1',
			'keys_r4',
		])
	})

	it('label key tally buttons with what each key talks to, and skip unassigned keys', async () => {
		const h = await connect('arcadia')
		const keys = (h.presetStructure as Section[]).find((s) => s.id === 'keys')!.definitions
		const texts = (groupId: string) =>
			keys.find((g) => g.id === groupId)!.presets.map((id) => (h.presets[id] as Preset).style.text.split('\n')[1])
		// FreeSpeak II pack: keys A-D on channels, then the reply key
		expect(texts('keys_r1')).toEqual([
			'on $(cc:ch1_label)',
			'on $(cc:ch2_label)',
			'on $(cc:ch3_label)',
			'on $(cc:ch4_label)',
			'Reply',
		])
		// FreeSpeak Edge pack: 9 keys, only 2 assigned, plus reply
		expect(texts('keys_r2')).toEqual(['on $(cc:ch2_label)', 'on $(cc:ch1_label)', 'Reply'])
		// HelixNet station: a direct key to the Director role
		expect(texts('keys_r6')).toEqual([
			'on $(cc:ch5_label)',
			'on $(cc:ch1_label)',
			'on $(cc:ch3_label)',
			'on $(cc:ch2_label)',
			'to $(cc:r1_label)',
		])
		const reply = h.presets[keys.find((g) => g.id === 'keys_r1')!.presets[4]] as Preset
		expect(reply.feedbacks.find((f) => f.feedbackId === 'role_talking')?.options.key).toBe('reply')
		// the reply tile lights up when the reply key talks
		sim!.setTalk(2001, 4, true)
		await waitFor(() => h.feedback('role_talking', reply.feedbacks[1].options), 'reply key tally')
	})

	it('expect only the roles that are online in the crew check', async () => {
		const h = await connect('fsii')
		const check = (h.presets.status_crew as Preset).feedbacks[0]
		expect(check.options.roles).toHaveLength(11) // 18 roles in use, 11 of them online
		expect(h.feedback('any_role_missing', check.options)).toBe(false)
	})

	it('draw battery meters only for roles on a battery, driven by the battery variables', async () => {
		const h = await connect('arcadia', { lowBattery: 25 })
		const battery = (h.presetStructure as Section[]).find((s) => s.id === 'battery')!
		// the two FreeSpeak Edge packs and Director (FreeSpeak II), by name; not the HelixNet pack or station
		expect(battery.definitions[0].presets).toEqual(['battery_r2', 'battery_r3', 'battery_r1'])

		const bar = variant(h, 'crew_r1', 'layered').elements.find((e) => e.id === 'bar')!
		expect(bar).toMatchObject({
			type: 'gauge',
			orientation: 'horizontal',
			value: { isExpression: true, value: '$(cc:r1_battery)' },
			enabled: { isExpression: true, value: '$(cc:r1_battery_known)' },
			min: 0,
			max: 100,
			multiColour: false,
		})
		// red below the configured low battery threshold, amber below 50 %, green above
		expect(bar.stops).toEqual([
			{ value: 0, color: 0xc80000, gradient: false },
			{ value: 25, color: 0xffaa00, gradient: false },
			{ value: 50, color: 0x009600, gradient: false },
		])
		const ring = variant(h, 'battery_r2', 'layered').elements.find((e) => e.id === 'ring')!
		expect(ring).toMatchObject({ type: 'gauge', orientation: 'ring', startAngle: 225, endAngle: 135 })

		expect(h.variables).toMatchObject({
			r1_battery: 82,
			r1_battery_known: true,
			r1_battery_text: '82%',
			r4_battery_known: false, // wired HelixNet beltpack: no gauge
			r4_battery_text: '',
		})
		sim!.setOnline(2001, false)
		await waitFor(() => h.variables.r1_battery_known === false, 'gauge hidden while offline')
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
		const tile = variant(h, 'crew_r1', 'layered')
		// the feedbacks that currently apply to the button (Companion inverts the result when isInverted is set)
		const active = () =>
			tile.feedbacks
				.filter((f) => (h.feedback(f.feedbackId, f.options) === true) !== !!f.isInverted)
				.map((f) => f.feedbackId)
		expect(active()).toEqual([])
		expect(h.variables.r1_status).toBe('82%')
		sim!.setTalk(2001, 1, true)
		await waitFor(() => h.variables.r1_status === '82%  TALK 2', 'status shows talk')
		expect(active()).toEqual(['role_talking'])
		sim!.setOnline(2001, false)
		await waitFor(() => h.variables.r1_status === 'OFFLINE', 'status offline')
		expect(active()).toEqual(['role_online'])
		expect(h.variables.r7_status).toBe('no device')
	})
})
