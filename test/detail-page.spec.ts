/* eslint-disable n/no-unpublished-import, n/no-missing-import -- the simulator is a local dev tool */
// The role detail page: selecting a role, asking Companion to switch pages, the sel_* variables, actions on the
// selected role and assigning another role to its device.
import { afterEach, describe, expect, it } from 'vitest'
import { createSimulator, type Simulator } from '../tools/simulator/simulator.mjs'
import { signalBars } from '../src/resolve.js'
import { Harness, sleep, waitFor } from './harness.js'

let sim: Simulator | undefined
let h: Harness | undefined
afterEach(async () => {
	await h?.destroy()
	await sim?.close()
	h = sim = undefined
})

async function connect(extra: Record<string, unknown> = {}): Promise<Harness> {
	sim = await createSimulator({ mode: 'arcadia', password: 'pw', activity: false })
	h = new Harness('cc')
	await h.init({ deviceType: 'arcadia', host: sim.host, ...extra }, { password: 'pw' })
	await waitFor(() => h!.status?.status === 'ok', 'connected')
	return h
}

const posts = (path: string) => sim!.requests.filter((r) => r.method === 'POST' && r.path === path)

describe('role detail page', () => {
	it('shows nothing until a role is selected', async () => {
		const h = await connect()
		expect(h.variables).toMatchObject({
			sel_role: '',
			sel_label: 'No role selected',
			sel_state: 'SELECT A ROLE',
			sel_battery_known: false,
			sel_key1_label: '',
			nav_seq: 0,
			nav_surface: '',
			nav_page: '',
		})
		expect(h.feedback('role_online', { targets: ['sel'], names: '' })).toBe(false)
	})

	it('asks Companion to open the detail page on the surface that was pressed, and to go back', async () => {
		const h = await connect({ detailPage: 7 })
		await h.action('select_role', { role: 1, open: true }, 'streamdeck:CL12345')
		await waitFor(() => h.variables.nav_seq === 1, 'nav request')
		expect(h.variables).toMatchObject({ nav_surface: 'streamdeck:CL12345', nav_page: '7', sel_role: 1 })

		await h.action('detail_back', {}, 'streamdeck:CL12345')
		await waitFor(() => h.variables.nav_seq === 2, 'back request')
		expect(h.variables.nav_page).toBe('back')

		// browsing on the detail page itself does not switch pages
		await h.action('select_role', { role: 2, open: false }, 'streamdeck:CL12345')
		await h.action('select_step', { direction: 'next' }, 'streamdeck:CL12345')
		await sleep(150)
		expect(h.variables.nav_seq).toBe(2)
	})

	it('only selects when no detail page is set, or the press has no surface', async () => {
		const h = await connect()
		await h.action('select_role', { role: 1, open: true }, 'streamdeck:CL12345')
		await waitFor(() => h.variables.sel_role === 1, 'selected')
		expect(h.variables.nav_seq).toBe(0)
		await h.update({ deviceType: 'arcadia', host: sim!.host, detailPage: 3 }, { password: 'pw' })
		await waitFor(() => h.status?.status === 'ok', 'reconnected')
		await h.action('select_role', { role: 1, open: true }, undefined) // e.g. run from a trigger
		await sleep(150)
		expect(h.variables.nav_seq).toBe(0)
	})

	it('fills the sel_* variables from the selected role and its device', async () => {
		const h = await connect()
		await h.action('select_role', { role: 1, open: false })
		await waitFor(() => h.variables.sel_role === 1, 'selected')
		expect(h.variables).toMatchObject({
			sel_label: 'Director',
			sel_state: 'ONLINE',
			sel_device: 'FSII-BP-2001',
			sel_type: 'FSII-BP',
			sel_firmware: '5.4.32.0',
			sel_battery: 82,
			sel_battery_text: '82%',
			sel_battery_type: 'Li-Ion',
			sel_time_left: '9:20',
			sel_rssi: 60,
			sel_signal: 4,
			sel_link: 70,
			sel_link_text: '70%',
			sel_fer: 0,
			sel_antenna_name: 'TCVR-1',
			sel_slot: 2,
			sel_index: '4/5', // Audio, Camera 1, Camera 2, Director, Stage Manager
			sel_key_count: 5,
			sel_key1_name: 'A',
			sel_key1_label: 'Production',
			sel_key1_state: 'listen',
			sel_key5_name: 'R',
			sel_key5_label: 'Reply',
			sel_key6_label: '',
		})
		expect(h.feedback('selected_key_exists', { key: 5 })).toBe(true)
		expect(h.feedback('selected_key_exists', { key: 6 })).toBe(false)
		sim!.setTalk(2001, 0, true)
		await waitFor(() => h.variables.sel_key1_state === 'talk' && h.variables.sel_state === 'TALK 1', 'talk')
		expect(h.feedback('role_talking', { targets: ['sel'], names: '', key: 0 })).toBe(true)

		// a FreeSpeak Edge pack: numbered keys, unassigned ones shown as such
		await h.action('select_role', { role: 2, open: false })
		await waitFor(() => h.variables.sel_role === 2, 'Camera 1')
		expect(h.variables).toMatchObject({ sel_key_count: 9, sel_key3_name: '3', sel_key3_label: '—', sel_key9_name: 'R' })
	})

	it('steps through the roles in use by name, wrapping around', async () => {
		const h = await connect()
		const seen: unknown[] = []
		for (let i = 0; i < 6; i++) {
			await h.action('select_step', { direction: 'next' })
			await sleep(80)
			seen.push(h.variables.sel_label)
		}
		expect(seen).toEqual(['Audio', 'Camera 1', 'Camera 2', 'Director', 'Stage Manager', 'Audio'])
		await h.action('select_step', { direction: 'prev' })
		await waitFor(() => h.variables.sel_label === 'Stage Manager', 'previous wraps')
	})

	it('calls and kills the mic of whoever holds the selected role', async () => {
		const h = await connect()
		await h.action('select_role', { role: 3, open: false })
		await h.action('rmk_role', { targets: ['sel'], names: '' })
		expect(posts('/api/1/devices/1/endpoints/2003/rmk')).toHaveLength(1)
		await h.action('call_role', { targets: ['sel'], names: '', mode: 'on', pulseMs: 2000, text: '' })
		await waitFor(() => h.variables.sel_calling === true, 'calling')
		await h.action('call_role', { targets: ['sel'], names: '', mode: 'off', pulseMs: 2000, text: '' })
		await waitFor(() => h.variables.sel_calling === false, 'call off')
	})

	it('assigns a picked role to the device and follows it', async () => {
		const h = await connect()
		await h.action('select_role', { role: 3, open: false }) // Camera 2 on Edge-2003
		await h.action('assign_step', { direction: 'next' })
		await waitFor(() => h.variables.sel_assign_changed === true, 'picked')
		// only roles with an Edge keyset: Camera 1, Camera 2 (by name)
		expect(h.variables.sel_assign).toBe('Camera 1')
		expect(h.feedback('assign_pending', {})).toBe(true)
		await h.action('assign_step', { direction: 'next' })
		await waitFor(() => h.variables.sel_assign === 'Camera 2', 'wraps back')
		expect(h.feedback('assign_pending', {})).toBe(false)

		// nothing changes until it is applied
		await h.action('assign_apply', {})
		expect(posts('/api/1/devices/1/endpoints/2003/changeassociation')).toHaveLength(0)

		await h.action('assign_step', { direction: 'prev' })
		await h.action('assign_apply', {})
		expect(posts('/api/1/devices/1/endpoints/2003/changeassociation').at(-1)?.body).toEqual({
			gid: 'EP-2003',
			association: { gid: 'RS-2' },
		})
		await waitFor(() => h.variables.sel_role === 2 && h.variables.sel_assign_changed === false, 'follows the device')
	})
})

describe('signal bars', () => {
	const t = { good: 30, poor: 20 }
	it('map DECT RSSI and dBm to 0-4 bars', () => {
		expect([undefined, 5, 19, 20, 29, 30, 39, 40, 60].map((v) => signalBars(v, t))).toEqual([0, 1, 1, 2, 2, 3, 3, 4, 4])
		expect([-50, -65, -75, -90].map((v) => signalBars(v, t))).toEqual([4, 3, 2, 1])
	})
})
