/* eslint-disable n/no-unpublished-import */
import { describe, expect, it } from 'vitest'
import { decodeJwt, normalizeArcadiaRoles, type ArcadiaKeyset, type ArcadiaRoleset } from '../src/drivers/arcadia.js'
import { DeviceState } from '../src/state.js'
import {
	endpointForParticipant,
	gpioActive,
	isOnline,
	packRoleId,
	portForParticipant,
	roleKeysFor,
} from '../src/resolve.js'
import type { Endpoint } from '../src/types.js'

describe('Arcadia role normalization', () => {
	const rolesets: ArcadiaRoleset[] = [
		{
			id: 1,
			name: 'Director',
			gid: 'RS-1',
			sessions: {
				a: { data: { type: 'FSII-BP', settings: { defaultRole: 10 } } },
				b: { data: { type: 'HBP-2X', settings: { defaultRole: 11 } } },
			},
		},
		{ id: 2, name: 'Spare', label: 'Spare label', gid: 'RS-2' },
	]
	const keysets: ArcadiaKeyset[] = [
		{
			id: 10,
			type: 'FSII-BP',
			settings: {
				keysets: [
					{ keysetIndex: 0, entities: [{ res: '/api/1/connections/3', type: 0 }] },
					{ keysetIndex: 1, entities: [{ res: '/api/2/rolesets/2', type: 3 }] },
					{ keysetIndex: 4, entities: [], isReplyKey: true },
				],
			},
		},
		{
			id: 11,
			type: 'HBP-2X',
			settings: { keysets: [{ keysetIndex: 0, entities: [{ res: '/api/1/connections/5' }] }] },
		},
	]

	it('maps rolesets to roles with one key layout per keyset type', () => {
		const [director, spare] = normalizeArcadiaRoles(rolesets, keysets)
		expect(director).toMatchObject({ id: 1, label: 'Director', gid: 'RS-1', res: '/api/2/rolesets/1', type: '' })
		expect(director.keys['FSII-BP']).toEqual([
			{ index: 0, connections: [3], entities: ['/api/1/connections/3'], isReply: false },
			{ index: 1, connections: [], entities: ['/api/2/rolesets/2'], isReply: false },
			{ index: 4, connections: [], entities: [], isReply: true },
		])
		expect(director.keys['HBP-2X']).toEqual([
			{ index: 0, connections: [5], entities: ['/api/1/connections/5'], isReply: false },
		])
		expect(spare).toMatchObject({ label: 'Spare label', keys: {} })
	})

	it('picks the keyset for a device type, with aliases and a fallback', () => {
		const [director] = normalizeArcadiaRoles(rolesets, keysets)
		expect(roleKeysFor(director, 'HBP-2X')?.[0].connections).toEqual([5])
		expect(roleKeysFor({ ...director, keys: { 'E-BP': [] } }, 'FSE-BP')).toEqual([])
		expect(roleKeysFor(director, 'HMS-4X')?.[0].connections).toEqual([3])
	})
})

describe('Arcadia endpoint state', () => {
	const pack = (): Endpoint => ({
		id: 5,
		type: 'FSE-BP',
		label: 'Edge-5',
		gid: 'EP-5',
		res: '/api/1/devices/1/endpoints/5',
		liveStatus: { status: 'online', association: { dpId: 3 }, batteryLevel: 50 },
	})

	it('reads the role from the association', () => {
		expect(packRoleId(pack(), new DeviceState())).toBe(3)
	})

	it('treats an empty liveStatus as offline and keeps the association', () => {
		const s = new DeviceState()
		s.setEndpoints([pack()])
		s.applyEndpointUpdate({ endpointId: 5, path: 'liveStatus', value: {} })
		const e = s.endpoints.get(5)!
		expect(isOnline(e)).toBe(false)
		expect(packRoleId(e, s)).toBe(3)
		s.applyEndpointUpdate({ endpointId: 5, path: 'liveStatus', value: { status: 'online', batteryLevel: 40 } })
		expect(isOnline(e)).toBe(true)
		expect(e.liveStatus?.batteryLevel).toBe(40)
	})

	it('matches participants by resource path or gid', () => {
		const s = new DeviceState()
		s.setEndpoints([pack()])
		s.setPorts([{ port_id: 9, port_label: '2W', res: '/api/1/devices/1/interfaces/1/ports/9', gid: 'PT-9' }])
		expect(endpointForParticipant(s, { id: 'EP-5', gid: 'EP-5' })?.id).toBe(5)
		expect(endpointForParticipant(s, { id: 'x', res: '/api/1/devices/1/endpoints/5' })?.id).toBe(5)
		expect(endpointForParticipant(s, { id: 5, res: '/api/1/devices/1/endpoints/5' })?.id).toBe(5)
		expect(portForParticipant(s, { gid: 'PT-9' })?.port_id).toBe(9)
		expect(portForParticipant(s, { res: '/api/1/devices/1/interfaces/1/ports/9' })?.port_id).toBe(9)
	})

	it('applies GPI polarity', () => {
		const s = new DeviceState()
		const g = { id: 1, type: 0, liveStatus: { status: false } }
		expect(gpioActive(s, 'gpi', g)).toBe(false)
		s.gpiActiveLow = true
		expect(gpioActive(s, 'gpi', g)).toBe(true)
		expect(gpioActive(s, 'gpo', { id: 2, type: 1, liveStatus: { status: false } })).toBe(false)
		expect(gpioActive(s, 'gpi', { id: 3, type: 0 })).toBe(false)
	})

	it('merges Arcadia GpiUpdated path events', () => {
		const s = new DeviceState()
		s.setGpio('gpi', [{ id: 1, type: 0, liveStatus: { status: true } }])
		s.updateGpioPath('gpi', 1, 'liveStatus', { status: false })
		expect(s.gpis.get(1)?.liveStatus?.status).toBe(false)
		expect(s.updateGpioPath('gpi', 99, 'liveStatus', {}).live).toBe(false)
	})
})

describe('JWT', () => {
	it('decodes the payload of a token', () => {
		const payload = Buffer.from(JSON.stringify({ ver: 3, exp: 100 })).toString('base64url')
		expect(decodeJwt(`x.${payload}.y`)).toEqual({ ver: 3, exp: 100 })
		expect(decodeJwt('garbage')).toBeUndefined()
	})
})
