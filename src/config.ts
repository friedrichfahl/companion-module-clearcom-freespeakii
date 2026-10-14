import type { SomeCompanionConfigField } from '@companion-module/base'
import type { DeviceKind } from './types.js'

export type ModuleConfig = {
	deviceType: DeviceKind
	host: string
	username: string
	deviceId: number
	heartbeatMs: number
	lowBattery: number
	rmkAllEnabled: boolean
	invertGpi: boolean
}

export type ModuleSecrets = {
	password?: string
}

export const DEFAULT_CONFIG: ModuleConfig = {
	deviceType: 'arcadia',
	host: '',
	username: 'admin',
	deviceId: 1,
	heartbeatMs: 10000,
	lowBattery: 20,
	rmkAllEnabled: false,
	invertGpi: false,
}

/** Hostname or IPv4 address, optionally with a port (e.g. for a simulator on 127.0.0.1:8080). */
const HOST_REGEX = '/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:\\d{1,5})?$/'

const isArcadia = `$(options:deviceType) == 'arcadia'`

export function GetConfigFields(): SomeCompanionConfigField[] {
	return [
		{
			type: 'static-text',
			id: 'info',
			label: 'Information',
			width: 12,
			value:
				'Connects to the CCM web interface of an Arcadia Central Station or a FreeSpeak II base (HTTP + socket.io on port 80). ' +
				'Arcadia needs the CCM login; the FreeSpeak II base has no login, so keep it on an isolated production network.',
		},
		{
			type: 'dropdown',
			id: 'deviceType',
			label: 'Device',
			width: 4,
			default: DEFAULT_CONFIG.deviceType,
			choices: [
				{ id: 'arcadia', label: 'Arcadia Central Station' },
				{ id: 'fsii', label: 'FreeSpeak II base (FSII-BASE-II)' },
			],
		},
		{
			type: 'textinput',
			id: 'host',
			label: 'IP address or hostname',
			width: 5,
			regex: HOST_REGEX,
			default: DEFAULT_CONFIG.host,
		},
		{
			type: 'number',
			id: 'deviceId',
			label: 'Device ID',
			tooltip: 'Leave at 1 unless the device is part of a linked system',
			width: 3,
			min: 0,
			max: 255,
			default: DEFAULT_CONFIG.deviceId,
		},
		{
			type: 'textinput',
			id: 'username',
			label: 'CCM username',
			width: 4,
			default: DEFAULT_CONFIG.username,
			isVisibleExpression: isArcadia,
		},
		{
			type: 'secret-text',
			id: 'password',
			label: 'CCM password',
			tooltip: 'The admin password is shown in the Arcadia front panel menu',
			width: 8,
			isVisibleExpression: isArcadia,
		},
		{
			type: 'number',
			id: 'heartbeatMs',
			label: 'Heartbeat interval (ms)',
			width: 4,
			min: 2000,
			max: 60000,
			default: DEFAULT_CONFIG.heartbeatMs,
		},
		{
			type: 'number',
			id: 'lowBattery',
			label: 'Low battery threshold (%) for lists and presets',
			width: 4,
			min: 1,
			max: 99,
			default: DEFAULT_CONFIG.lowBattery,
		},
		{
			type: 'checkbox',
			id: 'rmkAllEnabled',
			label: 'Enable "Remote mic kill: all devices" action',
			tooltip: 'Off by default so a stray button press cannot mute the whole crew',
			width: 4,
			default: DEFAULT_CONFIG.rmkAllEnabled,
		},
		{
			type: 'checkbox',
			id: 'invertGpi',
			label: 'Invert GPI state',
			tooltip: 'Use this if GPI feedbacks show the opposite of the physical input',
			width: 4,
			default: DEFAULT_CONFIG.invertGpi,
		},
	]
}
