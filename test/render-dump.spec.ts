/* eslint-disable n/no-unpublished-import, n/no-missing-import -- the simulator is a local dev tool */
// Dev tool, skipped unless RENDER_DUMP is set: runs the module against the simulator in a few live situations and
// writes the presets, variable values and the result of every feedback to a JSON file. A renderer built from
// Companion's own graphics code turns that into contact sheets, to check the presets by eye:
//   RENDER_DUMP=/tmp/presets.json npx vitest run test/render-dump.spec.ts
import { writeFileSync } from 'node:fs'
import { describe, it } from 'vitest'
import { createSimulator, type Simulator } from '../tools/simulator/simulator.mjs'
import { Harness, sleep, waitFor } from './harness.js'

type Feedback = { feedbackId: string; options: Record<string, unknown> }
type Preset = {
	type: string
	feedbacks: Feedback[]
	localVariables?: { variableName: string; startupValue: unknown }[]
}
type Group = { id: string; type: string; presets?: string[]; presetId?: string; templateValues?: { value: unknown }[] }
type Section = { id: string; definitions: Group[] }
interface Entry {
	id: string
	caption: string
	active: boolean[]
	pushed: boolean
	local: Record<string, unknown>
}

/** Evaluate a preset option that is an expression over local variables (`$(local:key)`, `$(local:key) - 1`). */
function resolveOption(value: unknown, local: Record<string, unknown>): unknown {
	if (!value || typeof value !== 'object' || !('isExpression' in value)) return value
	const src = String((value as unknown as { value: unknown }).value).replace(/\$\(local:(\w+)\)/g, (_, n: string) =>
		String(local[n]),
	)
	const m = /^\s*(-?\d+)\s*(?:([+-])\s*(\d+))?\s*$/.exec(src)
	if (!m) throw new Error(`Cannot evaluate ${src}`)
	return Number(m[1]) + (m[2] ? (m[2] === '+' ? 1 : -1) * Number(m[3]) : 0)
}

function scene(
	h: Harness,
	name: string,
	pushed: string[] = [],
): { name: string; variables: unknown; presets: Entry[] } {
	const presets: Entry[] = []
	const entry = (id: string, caption: string, local: Record<string, unknown>) => {
		const p = h.presets[id] as Preset
		presets.push({
			id,
			caption,
			pushed: pushed.includes(id),
			local,
			active: p.feedbacks.map((f) => {
				if (f.feedbackId.startsWith('internal:')) return false
				const options = Object.fromEntries(Object.entries(f.options).map(([k, v]) => [k, resolveOption(v, local)]))
				return h.feedback(f.feedbackId, options) === true
			}),
		})
	}
	for (const section of h.presetStructure as Section[]) {
		for (const g of section.definitions) {
			if (g.type === 'template') {
				for (const t of g.templateValues ?? []) entry(g.presetId!, `${g.presetId} ${String(t.value)}`, { key: t.value })
			} else for (const id of g.presets ?? []) entry(id, id, {})
		}
	}
	return { name, variables: { ...h.variables }, presets }
}

describe.runIf(!!process.env.RENDER_DUMP)('render dump', () => {
	it('dumps presets in live situations', async () => {
		const out: Record<string, unknown> = { label: 'cc', connectionId: 'conn1', size: 144, cols: 8, scenes: [] }
		const scenes = out.scenes as unknown[]
		let sim: Simulator | undefined
		let h: Harness | undefined
		try {
			sim = await createSimulator({ mode: 'arcadia', password: 'pw', activity: false })
			h = new Harness('cc')
			await h.init({ deviceType: 'arcadia', host: sim.host, rmkAllEnabled: true, lowBattery: 20 }, { password: 'pw' })
			await waitFor(() => h!.status?.status === 'ok', 'connected')
			await sleep(700)
			out.presets = h.presets
			out.structure = h.presetStructure
			out.compositeElements = h.compositeElements
			scenes.push(scene(h, 'arcadia-idle'))

			await h.action('select_role', { role: 1, open: true })
			sim.setTalk(2001, 0, true)
			sim.setCall(2002, true)
			sim.setOnline(2004, false)
			sim.setGpi(1, true)
			sim.setGpo(3, true)
			await sleep(800)
			out.presets = h.presets
			out.structure = h.presetStructure
			scenes.push(scene(h, 'arcadia-live', ['crew_r3', 'rmk_all', 'portcall_port4']))

			await h.action('assign_step', { direction: 'next' })
			await sleep(300)
			scenes.push(scene(h, 'arcadia-assign'))
		} finally {
			await h?.destroy()
			await sim?.close()
		}

		try {
			sim = await createSimulator({ mode: 'fsii', activity: false })
			h = new Harness('cc')
			await h.init({ deviceType: 'fsii', host: sim.host })
			await waitFor(() => h!.status?.status === 'ok', 'connected')
			await sleep(700)
			const roles = Object.keys(h.presets).filter((id) => id.startsWith('crew_r'))
			await h.action('select_role', { role: Number(roles[0].slice(6)), open: false })
			await sleep(300)
			const fsii = scene(h, 'fsii')
			// FSII has other preset ids: keep them apart from the Arcadia ones
			out.presetsFsii = h.presets
			scenes.push({ ...fsii, presetsKey: 'presetsFsii' })
		} finally {
			await h?.destroy()
			await sim?.close()
		}
		writeFileSync(process.env.RENDER_DUMP!, JSON.stringify(out))
	})
})
