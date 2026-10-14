// Synthetic Arcadia Central Station dataset. Field names follow the device's published OpenAPI schema
// (Clear-Com API 1.0.1) and what the companion-module-clearcom-rest module reads from a real Arcadia.
// Values are invented: 5 partylines, 7 rolesets, a mix of FreeSpeak II, FreeSpeak Edge and HelixNet devices.

const conn = (id) => ({ res: `/api/1/connections/${id}`, type: 0 })
const role = (id) => ({ res: `/api/2/rolesets/${id}`, type: 3 })

export function arcadiaData() {
	const connections = [
		{ id: 1, label: 'Production', type: 'partyline', res: '/api/1/connections/1', helixnetEnabled: true },
		{ id: 2, label: 'Camera', type: 'partyline', res: '/api/1/connections/2', helixnetEnabled: true },
		{ id: 3, label: 'Stage', type: 'partyline', res: '/api/1/connections/3', helixnetEnabled: true },
		{ id: 4, label: 'Lighting', type: 'partyline', res: '/api/1/connections/4', helixnetEnabled: false },
		{ id: 5, label: 'Audio', type: 'partyline', res: '/api/1/connections/5', helixnetEnabled: true },
	]

	// keyset id -> [type, keys]. A key is a list of channel ids, { role } for a direct key to a role, or 'reply'.
	// Key counts follow the schema: FreeSpeak II 5 (A-D + reply), FreeSpeak Edge 9 (8 + reply), HelixNet 5.
	const R = 'reply'
	const keysetSpec = {
		101: ['FSII-BP', [[1], [2], [3], [4], R]],
		102: ['E-BP', [[2], [1], [], [], [], [], [], [], R]],
		103: ['E-BP', [[2], [1], [], [], [], [], [], [], R]],
		104: ['HBP-2X', [[3], [1], [], [], []]],
		105: ['FSII-BP', [[4], [1], [], [], R]],
		106: ['HMS-4X', [[5], [1], [3], [2], { role: 1 }]],
		107: ['FSII-BP', [[1], [], [], [], R]],
	}
	const keysets = Object.entries(keysetSpec).map(([id, [type, keys]]) => ({
		id: Number(id),
		type,
		description: '',
		settings: {
			keysets: keys.map((key, keysetIndex) => ({
				keysetIndex,
				entities: key === R ? [] : Array.isArray(key) ? key.map(conn) : [role(key.role)],
				...(type === 'FSII-BP' || type === 'E-BP' ? { isReplyKey: key === R, isCallKey: false } : {}),
				talkBtnMode: 'latching',
				activationState: 'talklisten',
			})),
		},
	}))

	const roleSpec = [
		[1, 'Director', 101],
		[2, 'Camera 1', 102],
		[3, 'Camera 2', 103],
		[4, 'Stage Manager', 104],
		[5, 'Lighting', 105],
		[6, 'Audio', 106],
		[7, 'Spare', 107],
	]
	const rolesets = roleSpec.map(([id, name, keysetId]) => ({
		id,
		name,
		label: name,
		gid: `RS-${id}`,
		res: `/api/2/rolesets/${id}`,
		sessions: {
			[`${keysetSpec[keysetId][0]}`]: {
				gid: `SE-${id}`,
				res: `/api/2/rolesets/${id}/sessions/${keysetSpec[keysetId][0]}/${keysetId}`,
				data: { id: keysetId, type: keysetSpec[keysetId][0], label: name, settings: { defaultRole: keysetId } },
			},
		},
	}))

	const keyStates = (count) =>
		Array.from({ length: count }, (_, keysetIndex) => ({ keysetIndex, currentState: 'listen', volume: 60 }))

	const pack = (id, type, label, roleId, extra = {}) => ({
		id,
		device_id: 1,
		type,
		label,
		gid: `EP-${id}`,
		res: `/api/1/devices/1/endpoints/${id}`,
		versionSW: '5.4.32.0',
		liveStatus: {
			status: 'online',
			association: { dpId: roleId, gid: `RS-${roleId}` },
			keyState: keyStates(type === 'FSE-BP' ? 9 : 5),
			...extra,
		},
	})
	const wireless = (battery, rssi, link) => ({
		batteryType: 'Li-Ion',
		batteryLevel: battery,
		rssi,
		linkQuality: link,
		frameErrorRate: 0,
		longevity: { hours: Math.floor((battery / 100) * 12), minutes: 20 },
		antennaIndex: 0,
		antennaSlot: 1,
	})

	const endpoints = [
		{
			id: 1000,
			device_id: 1,
			type: 'FSII-Antenna',
			label: 'TCVR-1',
			isGateway: true,
			res: '/api/1/devices/1/endpoints/1000',
			liveStatus: { status: 'online' },
		},
		{
			id: 1001,
			device_id: 1,
			type: 'FSII-Antenna',
			label: 'TCVR-2',
			isGateway: true,
			res: '/api/1/devices/1/endpoints/1001',
			liveStatus: { status: 'online' },
		},
		pack(2001, 'FSII-BP', 'FSII-BP-2001', 1, wireless(82, 60, 70)),
		pack(2002, 'FSE-BP', 'Edge-2002', 2, wireless(15, 40, 45)),
		pack(2003, 'FSE-BP', 'Edge-2003', 3, wireless(64, 55, 25)),
		pack(2004, 'HBP-2X', 'HBP-2004', 4),
		{
			id: 2005,
			device_id: 1,
			type: 'FSII-BP',
			label: 'FSII-BP-2005',
			gid: 'EP-2005',
			res: '/api/1/devices/1/endpoints/2005',
			liveStatus: {},
		},
		pack(2006, 'HMS-4X', 'HMS-2006', 6),
	]

	const port = (id, iface, label, desc, type, joined) => ({
		port_id: id,
		port_hwIndex: iface,
		port_label: label,
		port_desc: desc,
		port_config_type: type,
		audioInterfaceType_shortName: type,
		res: `/api/1/devices/1/interfaces/${iface}/ports/${id}`,
		gid: `PT-${id}`,
		device_id: 1,
		port_connections: Object.fromEntries(joined.map((c) => [String(c), { connectionState: 0 }])),
		port_settings: { inputGain: 0, outputGain: 0 },
		liveStatus: { online: true, vox: { status: false } },
	})
	const ports = [
		port(1, 1, '2W-A', 'Broadcast truck', '2W', [1]),
		port(2, 1, '2W-B', 'FOH', '2W', []),
		port(3, 2, '4W-1', 'Camera CCU', '4W', [2]),
		port(4, 3, '4WG-1', 'Stage GPIO', '4WG', []),
	]

	const gpio = [
		{ id: 1, device_id: 1, label: 'GPI 1', type: 0, liveStatus: { status: true } },
		{ id: 2, device_id: 1, label: 'GPI 2', type: 0, liveStatus: { status: true } },
		{ id: 3, device_id: 1, label: 'GPO 1', type: 1, liveStatus: { status: false } },
		{ id: 4, device_id: 1, label: 'GPO 2', type: 1, liveStatus: { status: false } },
	]

	const device = {
		device_id: 1,
		device_label: 'Arcadia-SIM',
		deviceType_name: 'NEP-ARCADIA',
		versionSW: '4.1.83.41',
		versionHW: '1.0',
		device_liveStatus: { fanStatus: [], temperatureSensors: [] },
	}

	return { connections, keysets, rolesets, endpoints, ports, gpio, device }
}
